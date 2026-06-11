import type { Match } from './matches';
import { parseScoreline } from './prediction-types';

export interface StandingRow {
  team: string;
  played: number;
  wins: number;
  draws: number;
  losses: number;
  goals_for: number;
  goals_against: number;
  goal_difference: number;
  points: number;
  predicted_matches: number;
}

export interface GroupStanding {
  group: string;
  rows: StandingRow[];
  real_matches: number;
  predicted_matches: number;
}

interface ResolvedScore {
  home: number;
  away: number;
  predicted: boolean;
}

function resolveScore(match: Match): ResolvedScore | null {
  if (match.status === 'finished' && match.home_score != null && match.away_score != null) {
    return { home: match.home_score, away: match.away_score, predicted: false };
  }

  const cachedScoreline = match.prediction_cache?.prediction?.marcador_exacto;

  if (cachedScoreline) {
    const score = parseScoreline(cachedScoreline);
    if (score) {
      return { home: score.home, away: score.away, predicted: true };
    }
  }

  return null;
}

function emptyRow(team: string): StandingRow {
  return {
    team,
    played: 0,
    wins: 0,
    draws: 0,
    losses: 0,
    goals_for: 0,
    goals_against: 0,
    goal_difference: 0,
    points: 0,
    predicted_matches: 0
  };
}

function applyResult(row: StandingRow, goalsFor: number, goalsAgainst: number, predicted: boolean): void {
  row.played += 1;
  row.goals_for += goalsFor;
  row.goals_against += goalsAgainst;
  row.goal_difference = row.goals_for - row.goals_against;

  if (predicted) {
    row.predicted_matches += 1;
  }

  if (goalsFor > goalsAgainst) {
    row.wins += 1;
    row.points += 3;
  } else if (goalsFor === goalsAgainst) {
    row.draws += 1;
    row.points += 1;
  } else {
    row.losses += 1;
  }
}

function compareRows(a: StandingRow, b: StandingRow): number {
  return (
    b.points - a.points ||
    b.goal_difference - a.goal_difference ||
    b.goals_for - a.goals_for ||
    a.team.localeCompare(b.team, 'es')
  );
}

export function buildGroupStandings(matches: Match[]): GroupStanding[] {
  const groups = new Map<string, { rows: Map<string, StandingRow>; real: number; predicted: number }>();

  for (const match of matches) {
    if (!match.group_name) {
      continue;
    }

    let group = groups.get(match.group_name);

    if (!group) {
      group = { rows: new Map(), real: 0, predicted: 0 };
      groups.set(match.group_name, group);
    }

    for (const team of [match.home_team, match.away_team]) {
      if (!group.rows.has(team)) {
        group.rows.set(team, emptyRow(team));
      }
    }

    const score = resolveScore(match);

    if (!score) {
      continue;
    }

    applyResult(group.rows.get(match.home_team)!, score.home, score.away, score.predicted);
    applyResult(group.rows.get(match.away_team)!, score.away, score.home, score.predicted);

    if (score.predicted) {
      group.predicted += 1;
    } else {
      group.real += 1;
    }
  }

  return [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([group, data]) => ({
      group,
      rows: [...data.rows.values()].sort(compareRows),
      real_matches: data.real,
      predicted_matches: data.predicted
    }));
}
