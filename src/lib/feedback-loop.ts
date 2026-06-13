import { supabase } from './supabase';
import { evaluatePrediction, type PredictionVerdict } from './accuracy';
import type { PredictionCache } from './prediction-types';

const MIN_MATCHES_FOR_BIAS = 3;
const BIAS_GOAL_THRESHOLD = 0.5;

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

export async function buildTournamentFeedback(
  homeTeam: string,
  awayTeam: string
): Promise<string | null> {
  const finishedMatches = await fetchFinishedMatches();
  const lessons: string[] = [];

  for (const team of [homeTeam, awayTeam]) {
    const samples = collectTeamSamples(team, finishedMatches);
    const lesson = describeTeamLesson(team, samples);

    if (lesson) {
      lessons.push(`- ${lesson}`);
    }
  }

  return lessons.length > 0 ? lessons.join('\n') : null;
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

function describeTeamLesson(team: string, samples: TeamSample[]): string | null {
  if (samples.length === 0) {
    return null;
  }

  if (samples.length < MIN_MATCHES_FOR_BIAS) {
    return describeInformativeContext(team, samples);
  }

  return describeAggregatedDiagnosis(team, samples);
}

function describeInformativeContext(team: string, samples: TeamSample[]): string {
  const matchCount = samples.length === 1 ? '1 partido' : `${samples.length} partidos`;
  const summary = samples
    .map((sample) => `${sample.header} (la IA predijo ${sample.predictedScore})`)
    .join('; ');

  return `Contexto informativo de ${team} (muestra insuficiente: ${matchCount} finalizados): ${summary}. NO ajustes pesos, probabilidades ni nivel_certeza con esta muestra; úsala solo como referencia descriptiva.`;
}

function describeAggregatedDiagnosis(team: string, samples: TeamSample[]): string {
  const total = samples.length;
  const hits = samples.filter((sample) => sample.hit).length;
  const avgAttackDelta = average(samples.map((sample) => sample.attackDelta));
  const avgDefenseDelta = average(samples.map((sample) => sample.defenseDelta));

  const parts = [
    `Diagnóstico acumulado de ${team} (${total} partidos finalizados): la IA acertó el ganador en ${hits} de ${total}.`,
    describeAttackBias(team, avgAttackDelta),
    describeDefenseBias(team, avgDefenseDelta),
    `Ajusta tu ponderación cualitativa de ${team} únicamente conforme a este patrón agregado.`
  ];

  return parts.join(' ');
}

function describeAttackBias(team: string, avgDelta: number): string {
  const magnitude = formatGoals(Math.abs(avgDelta));

  if (avgDelta >= BIAS_GOAL_THRESHOLD) {
    return `En promedio sobreestimó la producción ofensiva de ${team} en ${magnitude} por partido.`;
  }

  if (avgDelta <= -BIAS_GOAL_THRESHOLD) {
    return `En promedio subestimó la producción ofensiva de ${team} en ${magnitude} por partido.`;
  }

  return `Su producción ofensiva está bien calibrada (desvío medio de ${formatGoals(avgDelta)}).`;
}

function describeDefenseBias(team: string, avgDelta: number): string {
  const magnitude = formatGoals(Math.abs(avgDelta));

  if (avgDelta >= BIAS_GOAL_THRESHOLD) {
    return `Su defensa rindió mejor de lo previsto: la IA esperaba ${magnitude} más en contra por partido.`;
  }

  if (avgDelta <= -BIAS_GOAL_THRESHOLD) {
    return `Su defensa rindió peor de lo previsto: la IA esperaba ${magnitude} menos en contra por partido.`;
  }

  return `Su rendimiento defensivo está bien calibrado (desvío medio de ${formatGoals(avgDelta)}).`;
}

function average(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function formatGoals(value: number): string {
  const rounded = Math.round(value * 100) / 100;
  return `${rounded} ${Math.abs(rounded) === 1 ? 'gol' : 'goles'}`;
}
