import { parseScoreline, type PredictionCache } from './prediction-types';

export type MatchOutcome = 'home' | 'away' | 'draw';

export interface PredictionVerdict {
  hit: boolean;
  predicted_home: number;
  predicted_away: number;
  real_outcome: MatchOutcome;
  predicted_outcome: MatchOutcome;
}

export interface EvaluableMatch {
  status: string;
  home_score: number | null;
  away_score: number | null;
  prediction_cache: PredictionCache | null;
}

export function resolveOutcome(homeGoals: number, awayGoals: number): MatchOutcome {
  if (homeGoals > awayGoals) {
    return 'home';
  }

  if (homeGoals < awayGoals) {
    return 'away';
  }

  return 'draw';
}

export function evaluatePrediction(match: EvaluableMatch): PredictionVerdict | null {
  if (match.status !== 'finished' || match.home_score === null || match.away_score === null) {
    return null;
  }

  const scoreline = match.prediction_cache?.prediction?.marcador_exacto;

  if (!scoreline) {
    return null;
  }

  const predicted = parseScoreline(scoreline);

  if (!predicted) {
    return null;
  }

  const realOutcome = resolveOutcome(match.home_score, match.away_score);
  const predictedOutcome = resolveOutcome(predicted.home, predicted.away);

  return {
    hit: realOutcome === predictedOutcome,
    predicted_home: predicted.home,
    predicted_away: predicted.away,
    real_outcome: realOutcome,
    predicted_outcome: predictedOutcome
  };
}
