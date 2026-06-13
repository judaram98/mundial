const DEFAULT_ELO = 1500;
const K_FACTOR = 30;
const REFERENCE_ELO = 1600;
const MIN_QUALITY_FACTOR = 0.5;
const MAX_QUALITY_FACTOR = 1.5;
const MS_PER_DAY = 86400000;

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

export function buildNameMaps(teamStatsRows) {
  const spanishToEnglish = new Map();
  const seedByEnglish = new Map();

  for (const row of teamStatsRows) {
    const english = row.eloratings_team_name ?? row.team_name;
    spanishToEnglish.set(row.team_name, english);
    seedByEnglish.set(english, row.elo_cycle_start ?? DEFAULT_ELO);
  }

  return { spanishToEnglish, seedByEnglish };
}

export function buildGlobalMatches(historyRows, spanishToEnglish) {
  const byKey = new Map();

  for (const row of historyRows) {
    const team = spanishToEnglish.get(row.team_name) ?? row.team_name;
    const opponent = row.opponent;
    const [first, second] = [team, opponent].sort();
    const key = `${row.match_date}|${first}|${second}`;
    const existing = byKey.get(key);

    if (existing) {
      if (existing.homeSide === null && row.is_home !== null) {
        existing.homeSide = row.is_home ? team : opponent;
      }
      continue;
    }

    byKey.set(key, {
      date: row.match_date,
      teamA: team,
      teamB: opponent,
      goalsA: Number(row.goals_for),
      goalsB: Number(row.goals_against),
      homeSide: row.is_home === null ? null : row.is_home ? team : opponent
    });
  }

  return [...byKey.values()].sort((a, b) => a.date.localeCompare(b.date));
}

function marginMultiplier(goalDifference) {
  if (goalDifference <= 1) {
    return 1;
  }
  if (goalDifference === 2) {
    return 1.5;
  }
  return (11 + goalDifference) / 8;
}

export function replayElo(globalMatches, seedByEnglish) {
  const elo = new Map();
  const opponentEloLookup = new Map();

  const ratingOf = (team) => elo.get(team) ?? seedByEnglish.get(team) ?? DEFAULT_ELO;

  for (const match of globalMatches) {
    const eloA = ratingOf(match.teamA);
    const eloB = ratingOf(match.teamB);

    match.preEloA = eloA;
    match.preEloB = eloB;
    opponentEloLookup.set(`${match.date}|${match.teamA}|${match.teamB}`, eloB);
    opponentEloLookup.set(`${match.date}|${match.teamB}|${match.teamA}`, eloA);

    const expectedA = 1 / (1 + 10 ** (-(eloA - eloB) / 400));
    const scoreA = match.goalsA > match.goalsB ? 1 : match.goalsA === match.goalsB ? 0.5 : 0;
    const multiplier = marginMultiplier(Math.abs(match.goalsA - match.goalsB));
    const delta = K_FACTOR * multiplier * (scoreA - expectedA);

    elo.set(match.teamA, eloA + delta);
    elo.set(match.teamB, eloB - delta);
  }

  return { eloByTeam: elo, opponentEloLookup };
}

export function adjustedWeightedAverages(perspectiveRows, options) {
  const { halfLifeDays, referenceDate } = options;
  const referenceTime = new Date(referenceDate).getTime();

  let weightSum = 0;
  let attackSum = 0;
  let defenseSum = 0;

  for (const row of perspectiveRows) {
    const opponentElo = row.opponentElo ?? DEFAULT_ELO;
    const attackFactor = clamp(opponentElo / REFERENCE_ELO, MIN_QUALITY_FACTOR, MAX_QUALITY_FACTOR);
    const defenseFactor = clamp(REFERENCE_ELO / opponentElo, MIN_QUALITY_FACTOR, MAX_QUALITY_FACTOR);
    const ageDays = Math.max(0, (referenceTime - new Date(row.date).getTime()) / MS_PER_DAY);
    const weight = Number.isFinite(halfLifeDays) ? 0.5 ** (ageDays / halfLifeDays) : 1;

    weightSum += weight;
    attackSum += weight * row.goalsFor * attackFactor;
    defenseSum += weight * row.goalsAgainst * defenseFactor;
  }

  if (weightSum === 0) {
    return null;
  }

  return {
    avg_goals_scored: Number((attackSum / weightSum).toFixed(2)),
    avg_goals_conceded: Number((defenseSum / weightSum).toFixed(2))
  };
}

export function formPoints(results) {
  return results.reduce((sum, result) => sum + (result === 'W' ? 3 : result === 'D' ? 1 : 0), 0);
}

export function formSummary(results) {
  const lastFive = results.slice(-5);
  const previousFive = results.slice(-10, -5);
  const trendDelta =
    previousFive.length === 5 ? formPoints(lastFive) - formPoints(previousFive) : 0;

  return {
    form_last_five: lastFive.join('').padStart(5, 'D'),
    form_trend: trendDelta >= 3 ? 'up' : trendDelta <= -3 ? 'down' : 'stable'
  };
}
