import { supabase } from './supabase';
import { evaluatePrediction, type PredictionVerdict } from './accuracy';
import type { TeamStats } from './prediction-engine';
import type { PredictionCache } from './prediction-types';

const MIN_MATCHES_FOR_BIAS = 3;
const BIAS_GOAL_THRESHOLD = 0.5;
const CALIBRATION_DAMPING = 0.5;
const MAX_CALIBRATION_SHIFT = 0.4;
const MIN_ADJUSTED_AVERAGE = 0.1;

export interface CalibrationAdjustment {
  attack_shift: number;
  defense_shift: number;
  matches: number;
  hits: number;
}

export interface TournamentContext {
  narrative: string | null;
  adjustments: Map<string, CalibrationAdjustment>;
}

interface FinishedMatch {
  date: string;
  home_team: string;
  away_team: string;
  home_score: number | null;
  away_score: number | null;
  status: string;
  prediction_cache: PredictionCache | null;
}

interface TeamSample {
  header: string;
  predictedScore: string;
  hit: boolean;
  attackDelta: number;
  defenseDelta: number;
}

export async function buildTournamentContext(
  homeTeam: string,
  awayTeam: string
): Promise<TournamentContext> {
  const finishedMatches = await fetchFinishedMatches();
  const lessons: string[] = [];
  const adjustments = new Map<string, CalibrationAdjustment>();

  for (const team of [homeTeam, awayTeam]) {
    const samples = collectTeamSamples(team, finishedMatches);

    if (samples.length === 0) {
      continue;
    }

    if (samples.length < MIN_MATCHES_FOR_BIAS) {
      lessons.push(`- ${describeInformativeContext(team, samples)}`);
      continue;
    }

    const adjustment = computeCalibrationAdjustment(samples);
    adjustments.set(team, adjustment);
    lessons.push(`- ${describeAggregatedDiagnosis(team, samples, adjustment)}`);
  }

  return {
    narrative: lessons.length > 0 ? lessons.join('\n') : null,
    adjustments
  };
}

export function applyCalibration(
  stats: TeamStats,
  adjustment: CalibrationAdjustment | undefined
): TeamStats {
  if (!adjustment) {
    return stats;
  }

  return {
    ...stats,
    avg_goals_scored: Math.max(
      MIN_ADJUSTED_AVERAGE,
      roundTo(stats.avg_goals_scored + adjustment.attack_shift, 2)
    ),
    avg_goals_conceded: Math.max(
      MIN_ADJUSTED_AVERAGE,
      roundTo(stats.avg_goals_conceded + adjustment.defense_shift, 2)
    )
  };
}

async function fetchFinishedMatches(): Promise<FinishedMatch[]> {
  const { data, error } = await supabase
    .from('matches')
    .select('date, home_team, away_team, home_score, away_score, status, prediction_cache')
    .eq('status', 'finished')
    .order('date', { ascending: false });

  if (error) {
    throw new Error(`Error al consultar el historial del torneo: ${error.message}`);
  }

  return (data ?? []) as FinishedMatch[];
}

function collectTeamSamples(team: string, matches: FinishedMatch[]): TeamSample[] {
  const samples: TeamSample[] = [];

  for (const match of matches) {
    if (match.home_team !== team && match.away_team !== team) {
      continue;
    }

    const verdict = evaluatePrediction(match);

    if (!verdict) {
      continue;
    }

    samples.push(buildSample(team, match, verdict));
  }

  return samples;
}

function buildSample(team: string, match: FinishedMatch, verdict: PredictionVerdict): TeamSample {
  const isHome = match.home_team === team;
  const realFor = (isHome ? match.home_score : match.away_score) ?? 0;
  const realAgainst = (isHome ? match.away_score : match.home_score) ?? 0;
  const predictedFor = isHome ? verdict.predicted_home : verdict.predicted_away;
  const predictedAgainst = isHome ? verdict.predicted_away : verdict.predicted_home;

  return {
    header: `${match.home_team} ${match.home_score}-${match.away_score} ${match.away_team}`,
    predictedScore: `${verdict.predicted_home}-${verdict.predicted_away}`,
    hit: verdict.hit,
    attackDelta: predictedFor - realFor,
    defenseDelta: predictedAgainst - realAgainst
  };
}

function computeCalibrationAdjustment(samples: TeamSample[]): CalibrationAdjustment {
  const avgAttackDelta = average(samples.map((sample) => sample.attackDelta));
  const avgDefenseDelta = average(samples.map((sample) => sample.defenseDelta));

  return {
    attack_shift: dampedShift(avgAttackDelta),
    defense_shift: dampedShift(avgDefenseDelta),
    matches: samples.length,
    hits: samples.filter((sample) => sample.hit).length
  };
}

function dampedShift(avgDelta: number): number {
  if (Math.abs(avgDelta) < BIAS_GOAL_THRESHOLD) {
    return 0;
  }

  const shift = -avgDelta * CALIBRATION_DAMPING;
  return roundTo(Math.min(Math.max(shift, -MAX_CALIBRATION_SHIFT), MAX_CALIBRATION_SHIFT), 2);
}

function describeInformativeContext(team: string, samples: TeamSample[]): string {
  const matchCount = samples.length === 1 ? '1 partido' : `${samples.length} partidos`;
  const summary = samples
    .map((sample) => `${sample.header} (la IA predijo ${sample.predictedScore})`)
    .join('; ');

  return `Contexto informativo de ${team} (muestra insuficiente: ${matchCount} finalizados): ${summary}. Esta muestra no alteró ningún número; úsala solo como referencia descriptiva en la redacción.`;
}

function describeAggregatedDiagnosis(
  team: string,
  samples: TeamSample[],
  adjustment: CalibrationAdjustment
): string {
  const corrections: string[] = [];

  if (adjustment.attack_shift !== 0) {
    const direction = adjustment.attack_shift > 0 ? 'subestimó' : 'sobreestimó';
    corrections.push(
      `${direction} su producción ofensiva, por lo que el motor ya corrigió su promedio goleador en ${formatShift(adjustment.attack_shift)}`
    );
  }

  if (adjustment.defense_shift !== 0) {
    const direction = adjustment.defense_shift > 0 ? 'subestimó los goles que recibiría' : 'sobreestimó los goles que recibiría';
    corrections.push(
      `${direction}, por lo que el motor ya corrigió su promedio de goles en contra en ${formatShift(adjustment.defense_shift)}`
    );
  }

  const correctionText =
    corrections.length > 0
      ? `La IA ${corrections.join('; además, ')}.`
      : 'Su calibración ofensiva y defensiva resultó correcta, así que no se aplicó corrección numérica.';

  return `Diagnóstico acumulado de ${team} (${samples.length} partidos finalizados, ganador acertado en ${adjustment.hits} de ${samples.length}): ${correctionText} Estas correcciones ya están reflejadas en los cálculos deterministas recibidos; cítalas en la redacción sin alterar ningún número.`;
}

function formatShift(shift: number): string {
  const value = Math.abs(shift);
  return `${shift > 0 ? '+' : '-'}${value} ${value === 1 ? 'gol' : 'goles'} por partido`;
}

function average(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function roundTo(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}
