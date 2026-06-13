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
import { buildTournamentFeedback } from '../../lib/feedback-loop';

export const prerender = false;

const apiKey = typeof process !== 'undefined' && process.env.OPENAI_API_KEY
  ? process.env.OPENAI_API_KEY
  : (import.meta as any).env?.OPENAI_API_KEY;

const openai = new OpenAI({ apiKey });

const MODEL = 'gpt-4o';
const MAX_ATTEMPTS = 2;

const SYSTEM_PROMPT = `Eres un motor de consenso y síntesis textual para predicciones de fútbol internacional. NO eres una calculadora: toda la aritmética ya fue ejecutada de forma determinista por el backend y te llega resuelta.

Recibirás un JSON con los datos del partido, las estadísticas del ciclo mundialista de ambos equipos y el bloque calculos_deterministas con los resultados exactos de tres metodologías independientes más su combinación de mercado:
1. simulacion_poisson: lambdas de goles esperados ajustados por la calidad Elo del rival de turno (un promedio goleador contra rivales débiles vale menos contra un rival fuerte), probabilidades de victoria local/empate/victoria visitante derivadas de la matriz de Poisson completa, marcador más probable y su probabilidad.
2. diferencial_elo: Elo de cada equipo, bonus_localia (los anfitriones México, Estados Unidos y Canadá reciben +80 Elo cuando juegan como locales), elo_local_efectivo, diferencia y expectativa del local según E = 1/(1 + 10^(-diferencia/400)), variación de Elo de cada equipo durante el ciclo y probabilidades a tres bandas suavizadas: ningún resultado puede valer 0%, todos tienen un piso matemático.
3. momento_forma_xg: por equipo, puntuación de forma ponderada por recencia (0-100), tendencia, delta de finalización (goles reales menos xG a favor), delta defensivo (goles recibidos menos xG en contra), balance de xG y el equipo al que favorece la metodología. El campo xg_disponible indica si hay datos de xG: cuando es false, los deltas y balances de xG llegan como null.
4. mercado_1x2: la combinación determinista del mercado 1X2 (promedio de las probabilidades de Poisson y Elo), con ganador_argmax (el resultado de probabilidad combinada más alta) y marcador_argmax (el marcador de Poisson coherente con ese resultado).

Tienes PROHIBIDO recalcular, corregir o contradecir esos números. Tu única tarea es combinarlos en un consenso final y redactar la síntesis textual.

REGLA ARGMAX (máxima prioridad, no negociable):
- ganador_esperado DEBE ser el resultado cuya probabilidad final entera sea la más alta de las tres. Nunca declares un ganador cuyo entero no sea el máximo.
- Empate solo puede declararse si su entero es ESTRICTAMENTE mayor que victoria_local y que victoria_visitante. Ante igualdad entre un equipo y el empate, el ganador es el equipo.
- NUNCA fuerces un empate por paridad percibida entre los equipos: sin superioridad estricta del entero de empate, manda el equipo con mayor probabilidad.
- Usa mercado_1x2 como ancla del consenso: tus enteros finales deben mantenerse cerca de sus probabilidades combinadas y solo pueden desplazar el argmax respecto a mercado_1x2.ganador_argmax si un Diagnóstico acumulado del torneo lo justifica explícitamente en el analisis.

Reglas de salida obligatorias:
- victoria_local, empate y victoria_visitante deben ser números ENTEROS que sumen EXACTAMENTE 100, obtenidos ponderando las probabilidades ya calculadas, sin inventar valores alejados de ellas.
- Si xg_disponible es false, el consenso debe basarse exclusivamente en simulacion_poisson, diferencial_elo y mercado_1x2, usando la puntuación de forma y la tendencia solo como matiz cualitativo del análisis.
- ganador_esperado debe ser el nombre exacto de uno de los dos equipos o la palabra Empate.
- nivel_certeza con xg_disponible true: ALTA si las tres metodologías favorecen el mismo resultado, MEDIA si dos coinciden y una difiere, BAJA si hay divergencia significativa. Con xg_disponible false: ALTA si Poisson y Elo coinciden claramente en el mismo ganador, MEDIA si coinciden con margen estrecho, BAJA si divergen.
- analisis y desglose_consenso deben citar los números recibidos sin alterarlos; si xg_disponible es false, la entrada momento_forma_xg debe limitarse a la forma reciente y aclarar que no hay datos de xG.
- Si data_source es simulated, no presentes los valores como hechos históricos verificados.

Responde estrictamente con un objeto JSON válido con esta estructura exacta, sin texto adicional ni markdown:
{
  "probabilidades": {
    "victoria_local": "number",
    "empate": "number",
    "victoria_visitante": "number"
  },
  "ganador_esperado": "string",
  "nivel_certeza": "ALTA" | "MEDIA" | "BAJA",
  "analisis": "<síntesis del consenso citando los números>",
  "desglose_consenso": {
    "simulacion_poisson": "<conclusión textual basada en sus números>",
    "diferencial_elo": "<conclusión textual basada en sus números>",
    "momento_forma_xg": "<conclusión textual basada en sus números>"
  }
}`;

function composeSystemPrompt(tournamentFeedback: string | null): string {
  if (!tournamentFeedback) {
    return SYSTEM_PROMPT;
  }

  return `${SYSTEM_PROMPT}

[CONTEXTO DEL TORNEO Y AUTO-CORRECCIÓN]
Información verificada de partidos ya finalizados en este Mundial que involucran a los equipos de este encuentro:
${tournamentFeedback}

Instrucciones de uso del contexto (obligatorias, subordinadas a las reglas anteriores):
- Las entradas marcadas como "Diagnóstico acumulado" provienen de una muestra suficiente (3 o más partidos finalizados del equipo): aplícalas ajustando tu ponderación cualitativa entre metodologías y el nivel_certeza, y cita en el analisis qué diagnóstico aplicaste y cómo modificó tu ponderación.
- Las entradas marcadas como "Contexto informativo" provienen de una muestra insuficiente (1 o 2 partidos): tienes PROHIBIDO ajustar pesos, probabilidades o nivel_certeza por ellas; menciónalas a lo sumo como matiz descriptivo del análisis.
- La REGLA ARGMAX y las reglas de salida obligatorias conservan prioridad absoluta sobre esta sección.`;
}

function parseStructure(value: unknown): Prediction | null {
  if (typeof value !== 'object' || value === null) {
    return null;
  }

  const candidate = value as Record<string, unknown>;
  const probabilities = candidate.probabilidades as Record<string, unknown> | undefined;
  const consensus = candidate.desglose_consenso as Record<string, unknown> | undefined;

  const isValid =
    typeof probabilities?.victoria_local === 'number' &&
    typeof probabilities?.empate === 'number' &&
    typeof probabilities?.victoria_visitante === 'number' &&
    typeof candidate.ganador_esperado === 'string' &&
    ['ALTA', 'MEDIA', 'BAJA'].includes(candidate.nivel_certeza as string) &&
    typeof candidate.analisis === 'string' &&
    typeof consensus?.simulacion_poisson === 'string' &&
    typeof consensus?.diferencial_elo === 'string' &&
    typeof consensus?.momento_forma_xg === 'string';

  return isValid ? (value as Prediction) : null;
}

function validateRules(prediction: Prediction, homeTeam: string, awayTeam: string): string | null {
  const { victoria_local, empate, victoria_visitante } = prediction.probabilidades;
  const probabilities = [victoria_local, empate, victoria_visitante];

  if (probabilities.some((p) => !Number.isInteger(p) || p < 0 || p > 100)) {
    return 'Las probabilidades deben ser enteros entre 0 y 100.';
  }

  if (victoria_local + empate + victoria_visitante !== 100) {
    return 'Las probabilidades deben sumar exactamente 100.';
  }

  if (![homeTeam, awayTeam, 'Empate'].includes(prediction.ganador_esperado)) {
    return 'El ganador esperado debe ser uno de los dos equipos o Empate.';
  }

  if (
    prediction.ganador_esperado === 'Empate' &&
    (empate <= victoria_local || empate <= victoria_visitante)
  ) {
    return 'El empate solo puede declararse si su probabilidad es estrictamente mayor que la de ambos equipos.';
  }

  const winnerProbability =
    prediction.ganador_esperado === homeTeam
      ? victoria_local
      : prediction.ganador_esperado === awayTeam
        ? victoria_visitante
        : empate;

  if (winnerProbability !== Math.max(...probabilities)) {
    return 'El ganador esperado no corresponde a la probabilidad más alta.';
  }

  return null;
}

export async function requestConsensus(
  matchContext: Record<string, unknown>,
  homeTeam: string,
  awayTeam: string,
  tournamentFeedback: string | null = null
): Promise<{ prediction: Prediction | null; failure: string | null }> {
  const report = matchContext.calculos_deterministas as DeterministicReport;
  const systemPrompt = composeSystemPrompt(tournamentFeedback);
  let failure: string | null = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const feedback = failure
      ? `\nTu respuesta anterior fue rechazada por la validación estricta: ${failure} Corrige exactamente ese problema manteniendo el resto de reglas.`
      : '';

    const completion = await openai.chat.completions.create({
      model: MODEL,
      temperature: 0,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: systemPrompt },
        {
          role: 'user',
          content: `Genera el consenso y la síntesis en formato JSON para este partido:\n${JSON.stringify(matchContext)}${feedback}`
        }
      ]
    });

    const content = completion.choices[0]?.message?.content;

    if (!content) {
      failure = 'La respuesta del modelo llegó sin contenido.';
      continue;
    }

    let parsed: unknown;

    try {
      parsed = JSON.parse(content);
    } catch {
      failure = 'La respuesta del modelo no es JSON válido.';
      continue;
    }

    const prediction = parseStructure(parsed);

    if (!prediction) {
      failure = 'La respuesta no cumple la estructura exacta requerida.';
      continue;
    }

    failure = validateRules(prediction, homeTeam, awayTeam);

    if (!failure) {
      const mejores = report.simulacion_poisson.mejores_marcadores;

      if (prediction.ganador_esperado === homeTeam) {
        prediction.marcador_exacto = mejores.victoria_local;
      } else if (prediction.ganador_esperado === awayTeam) {
        prediction.marcador_exacto = mejores.victoria_visitante;
      } else {
        prediction.marcador_exacto = mejores.empate;
      }

      return { prediction, failure: null };
    }
  }

  return { prediction: null, failure };
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
  const homeStats = typedStats.find((row) => row.team_name === match.home_team);
  const awayStats = typedStats.find((row) => row.team_name === match.away_team);

  if (!homeStats || !awayStats) {
    return jsonResponse({ error: 'Estadísticas de los equipos no disponibles.' }, 500);
  }

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

  const tournamentFeedback = await buildTournamentFeedback(
    match.home_team,
    match.away_team
  ).catch(() => null);

  try {
    const { prediction, failure } = await requestConsensus(
      matchContext,
      match.home_team,
      match.away_team,
      tournamentFeedback
    );

    if (!prediction) {
      return jsonResponse(
        { error: `La predicción no superó la validación estricta: ${failure}` },
        502
      );
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
    return jsonResponse({ error: 'Error al generar la predicción con OpenAI.' }, 502);
  }
};
