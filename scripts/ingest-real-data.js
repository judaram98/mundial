import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createClient } from '@supabase/supabase-js';
import { createFootballDataProvider } from '../src/lib/ingestion/football-data.ts';
import { createOpenDataProvider } from '../src/lib/ingestion/open-data.ts';
import { createEloRatingsProvider, createFbrefApifyProvider } from '../src/lib/ingestion/scrapers.ts';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('Faltan las variables de entorno SUPABASE_URL y SUPABASE_SERVICE_ROLE_KEY.');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false }
});

const CYCLE_PERIOD = {
  start: process.env.INGESTION_CYCLE_START ?? '2022-06-01',
  end: process.env.INGESTION_CYCLE_END ?? new Date().toISOString().slice(0, 10)
};

const FBREF_ENABLED = process.env.FBREF_INGESTION_ENABLED === 'true';
const MATCH_HISTORY_CONFLICT = 'team_name,match_date,opponent';
const CHUNK_SIZE = 500;
const MIN_MATCHES_FOR_AGGREGATES = 5;
const MIN_MATCHES_REQUIRED = 15;

function chunk(rows, size) {
  const batches = [];
  for (let index = 0; index < rows.length; index += size) {
    batches.push(rows.slice(index, index + size));
  }
  return batches;
}

function dedupeHistory(records) {
  const byKey = new Map();
  for (const record of records) {
    byKey.set(`${record.team_name}|${record.match_date}|${record.opponent}`, record);
  }
  return [...byKey.values()];
}

function dedupeByDate(rows) {
  const byDate = new Map();
  for (const row of rows) {
    const existing = byDate.get(row.match_date);
    if (!existing || (existing.xg_for == null && row.xg_for != null)) {
      byDate.set(row.match_date, row);
    }
  }
  return [...byDate.values()];
}

function roundAverage(total, count) {
  return Number((total / count).toFixed(2));
}

function formPoints(results) {
  return results.reduce((sum, result) => sum + (result === 'W' ? 3 : result === 'D' ? 1 : 0), 0);
}

function buildAggregates(rows) {
  const sorted = [...rows].sort((a, b) => String(a.match_date).localeCompare(String(b.match_date)));

  let wins = 0;
  let draws = 0;
  let losses = 0;
  let goalsFor = 0;
  let goalsAgainst = 0;
  let xgForSum = 0;
  let xgAgainstSum = 0;
  let xgCount = 0;

  for (const row of sorted) {
    if (row.result === 'W') wins += 1;
    else if (row.result === 'D') draws += 1;
    else losses += 1;

    goalsFor += Number(row.goals_for);
    goalsAgainst += Number(row.goals_against);

    if (row.xg_for != null && row.xg_against != null) {
      xgForSum += Number(row.xg_for);
      xgAgainstSum += Number(row.xg_against);
      xgCount += 1;
    }
  }

  const lastFive = sorted.slice(-5).map((row) => row.result);
  const previousFive = sorted.slice(-10, -5).map((row) => row.result);
  const trendDelta = previousFive.length === 5 ? formPoints(lastFive) - formPoints(previousFive) : 0;

  return {
    matches_played: sorted.length,
    wins,
    draws,
    losses,
    avg_goals_scored: roundAverage(goalsFor, sorted.length),
    avg_goals_conceded: roundAverage(goalsAgainst, sorted.length),
    avg_xg_for: xgCount > 0 ? roundAverage(xgForSum, xgCount) : null,
    avg_xg_against: xgCount > 0 ? roundAverage(xgAgainstSum, xgCount) : null,
    form_last_five: lastFive.join(''),
    form_trend: trendDelta >= 3 ? 'up' : trendDelta <= -3 ? 'down' : 'stable'
  };
}

async function loadTournamentTeamNames() {
  const filePath = resolve(process.cwd(), 'data', 'world_cup_2026.json');
  const raw = await readFile(filePath, 'utf-8');
  const data = JSON.parse(raw);
  const names = new Set();

  for (const match of data.matches) {
    names.add(match.home_team);
    names.add(match.away_team);
  }

  return [...names].sort((a, b) => a.localeCompare(b, 'es'));
}

async function loadTeams() {
  const tournamentNames = await loadTournamentTeamNames();

  const { data, error } = await supabase
    .from('team_stats')
    .select('team_name, api_football_team_id, fbref_team_id, eloratings_team_name')
    .in('team_name', tournamentNames);

  if (error) {
    throw new Error(`Error al leer team_stats: ${error.message}`);
  }

  const rows = data ?? [];
  const inDatabase = new Set(rows.map((row) => row.team_name));
  const missing = tournamentNames.filter((name) => !inDatabase.has(name));

  if (missing.length > 0) {
    console.error(
      `[validación] Equipos del calendario ausentes en team_stats: ${missing.join(', ')}. Ejecuta npm run seed.`
    );
    process.exit(1);
  }

  const unmapped = rows.filter((row) => !row.eloratings_team_name).map((row) => row.team_name);

  if (unmapped.length > 0) {
    console.error(
      `[validación] Equipos del calendario sin eloratings_team_name: ${unmapped.join(', ')}. Ejecuta npm run map-teams.`
    );
    process.exit(1);
  }

  return rows;
}

async function startRun(source) {
  const { data, error } = await supabase
    .from('ingestion_runs')
    .insert({ source, status: 'running' })
    .select('id')
    .single();

  if (error) {
    throw new Error(`No fue posible registrar la corrida de ${source}: ${error.message}`);
  }

  return data.id;
}

async function finishRun(runId, status, recordsUpserted, detail) {
  const { error } = await supabase
    .from('ingestion_runs')
    .update({
      status,
      records_upserted: recordsUpserted,
      detail,
      finished_at: new Date().toISOString()
    })
    .eq('id', runId);

  if (error) {
    console.error(`No fue posible cerrar la corrida ${runId}: ${error.message}`);
  }
}

async function runSource(source, task) {
  const runId = await startRun(source);

  try {
    const { records, detail } = await task();
    await finishRun(runId, 'completed', records, detail);
    console.log(`[${source}] completado: ${records} registros. ${detail}`);
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await finishRun(runId, 'failed', 0, message);
    console.error(`[${source}] falló: ${message}`);
    return false;
  }
}

async function upsertMatchHistory(records) {
  const deduped = dedupeHistory(records);

  for (const batch of chunk(deduped, CHUNK_SIZE)) {
    const { error } = await supabase
      .from('team_match_history')
      .upsert(batch, { onConflict: MATCH_HISTORY_CONFLICT });

    if (error) {
      throw new Error(`Error al guardar team_match_history: ${error.message}`);
    }
  }

  return deduped.length;
}

async function ingestMatchHistorySource(provider, teams, sourceLabel) {
  const unresolved = [];
  let records = 0;

  for (const team of teams) {
    const history = await provider.fetchTeamHistory(team, CYCLE_PERIOD);

    if (history.length === 0) {
      unresolved.push(team.team_name);
      continue;
    }

    records += await upsertMatchHistory(history);
    console.log(`[${sourceLabel}] ${team.team_name}: ${history.length} partidos.`);
  }

  const detailParts = [`${teams.length - unresolved.length} equipos con historial cargado`];

  if (unresolved.length > 0) {
    detailParts.push(`sin partidos disponibles: ${unresolved.join(', ')}`);
  }

  return { records, detail: `${detailParts.join('; ')}.` };
}

async function ingestEloRatings(teams) {
  const provider = createEloRatingsProvider();
  const eligible = teams.filter((team) => team.eloratings_team_name);
  const unresolved = [];
  let records = 0;

  for (const team of eligible) {
    const snapshots = await provider.fetchEloHistory(team, CYCLE_PERIOD);

    if (snapshots.length === 0) {
      unresolved.push(team.team_name);
      continue;
    }

    const { error } = await supabase
      .from('team_elo_history')
      .upsert(snapshots, { onConflict: 'team_name,recorded_on,source' });

    if (error) {
      throw new Error(`Error al guardar team_elo_history: ${error.message}`);
    }

    records += snapshots.length;

    const sorted = [...snapshots].sort((a, b) => a.recorded_on.localeCompare(b.recorded_on));
    const { error: updateError } = await supabase
      .from('team_stats')
      .update({
        elo: sorted[sorted.length - 1].elo,
        elo_cycle_start: sorted[0].elo,
        last_synced_at: new Date().toISOString()
      })
      .eq('team_name', team.team_name);

    if (updateError) {
      throw new Error(`Error al actualizar el Elo de ${team.team_name}: ${updateError.message}`);
    }
  }

  const detailParts = [
    `${eligible.length - unresolved.length} equipos con Elo actualizado`,
    `${teams.length - eligible.length} sin eloratings_team_name`
  ];

  if (unresolved.length > 0) {
    detailParts.push(`sin correspondencia en eloratings.net: ${unresolved.join(', ')}`);
  }

  return { records, detail: `${detailParts.join('; ')}.` };
}

async function ingestFbref(teams) {
  const provider = createFbrefApifyProvider();
  const eligible = teams.filter((team) => team.fbref_team_id);
  let records = 0;

  for (const team of eligible) {
    const history = await provider.fetchXgHistory(team, CYCLE_PERIOD);

    for (const record of dedupeHistory(history)) {
      if (record.xg_for == null && record.xg_against == null) {
        continue;
      }

      const { data, error } = await supabase
        .from('team_match_history')
        .update({ xg_for: record.xg_for, xg_against: record.xg_against })
        .eq('team_name', record.team_name)
        .eq('match_date', record.match_date)
        .select('id');

      if (error) {
        throw new Error(`Error al fusionar xG de ${team.team_name}: ${error.message}`);
      }

      if (data && data.length > 0) {
        records += data.length;
        continue;
      }

      const { error: insertError } = await supabase
        .from('team_match_history')
        .upsert([record], { onConflict: MATCH_HISTORY_CONFLICT });

      if (insertError) {
        throw new Error(`Error al insertar xG de ${team.team_name}: ${insertError.message}`);
      }

      records += 1;
    }

    console.log(`[fbref] ${team.team_name}: ${history.length} registros de xG.`);
  }

  return {
    records,
    detail: `${eligible.length} equipos procesados, ${teams.length - eligible.length} sin fbref_team_id.`
  };
}

async function recomputeAggregates(teams) {
  const coverage = new Map();
  const pending = [];
  let updated = 0;

  for (const team of teams) {
    const { data, error } = await supabase
      .from('team_match_history')
      .select('match_date, goals_for, goals_against, xg_for, xg_against, result')
      .eq('team_name', team.team_name)
      .gte('match_date', CYCLE_PERIOD.start)
      .lte('match_date', CYCLE_PERIOD.end)
      .order('match_date', { ascending: true });

    if (error) {
      throw new Error(`Error al leer el historial de ${team.team_name}: ${error.message}`);
    }

    const rows = dedupeByDate(data ?? []);
    coverage.set(team.team_name, rows.length);

    if (rows.length < MIN_MATCHES_FOR_AGGREGATES) {
      pending.push(team.team_name);
      continue;
    }

    const aggregates = buildAggregates(rows);
    const { error: updateError } = await supabase
      .from('team_stats')
      .update({
        matches_played: aggregates.matches_played,
        wins: aggregates.wins,
        draws: aggregates.draws,
        losses: aggregates.losses,
        avg_goals_scored: aggregates.avg_goals_scored,
        avg_goals_conceded: aggregates.avg_goals_conceded,
        avg_xg_for: aggregates.avg_xg_for,
        avg_xg_against: aggregates.avg_xg_against,
        form_last_five: aggregates.form_last_five,
        form_trend: aggregates.form_trend,
        stats_period_start: CYCLE_PERIOD.start,
        stats_period_end: CYCLE_PERIOD.end,
        data_source: 'real',
        last_synced_at: new Date().toISOString()
      })
      .eq('team_name', team.team_name);

    if (updateError) {
      throw new Error(`Error al actualizar agregados de ${team.team_name}: ${updateError.message}`);
    }

    updated += 1;
    console.log(
      `[agregados] ${team.team_name}: ${aggregates.matches_played} partidos, forma ${aggregates.form_last_five}, xG ${aggregates.avg_xg_for ?? 'sin datos'}.`
    );
  }

  console.log(`[agregados] ${updated} equipos recalculados desde team_match_history.`);

  if (pending.length > 0) {
    console.log(
      `[agregados] ${pending.length} equipos conservan datos previos por historial insuficiente (<${MIN_MATCHES_FOR_AGGREGATES} partidos): ${pending.join(', ')}.`
    );
  }

  return coverage;
}

function validateCycleCoverage(teams, coverage) {
  const failures = [];

  for (const team of teams) {
    const matches = coverage.get(team.team_name) ?? 0;

    if (matches < MIN_MATCHES_REQUIRED) {
      failures.push({ team_name: team.team_name, matches });
      console.error(
        `[validación] ERROR: ${team.team_name} solo acumuló ${matches} partidos en el ciclo ${CYCLE_PERIOD.start} → ${CYCLE_PERIOD.end} (mínimo requerido: ${MIN_MATCHES_REQUIRED}). Revisa el alias de mapeo en src/lib/ingestion/team-aliases.ts y scripts/map-teams.js.`
      );
    }
  }

  if (failures.length === 0) {
    console.log(
      `[validación] OK: los ${teams.length} equipos superan el mínimo de ${MIN_MATCHES_REQUIRED} partidos en el ciclo ${CYCLE_PERIOD.start} → ${CYCLE_PERIOD.end}.`
    );
  }

  return failures;
}

async function main() {
  console.log(`Ingesta de datos reales — ciclo ${CYCLE_PERIOD.start} → ${CYCLE_PERIOD.end}`);

  const teams = await loadTeams();
  console.log(`${teams.length} equipos del calendario verificados en team_stats.`);

  const results = [];
  results.push(
    await runSource('football_data', () =>
      ingestMatchHistorySource(createFootballDataProvider(), teams, 'football_data')
    )
  );
  results.push(
    await runSource('open_data', () =>
      ingestMatchHistorySource(createOpenDataProvider(), teams, 'open_data')
    )
  );
  results.push(await runSource('eloratings', () => ingestEloRatings(teams)));

  if (FBREF_ENABLED) {
    results.push(await runSource('fbref', () => ingestFbref(teams)));
  } else {
    console.log('[fbref] desactivado temporalmente (FBREF_INGESTION_ENABLED=true para reactivar).');
  }

  const coverage = await recomputeAggregates(teams);
  const coverageFailures = validateCycleCoverage(teams, coverage);
  const sourceFailures = results.filter((ok) => !ok).length;

  if (sourceFailures === 0 && coverageFailures.length === 0) {
    console.log('Ingesta completada correctamente.');
    process.exit(0);
  }

  if (sourceFailures > 0) {
    console.error(`Ingesta terminada con ${sourceFailures} fuente(s) fallida(s); revisa ingestion_runs.`);
  }

  if (coverageFailures.length > 0) {
    console.error(
      `Ingesta terminada con ${coverageFailures.length} equipo(s) por debajo del mínimo de ${MIN_MATCHES_REQUIRED} partidos: ${coverageFailures.map((f) => `${f.team_name} (${f.matches})`).join(', ')}.`
    );
  }

  process.exit(1);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
