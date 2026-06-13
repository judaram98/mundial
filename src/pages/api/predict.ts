import type { APIRoute } from 'astro';
import OpenAI from 'openai';
import { supabase } from '../../lib/supabase';
import {
  buildDeterministicReport,
  type DeterministicReport,
  type TeamStats
} from '../../lib/prediction-engine';
import type { Prediction, PredictionCache } from '../../lib/prediction-types';
import { isPlaceholderMatch } from '../../lib/placeholders';
import { applyCalibration, buildTournamentContext } from '../../lib/feedback-loop';

export const prerender = false;

const apiKey = typeof process !== 'undefined' && process.env.OPENAI_API_KEY
  ? process.env.OPENAI_API_KEY
  : (import.meta as any).env?.OPENAI_API_KEY;

const openai = new OpenAI({ apiKey });

const MODEL = 'gpt-4o';
const MAX_ATTEMPTS = 2;

const SYSTEM_PROMPT = `Eres el redactor técnico de un motor determinista de predicciones de fútbol internacional. TODOS los números ya están decididos por el backend: probabilidades finales, ganador esperado, marcador exacto y nivel de certeza llegan resueltos en el bloque consenso_final y NO pueden cambiarse.

Recibirás un JSON con los datos del partido, las estadísticas del ciclo mundialista de ambos equipos y el bloque calculos_deterministas:
1. simulacion_poisson: lambdas de goles esperados ajustados por la calidad Elo del rival, con corrección Dixon-Coles para marcadores bajos (rho_dixon_coles), probabilidades a tres bandas, marcador más probable y mejores marcadores por desenlace.
2. diferencial_elo: Elo de cada equipo, bonus_localia del anfitrión calibrado por backtesting, elo_local_efectivo, diferencia, expectativa del local según E = 1/(1 + 10^(-diferencia/400)), variación de Elo durante el ciclo y probabilidades suavizadas (ningún resultado baja del 5%).
3. momento_forma_xg: puntuación de forma ponderada por recencia (0-100), tendencia, deltas de xG cuando existen (xg_disponible) y el equipo al que favorece.
4. mercado_1x2: la mezcla ponderada de Poisson y Elo (peso_poisson calibrado por backtesting sobre cientos de partidos reales) con su argmax.
5. consenso_final: las probabilidades enteras DEFINITIVAS, el ganador, el marcador, el nivel_certeza (derivado de cuántas metodologías están alineadas: metodologias_alineadas) — este bloque es la verdad final.

Tu única tarea es redactar dos campos de texto en español citando fielmente esos números:
- analisis: síntesis del consenso (4 a 7 frases) que explique por qué consenso_final favorece ese desenlace, citando probabilidades, lambdas, diferencia de Elo, expectativa y forma. Si hay lecciones del torneo en el contexto, explica cómo las correcciones ya aplicadas moldearon los números. Si xg_disponible es false, aclara que no hay datos de xG y que la forma es solo matiz cualitativo. Si data_source es simulated, no presentes los valores como hechos históricos verificados.
- desglose_consenso: una conclusión textual por metodología (simulacion_poisson, diferencial_elo, momento_forma_xg) basada exclusivamente en sus propios números.

Tienes PROHIBIDO inventar, recalcular o contradecir cualquier número recibido.

Responde estrictamente con un objeto JSON válido con esta estructura exacta, sin texto adicional ni markdown:
{
  "analisis": "<síntesis del consenso citando los números>",
  "desglose_consenso": {
    "simulacion_poisson": "<conclusión textual basada en sus números>",
    "diferencial_elo": "<conclusión textual basada en sus números>",
    "momento_forma_xg": "<conclusión textual basada en sus números>"
  }
}`;

interface ConsensusTexts {
  analisis: string;
  desglose_consenso: {
    simulacion_poisson: string;
    diferencial_elo: string;
    momento_forma_xg: string;
  };
}

function composeSystemPrompt(tournamentNarrative: string | null): string {
  if (!tournamentNarrative) {
    return SYSTEM_PROMPT;
  }

  return `${SYSTEM_PROMPT}

[CONTEXTO DEL TORNEO]
Información verificada de partidos ya finalizados en este Mundial que involucran a los equipos de este encuentro:
${tournamentNarrative}

Las correcciones numéricas descritas ya fueron aplicadas por el motor determinista antes de calcular los números que recibes; tu redacción debe citarlas como contexto sin alterar ningún valor.`;
}

function parseTexts(value: unknown): ConsensusTexts | null {
  if (typeof value !== 'object' || value === null) {
    return null;
  }

  const candidate = value as Record<string, unknown>;
  const consensus = candidate.desglose_consenso as Record<string, unknown> | undefined;

  const isValid =
    typeof candidate.analisis === 'string' &&
    candidate.analisis.trim().length > 0 &&
    typeof consensus?.simulacion_poisson === 'string' &&
    consensus.simulacion_poisson.trim().length > 0 &&
    typeof consensus?.diferencial_elo === 'string' &&
    consensus.diferencial_elo.trim().length > 0 &&
    typeof consensus?.momento_forma_xg === 'string' &&
    consensus.momento_forma_xg.trim().length > 0;

  return isValid ? (value as unknown as ConsensusTexts) : null;
}

function buildFallbackTexts(
  report: DeterministicReport,
  homeTeam: string,
  awayTeam: string
): ConsensusTexts {
  const consenso = report.consenso_final;
  const poisson = report.simulacion_poisson;
  const elo = report.diferencial_elo;
  const forma = report.momento_forma_xg;
  const { victoria_local, empate, victoria_visitante } = consenso.probabilidades;

  return {
    analisis: `El consenso determinista asigna ${victoria_local}% a ${homeTeam}, ${empate}% al empate y ${victoria_visitante}% a ${awayTeam}, con ${consenso.ganador} como desenlace más probable y marcador estimado ${consenso.marcador}. ${consenso.metodologias_alineadas} de 3 metodologías están alineadas con ese desenlace, lo que define una certeza ${consenso.nivel_certeza}.`,
    desglose_consenso: {
      simulacion_poisson: `Con lambdas ajustados por rival de ${poisson.lambda_local} y ${poisson.lambda_visitante}, la matriz de Poisson reparte ${poisson.probabilidades.victoria_local}% / ${poisson.probabilidades.empate}% / ${poisson.probabilidades.victoria_visitante}% y señala ${poisson.marcador_mas_probable} como marcador más probable (${poisson.probabilidad_marcador}%).`,
      diferencial_elo: `La diferencia de Elo efectiva es ${elo.diferencia} (expectativa del local ${elo.expectativa_local}), lo que reparte ${elo.probabilidades.victoria_local}% / ${elo.probabilidades.empate}% / ${elo.probabilidades.victoria_visitante}%.`,
      momento_forma_xg: forma.xg_disponible
        ? `La forma reciente puntúa ${forma.local.puntuacion_forma} contra ${forma.visitante.puntuacion_forma} y el balance de xG favorece a ${forma.favorece}.`
        : `Sin datos de xG disponibles, la forma reciente puntúa ${forma.local.puntuacion_forma} contra ${forma.visitante.puntuacion_forma} (favorece: ${forma.favorece}) y se usa solo como matiz cualitativo.`
    }
  };
}

async function requestSynthesis(
  matchContext: Record<string, unknown>,
  tournamentNarrative: string | null
): Promise<ConsensusTexts | null> {
  const systemPrompt = composeSystemPrompt(tournamentNarrative);
  let failure: string | null = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const feedback = failure
      ? `\nTu respuesta anterior fue rechazada: ${failure} Corrige exactamente ese problema.`
      : '';

    let content: string | null | undefined;

    try {
      const completion = await openai.chat.completions.create({
        model: MODEL,
        temperature: 0,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: systemPrompt },
          {
            role: 'user',
            content: `Redacta la síntesis en formato JSON para este partido:\n${JSON.stringify(matchContext)}${feedback}`
          }
        ]
      });

      content = completion.choices[0]?.message?.content;
    } catch {
      failure = 'La llamada al modelo falló.';
      continue;
    }

    if (!content) {
      failure = 'La respuesta del modelo llegó sin contenido.';
      continue;
    }

    try {
      const texts = parseTexts(JSON.parse(content));

      if (texts) {
        return texts;
      }

      failure = 'La respuesta no cumple la estructura exacta requerida.';
    } catch {
      failure = 'La respuesta del modelo no es JSON válido.';
    }
  }

  return null;
}

export async function requestConsensus(
  matchContext: Record<string, unknown>,
  homeTeam: string,
  awayTeam: string,
  tournamentNarrative: string | null = null
): Promise<{ prediction: Prediction | null; failure: string | null }> {
  const report = matchContext.calculos_deterministas as DeterministicReport;
  const consenso = report.consenso_final;

  const texts =
    (await requestSynthesis(matchContext, tournamentNarrative)) ??
    buildFallbackTexts(report, homeTeam, awayTeam);

  return {
    prediction: {
      probabilidades: { ...consenso.probabilidades },
      marcador_exacto: consenso.marcador,
      ganador_esperado: consenso.ganador,
      nivel_certeza: consenso.nivel_certeza,
      analisis: texts.analisis,
      desglose_consenso: { ...texts.desglose_consenso }
    },
    failure: null
  };
}

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

function buildSuccessBody(
  match: { id: number; home_team: string; away_team: string; date: string },
  cache: PredictionCache,
  cached: boolean
): Record<string, unknown> {
  return {
    match: {
      id: match.id,
      home_team: match.home_team,
      away_team: match.away_team,
      date: match.date
    },
    motor_determinista: cache.motor_determinista,
    prediction: cache.prediction,
    generado_en: cache.generado_en,
    cached
  };
}

export const POST: APIRoute = async ({ request }) => {
  let matchId: number;

  try {
    const body = await request.json();
    matchId = Number(body?.matchId);
  } catch {
    return jsonResponse({ error: 'Cuerpo de la petición inválido.' }, 400);
  }

  if (!Number.isInteger(matchId) || matchId <= 0) {
    return jsonResponse({ error: 'El campo matchId debe ser un entero positivo.' }, 400);
  }

  const { data: match, error: matchError } = await supabase
    .from('matches')
    .select('*')
    .eq('id', matchId)
    .single();

  if (matchError || !match) {
    return jsonResponse({ error: 'Partido no encontrado.' }, 404);
  }

  if (match.status === 'finished') {
    return jsonResponse({ error: 'El partido ya finalizó, no admite predicción.' }, 409);
  }

  if (match.status === 'awaiting_teams' || isPlaceholderMatch(match.home_team, match.away_team)) {
    return jsonResponse(
      { error: 'Las selecciones de esta llave aún no están definidas; la predicción se habilitará cuando se resuelva la fase previa.' },
      409
    );
  }

  const cachedPrediction = match.prediction_cache as PredictionCache | null;

  if (cachedPrediction?.prediction && cachedPrediction?.motor_determinista) {
    return jsonResponse(buildSuccessBody(match, cachedPrediction, true), 200);
  }

  const { data: stats, error: statsError } = await supabase
    .from('team_stats')
    .select('*')
    .in('team_name', [match.home_team, match.away_team]);

  if (statsError || !stats || stats.length !== 2) {
    return jsonResponse({ error: 'Estadísticas de los equipos no disponibles.' }, 500);
  }

  const typedStats = stats as TeamStats[];
  const rawHomeStats = typedStats.find((row) => row.team_name === match.home_team);
  const rawAwayStats = typedStats.find((row) => row.team_name === match.away_team);

  if (!rawHomeStats || !rawAwayStats) {
    return jsonResponse({ error: 'Estadísticas de los equipos no disponibles.' }, 500);
  }

  const tournamentContext = await buildTournamentContext(
    match.home_team,
    match.away_team
  ).catch(() => ({ narrative: null, adjustments: new Map() }));

  const homeStats = applyCalibration(rawHomeStats, tournamentContext.adjustments.get(match.home_team));
  const awayStats = applyCalibration(rawAwayStats, tournamentContext.adjustments.get(match.away_team));

  const deterministicReport: DeterministicReport = buildDeterministicReport(homeStats, awayStats);

  const matchContext = {
    partido: {
      fecha: match.date,
      equipo_local: match.home_team,
      equipo_visitante: match.away_team
    },
    ciclo_estadistico: {
      inicio: homeStats.stats_period_start,
      fin: homeStats.stats_period_end,
      data_source: homeStats.data_source
    },
    estadisticas_local: homeStats,
    estadisticas_visitante: awayStats,
    calculos_deterministas: deterministicReport
  };

  try {
    const { prediction } = await requestConsensus(
      matchContext,
      match.home_team,
      match.away_team,
      tournamentContext.narrative
    );

    if (!prediction) {
      return jsonResponse({ error: 'No fue posible generar la predicción.' }, 502);
    }

    const cacheEntry: PredictionCache = {
      prediction,
      motor_determinista: deterministicReport,
      generado_en: new Date().toISOString()
    };

    await supabase
      .from('matches')
      .update({ prediction_cache: cacheEntry })
      .eq('id', match.id);

    return jsonResponse(buildSuccessBody(match, cacheEntry, false), 200);
  } catch {
    return jsonResponse({ error: 'Error al generar la predicción.' }, 502);
  }
};
