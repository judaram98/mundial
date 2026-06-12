import { supabase } from './supabase';
import { evaluatePrediction, type MatchOutcome, type PredictionVerdict } from './accuracy';
import type { PredictionCache } from './prediction-types';

const MAX_LESSONS_PER_TEAM = 3;

interface FinishedMatch {
  date: string;
  home_team: string;
  away_team: string;
  home_score: number | null;
  away_score: number | null;
  status: string;
  prediction_cache: PredictionCache | null;
}

export async function buildTournamentFeedback(
  homeTeam: string,
  awayTeam: string
): Promise<string | null> {
  const finishedMatches = await fetchFinishedMatches();
  const seen = new Set<string>();
  const lessons: string[] = [];

  for (const team of [homeTeam, awayTeam]) {
    for (const match of relevantMatchesFor(team, finishedMatches)) {
      const key = `${match.date}|${match.home_team}|${match.away_team}`;

      if (seen.has(key)) {
        continue;
      }

      const lesson = describeLesson(team, match);

      if (lesson) {
        seen.add(key);
        lessons.push(`- ${lesson}`);
      }
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

function relevantMatchesFor(team: string, matches: FinishedMatch[]): FinishedMatch[] {
  return matches
    .filter((match) => match.home_team === team || match.away_team === team)
    .slice(0, MAX_LESSONS_PER_TEAM);
}

function describeLesson(team: string, match: FinishedMatch): string | null {
  const verdict = evaluatePrediction(match);

  if (!verdict) {
    return null;
  }

  const realScore = `${match.home_score}-${match.away_score}`;
  const predictedScore = `${verdict.predicted_home}-${verdict.predicted_away}`;
  const header = `${match.home_team} ${realScore} ${match.away_team}`;

  if (verdict.hit && realScore === predictedScore) {
    return `Acierto pleno previo: en ${header}, la IA predijo exactamente ${predictedScore}. La calibración de ataque y defensa aplicada a ${team} quedó validada: consérvala.`;
  }

  if (verdict.hit) {
    return `Acierto parcial previo: en ${header}, la IA acertó el ganador (${outcomeLabel(verdict.real_outcome, match)}) pero predijo ${predictedScore}. ${describeBias(match, verdict)} Afina la magnitud ofensiva/defensiva estimada para ${team} sin cambiar la dirección del juicio.`;
  }

  return `Diagnóstico de Error Previo: en ${header}, la IA predijo ${predictedScore} (${outcomeLabel(verdict.predicted_outcome, match)}), pero el resultado real fue ${outcomeLabel(verdict.real_outcome, match)}. ${describeBias(match, verdict)} Ajusta tus pesos lógicos para no repetir este sesgo en el análisis de ${team}.`;
}

function outcomeLabel(outcome: MatchOutcome, match: FinishedMatch): string {
  if (outcome === 'home') {
    return `victoria de ${match.home_team}`;
  }

  if (outcome === 'away') {
    return `victoria de ${match.away_team}`;
  }

  return 'empate';
}

function goalCount(goals: number): string {
  return goals === 1 ? '1 gol' : `${goals} goles`;
}

function describeBias(match: FinishedMatch, verdict: PredictionVerdict): string {
  const findings: string[] = [];
  const homeDelta = verdict.predicted_home - (match.home_score ?? 0);
  const awayDelta = verdict.predicted_away - (match.away_score ?? 0);

  if (homeDelta > 0) {
    findings.push(
      `sobreestimó el poder ofensivo de ${match.home_team} y subestimó la defensa de ${match.away_team} (esperaba ${goalCount(verdict.predicted_home)} del local y marcó ${match.home_score})`
    );
  }

  if (homeDelta < 0) {
    findings.push(
      `subestimó el poder ofensivo de ${match.home_team} y sobreestimó la defensa de ${match.away_team} (esperaba ${goalCount(verdict.predicted_home)} del local y marcó ${match.home_score})`
    );
  }

  if (awayDelta > 0) {
    findings.push(
      `sobreestimó el poder ofensivo de ${match.away_team} y subestimó la defensa de ${match.home_team} (esperaba ${goalCount(verdict.predicted_away)} del visitante y marcó ${match.away_score})`
    );
  }

  if (awayDelta < 0) {
    findings.push(
      `subestimó el poder ofensivo de ${match.away_team} y sobreestimó la defensa de ${match.home_team} (esperaba ${goalCount(verdict.predicted_away)} del visitante y marcó ${match.away_score})`
    );
  }

  if (findings.length === 0) {
    return 'La calibración ofensiva y defensiva fue exacta en ambos lados.';
  }

  return `La IA ${findings.join('; además, ')}.`;
}
