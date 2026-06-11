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

export const prerender = false;

const apiKey = typeof process !== 'undefined' && process.env.OPENAI_API_KEY
  ? process.env.OPENAI_API_KEY
  : (import.meta as any).env?.OPENAI_API_KEY;

const openai = new OpenAI({ apiKey });

const MODEL = 'gpt-4o';
const MAX_ATTEMPTS = 2;
const SCORE_PATTERN = /^\d{1,2}-\d{1,2}$/;

const SYSTEM_PROMPT = `Eres un motor de consenso y síntesis textual para predicciones de fútbol internacional. NO eres una calculadora: toda la aritmética ya fue ejecutada de forma determinista por el backend y te llega resuelta.

Recibirás un JSON con los datos del partido, las estadísticas del ciclo mundialista de ambos equipos y el bloque calculos_deterministas con los resultados exactos de tres metodologías independientes más una regla de arbitraje del empate:
1. simulacion_poisson: lambdas de goles esperados, probabilidades de victoria local/empate/victoria visitante derivadas de la matriz de Poisson completa, marcador más probable y su probabilidad.
2. diferencial_elo: diferencia de Elo, expectativa del local según E = 1/(1 + 10^(-diferencia/400)), variación de Elo de cada equipo durante el ciclo, el indicador paridad_tecnica y probabilidades a tres bandas derivadas.
3. momento_forma_xg: por equipo, puntuación de forma ponderada por recencia (0-100), tendencia, delta de finalización (goles reales menos xG a favor), delta defensivo (goles recibidos menos xG en contra), balance de xG y el equipo al que favorece la metodología. El campo xg_disponible indica si hay datos de xG: cuando es false, los deltas y balances de xG llegan como null.
4. regla_empate: el árbitro determinista del empate. Indica si los equipos están en paridad_tecnica (diferencia de Elo absoluta menor que umbral_paridad_elo), la probabilidad_empate_poisson, el umbral_probabilidad_empate y el veredicto final empate_obligatorio.

Tienes PROHIBIDO recalcular, corregir o contradecir esos números. Tu única tarea es combinarlos en un consenso final y redactar la síntesis textual.

REGLA DE EMPATE OBLIGATORIO (máxima prioridad, no negociable):
- Si regla_empate.empate_obligatorio es true, ganador_esperado DEBE ser exactamente la palabra Empate y la probabilidad de empate DEBE ser estrictamente la más alta de las tres. Cualquier otra salida será rechazada por el validador.
- Para lograrlo, redistribuye los enteros con el mínimo desvío posible respecto a las metodologías hasta que el empate supere al lado más alto (por ejemplo, si Poisson da 37/27/36, una salida válida es 33/35/32).
- Una ventaja mínima de Elo NUNCA equivale a una victoria: dentro de la banda de paridad técnica los equipos se tratan como iguales y manda el cuadrante de empates de Poisson.
- Si regla_empate.empate_obligatorio es false, NO fuerces el empate: aplica el consenso normal de las metodologías.
- Cuando declares Empate por esta regla, el analisis debe explicar la paridad técnica citando la diferencia de Elo y la probabilidad de empate de Poisson recibidas.

Reglas de salida obligatorias:
- victoria_local, empate y victoria_visitante deben ser números ENTEROS que sumen EXACTAMENTE 100, obtenidos ponderando las probabilidades ya calculadas, sin inventar valores alejados de ellas.
- Si xg_disponible es false, el consenso debe basarse exclusivamente en simulacion_poisson y diferencial_elo, usando la puntuación de forma y la tendencia solo como matiz cualitativo del análisis.
- ganador_esperado debe ser el nombre exacto de uno de los dos equipos o la palabra Empate, y debe corresponder al resultado con la probabilidad final más alta.
- nivel_certeza con xg_disponible true: ALTA si las tres metodologías favorecen el mismo resultado, MEDIA si dos coinciden y una difiere, BAJA si hay divergencia significativa. Con xg_disponible false: ALTA si Poisson y Elo coinciden claramente en el mismo ganador, MEDIA si coinciden con margen estrecho, BAJA si divergen. Cuando el empate sea obligatorio por regla_empate, el nivel_certeza se evalúa sobre qué tan claro es el escenario de paridad, no sobre un ganador.
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

function validateRules(
  prediction: Prediction,
  homeTeam: string,
  awayTeam: string,
  drawMandatory: boolean
): string | null {
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

  if (drawMandatory && prediction.ganador_esperado !== 'Empate') {
    return 'regla_empate.empate_obligatorio es true: el ganador esperado debe ser Empate y la probabilidad de empate debe ser la más alta.';
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

function enforceMandatoryDraw(prediction: Prediction): Prediction {
  let { victoria_local, empate, victoria_visitante } = prediction.probabilidades;

  while (empate <= Math.max(victoria_local, victoria_visitante)) {
    if (victoria_local >= victoria_visitante) {
      victoria_local -= 1;
    } else {
      victoria_visitante -= 1;
    }
    empate += 1;
  }

  return {
    ...prediction,
    ganador_esperado: 'Empate',
    probabilidades: { victoria_local, empate, victoria_visitante }
  };
}

export async function requestConsensus(
  matchContext: Record<string, unknown>,
  homeTeam: string,
  awayTeam: string
): Promise<{ prediction: Prediction | null; failure: string | null }> {
  const report = matchContext.calculos_deterministas as DeterministicReport;
  const drawMandatory = Boolean(report?.regla_empate?.empate_obligatorio);
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
        { role: 'system', content: SYSTEM_PROMPT },
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

    const parsedPrediction = parseStructure(parsed);

    if (!parsedPrediction) {
      failure = 'La respuesta no cumple la estructura exacta requerida.';
      continue;
    }

    const prediction = drawMandatory ? enforceMandatoryDraw(parsedPrediction) : parsedPrediction;

    failure = validateRules(prediction, homeTeam, awayTeam, drawMandatory);

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

  try {
    const { prediction, failure } = await requestConsensus(
      matchContext,
      match.home_team,
      match.away_team
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
