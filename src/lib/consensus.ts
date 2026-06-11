import OpenAI from 'openai';
import {
  buildDeterministicReport,
  type DeterministicReport,
  type TeamStats
} from './prediction-engine';
import type { Prediction, PredictionCache } from './prediction-types';

export interface MatchFacts {
  id: number;
  date: string;
  home_team: string;
  away_team: string;
}

export interface ConsensusResult {
  cache: PredictionCache | null;
  failure: string | null;
}

const MODEL = 'gpt-4o';
const MAX_ATTEMPTS = 2;
const SCORE_PATTERN = /^\d{1,2}-\d{1,2}$/;

const SYSTEM_PROMPT = `Eres un motor de consenso y síntesis textual para predicciones de fútbol internacional. NO eres una calculadora: toda la aritmética ya fue ejecutada de forma determinista por el backend y te llega resuelta.

Recibirás un JSON con los datos del partido, las estadísticas del ciclo mundialista de ambos equipos y el bloque calculos_deterministas con los resultados exactos de tres metodologías independientes:
1. simulacion_poisson: lambdas de goles esperados, probabilidades de victoria local/empate/victoria visitante derivadas de la matriz de Poisson completa, marcador más probable y su probabilidad.
2. diferencial_elo: diferencia de Elo, expectativa del local según E = 1/(1 + 10^(-diferencia/400)), variación de Elo de cada equipo durante el ciclo y probabilidades a tres bandas derivadas.
3. momento_forma_xg: por equipo, puntuación de forma ponderada por recencia (0-100), tendencia, delta de finalización (goles reales menos xG a favor), delta defensivo (goles recibidos menos xG en contra), balance de xG y el equipo al que favorece la metodología. El campo xg_disponible indica si hay datos de xG: cuando es false, los deltas y balances de xG llegan como null.

Tienes PROHIBIDO recalcular, corregir o contradecir esos números. Tu única tarea es combinarlos en un consenso final y redactar la síntesis textual.

Reglas de salida obligatorias:
- victoria_local, empate y victoria_visitante deben ser números ENTEROS que sumen EXACTAMENTE 100, obtenidos ponderando las probabilidades ya calculadas, sin inventar valores alejados de ellas.
- Si xg_disponible es false, el consenso debe basarse exclusivamente en simulacion_poisson y diferencial_elo, usando la puntuación de forma y la tendencia solo como matiz cualitativo del análisis.
- ganador_esperado debe ser el nombre exacto de uno de los dos equipos o la palabra Empate, y debe corresponder al resultado con la probabilidad final más alta.
- marcador_exacto debe tener el formato "G-G" (goles local-goles visitante) y ser coherente con ganador_esperado; parte del marcador más probable de Poisson salvo que el consenso justifique ajustarlo.
- nivel_certeza con xg_disponible true: ALTA si las tres metodologías favorecen el mismo resultado, MEDIA si dos coinciden y una difiere, BAJA si hay divergencia significativa. Con xg_disponible false: ALTA si Poisson y Elo coinciden claramente en el mismo ganador, MEDIA si coinciden con margen estrecho, BAJA si divergen.
- analisis y desglose_consenso deben citar los números recibidos (probabilidades, lambdas, expectativa Elo, puntuaciones de forma) sin alterarlos; si xg_disponible es false, la entrada momento_forma_xg debe limitarse a la forma reciente y aclarar que no hay datos de xG.
- Si data_source es simulated, no presentes los valores como hechos históricos verificados.

Responde estrictamente con un objeto JSON válido con esta estructura exacta, sin texto adicional ni markdown:
{
  "probabilidades": {
    "victoria_local": <entero>,
    "empate": <entero>,
    "victoria_visitante": <entero>
  },
  "marcador_exacto": "<goles_local>-<goles_visitante>",
  "ganador_esperado": "<nombre del equipo o Empate>",
  "nivel_certeza": "ALTA" | "MEDIA" | "BAJA",
  "analisis": "<síntesis del consenso citando los números>",
  "desglose_consenso": {
    "simulacion_poisson": "<conclusión textual basada en sus números>",
    "diferencial_elo": "<conclusión textual basada en sus números>",
    "momento_forma_xg": "<conclusión textual basada en sus números>"
  }
}`;

let client: OpenAI | null = null;

function getClient(): OpenAI {
  if (client) {
    return client;
  }

  const apiKey = import.meta.env?.OPENAI_API_KEY ?? process.env.OPENAI_API_KEY;

  if (!apiKey) {
    throw new Error('Falta la variable de entorno OPENAI_API_KEY.');
  }

  client = new OpenAI({ apiKey });
  return client;
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
    typeof candidate.marcador_exacto === 'string' &&
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

  if (!SCORE_PATTERN.test(prediction.marcador_exacto)) {
    return 'El marcador exacto debe cumplir el formato G-G.';
  }

  if (![homeTeam, awayTeam, 'Empate'].includes(prediction.ganador_esperado)) {
    return 'El ganador esperado debe ser uno de los dos equipos o Empate.';
  }

  const [homeGoals, awayGoals] = prediction.marcador_exacto.split('-').map(Number);
  const winnerFromScore =
    homeGoals > awayGoals ? homeTeam : homeGoals < awayGoals ? awayTeam : 'Empate';

  if (winnerFromScore !== prediction.ganador_esperado) {
    return 'El marcador exacto no es coherente con el ganador esperado.';
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

function buildMatchContext(
  match: MatchFacts,
  homeStats: TeamStats,
  awayStats: TeamStats,
  report: DeterministicReport
): Record<string, unknown> {
  return {
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
    calculos_deterministas: report
  };
}

export async function generateConsensusPrediction(
  match: MatchFacts,
  homeStats: TeamStats,
  awayStats: TeamStats
): Promise<ConsensusResult> {
  const report = buildDeterministicReport(homeStats, awayStats);
  const matchContext = buildMatchContext(match, homeStats, awayStats, report);
  let failure: string | null = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const feedback = failure
      ? `\nTu respuesta anterior fue rechazada por la validación estricta: ${failure} Corrige exactamente ese problema manteniendo el resto de reglas.`
      : '';

    const completion = await getClient().chat.completions.create({
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

    const prediction = parseStructure(parsed);

    if (!prediction) {
      failure = 'La respuesta no cumple la estructura exacta requerida.';
      continue;
    }

    failure = validateRules(prediction, match.home_team, match.away_team);

    if (!failure) {
      return {
        cache: {
          prediction,
          motor_determinista: report,
          generado_en: new Date().toISOString()
        },
        failure: null
      };
    }
  }

  return { cache: null, failure };
}
