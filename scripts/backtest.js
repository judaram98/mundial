import { createClient } from '@supabase/supabase-js';
import { buildDeterministicReport } from '../src/lib/prediction-engine.js';
import {
  buildNameMaps,
  buildGlobalMatches,
  replayElo,
  adjustedWeightedAverages,
  formSummary
} from './lib/history-model.js';

const EVAL_START = '2023-07-01';
const MIN_PRIOR_MATCHES = 8;
const HALF_LIFE_GRID = [1095, Infinity];
const RHO_GRID = [-0.05, -0.1, -0.15, -0.2];
const POISSON_WEIGHT_GRID = [0, 0.1, 0.2, 0.3, 0.4];
const HOME_BONUS_GRID = [20, 40, 60, 80];

const supabaseUrl = process.env.SUPABASE_URL || process.env.PUBLIC_SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error('Error: Las credenciales de Supabase no están configuradas en el entorno (.env).');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

async function loadAllHistory() {
  const rows = [];
  const pageSize = 1000;

  for (let from = 0; ; from += pageSize) {
    const { data, error } = await supabase
      .from('team_match_history')
      .select('team_name, match_date, opponent, is_home, goals_for, goals_against, result')
      .order('match_date', { ascending: true })
      .order('id', { ascending: true })
      .range(from, from + pageSize - 1);

    if (error) {
      throw new Error(`Error al leer team_match_history: ${error.message}`);
    }

    rows.push(...(data ?? []));

    if (!data || data.length < pageSize) {
      return rows;
    }
  }
}

function buildSyntheticStats(name, state, halfLifeDays, referenceDate, currentElo, seedElo) {
  const averages = adjustedWeightedAverages(state.rows, { halfLifeDays, referenceDate });

  if (!averages) {
    return null;
  }

  const form = formSummary(state.results);
  const wins = state.results.filter((r) => r === 'W').length;
  const draws = state.results.filter((r) => r === 'D').length;
  const losses = state.results.filter((r) => r === 'L').length;

  return {
    team_name: name,
    elo: Math.round(currentElo),
    elo_cycle_start: Math.round(seedElo),
    avg_goals_scored: averages.avg_goals_scored,
    avg_goals_conceded: averages.avg_goals_conceded,
    avg_xg_for: null,
    avg_xg_against: null,
    matches_played: state.results.length,
    wins,
    draws,
    losses,
    form_last_five: form.form_last_five,
    form_trend: form.form_trend,
    stats_period_start: '2022-06-01',
    stats_period_end: referenceDate,
    data_source: 'real',
    seedElo
  };
}

function outcomeIndex(goalsHome, goalsAway) {
  if (goalsHome > goalsAway) {
    return 0;
  }
  if (goalsHome === goalsAway) {
    return 1;
  }
  return 2;
}

function evaluateConfig(samples, config) {
  let logLoss = 0;
  let brier = 0;
  let hits = 0;
  let drawsPredicted = 0;
  let drawsReal = 0;

  for (const sample of samples) {
    const inputs = sample.inputsByHalfLife.get(config.halfLifeDays);
    const report = buildDeterministicReport(inputs.home, inputs.away, {
      rho: config.rho,
      poissonWeight: config.poissonWeight,
      homeEloBonus: sample.neutral ? 0 : config.homeBonus
    });

    const probs = report.mercado_1x2.probabilidades;
    const p = [probs.victoria_local, probs.empate, probs.victoria_visitante].map((v) => v / 100);
    const real = sample.outcome;

    logLoss += -Math.log(p[real]);
    brier += p.reduce((sum, value, index) => sum + (value - (index === real ? 1 : 0)) ** 2, 0);

    const predicted = p.indexOf(Math.max(...p));
    if (predicted === real) {
      hits += 1;
    }
    if (predicted === 1) {
      drawsPredicted += 1;
    }
    if (real === 1) {
      drawsReal += 1;
    }
  }

  const n = samples.length;
  return {
    ...config,
    logLoss: logLoss / n,
    brier: brier / n,
    accuracy: hits / n,
    drawsPredicted,
    drawsReal,
    n
  };
}

async function backtest() {
  const { data: teamRows, error } = await supabase
    .from('team_stats')
    .select('team_name, elo, elo_cycle_start, eloratings_team_name');

  if (error) {
    throw new Error(`Error al leer team_stats: ${error.message}`);
  }

  const { spanishToEnglish, seedByEnglish } = buildNameMaps(teamRows);
  const trackedEnglish = new Set(seedByEnglish.keys());
  const historyRows = await loadAllHistory();
  const globalMatches = buildGlobalMatches(historyRows, spanishToEnglish);

  console.log(
    `Historial: ${historyRows.length} filas → ${globalMatches.length} partidos globales únicos.`
  );

  replayElo(globalMatches, seedByEnglish);

  const state = new Map();
  const ensureState = (team) => {
    if (!state.has(team)) {
      state.set(team, { rows: [], results: [] });
    }
    return state.get(team);
  };

  const samples = [];

  for (const match of globalMatches) {
    const stateA = ensureState(match.teamA);
    const stateB = ensureState(match.teamB);

    const isEvaluable =
      match.date >= EVAL_START &&
      trackedEnglish.has(match.teamA) &&
      trackedEnglish.has(match.teamB) &&
      stateA.rows.length >= MIN_PRIOR_MATCHES &&
      stateB.rows.length >= MIN_PRIOR_MATCHES;

    if (isEvaluable) {
      const homeIsA = match.homeSide === null || match.homeSide === match.teamA;
      const homeTeam = homeIsA ? match.teamA : match.teamB;
      const awayTeam = homeIsA ? match.teamB : match.teamA;
      const homeState = homeIsA ? stateA : stateB;
      const awayState = homeIsA ? stateB : stateA;
      const homeElo = homeIsA ? match.preEloA : match.preEloB;
      const awayElo = homeIsA ? match.preEloB : match.preEloA;
      const goalsHome = homeIsA ? match.goalsA : match.goalsB;
      const goalsAway = homeIsA ? match.goalsB : match.goalsA;

      const inputsByHalfLife = new Map();
      let complete = true;

      for (const halfLifeDays of HALF_LIFE_GRID) {
        const home = buildSyntheticStats(
          homeTeam,
          homeState,
          halfLifeDays,
          match.date,
          homeElo,
          seedByEnglish.get(homeTeam)
        );
        const away = buildSyntheticStats(
          awayTeam,
          awayState,
          halfLifeDays,
          match.date,
          awayElo,
          seedByEnglish.get(awayTeam)
        );

        if (!home || !away) {
          complete = false;
          break;
        }

        inputsByHalfLife.set(halfLifeDays, { home, away });
      }

      if (complete) {
        samples.push({
          inputsByHalfLife,
          neutral: match.homeSide === null,
          outcome: outcomeIndex(goalsHome, goalsAway)
        });
      }
    }

    const opponentEloForA = match.preEloB;
    const opponentEloForB = match.preEloA;

    stateA.rows.push({
      date: match.date,
      goalsFor: match.goalsA,
      goalsAgainst: match.goalsB,
      opponentElo: opponentEloForA
    });
    stateA.results.push(
      match.goalsA > match.goalsB ? 'W' : match.goalsA === match.goalsB ? 'D' : 'L'
    );

    stateB.rows.push({
      date: match.date,
      goalsFor: match.goalsB,
      goalsAgainst: match.goalsA,
      opponentElo: opponentEloForB
    });
    stateB.results.push(
      match.goalsB > match.goalsA ? 'W' : match.goalsB === match.goalsA ? 'D' : 'L'
    );
  }

  const withVenue = samples.filter((s) => !s.neutral).length;
  const realDraws = samples.filter((s) => s.outcome === 1).length;
  console.log(
    `Muestra de evaluación: ${samples.length} partidos entre selecciones del Mundial (${withVenue} con localía conocida, ${realDraws} empates reales = ${((realDraws / samples.length) * 100).toFixed(1)}%).`
  );

  const results = [];

  for (const halfLifeDays of HALF_LIFE_GRID) {
    for (const rho of RHO_GRID) {
      for (const poissonWeight of POISSON_WEIGHT_GRID) {
        for (const homeBonus of HOME_BONUS_GRID) {
          results.push(
            evaluateConfig(samples, { halfLifeDays, rho, poissonWeight, homeBonus })
          );
        }
      }
    }
  }

  results.sort((a, b) => a.logLoss - b.logLoss);

  console.log('\nTop 10 configuraciones por log-loss (menor es mejor):');
  console.log('halfLife | rho   | pesoPoisson | bonusLocal | logLoss | Brier  | acierto | empates pred/real');

  for (const r of results.slice(0, 10)) {
    console.log(
      `${String(r.halfLifeDays).padEnd(8)} | ${String(r.rho).padEnd(5)} | ${String(r.poissonWeight).padEnd(11)} | ${String(r.homeBonus).padEnd(10)} | ${r.logLoss.toFixed(4)}  | ${r.brier.toFixed(4)} | ${(r.accuracy * 100).toFixed(1)}%   | ${r.drawsPredicted}/${r.drawsReal}`
    );
  }

  const uniform = Math.log(3);
  console.log(`\nReferencia: log-loss de probabilidades uniformes (33/33/33) = ${uniform.toFixed(4)}.`);

  const worst = results[results.length - 1];
  console.log(
    `Peor configuración del grid: logLoss ${worst.logLoss.toFixed(4)} (halfLife ${worst.halfLifeDays}, rho ${worst.rho}, pesoPoisson ${worst.poissonWeight}, bonus ${worst.homeBonus}).`
  );
}

backtest().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
