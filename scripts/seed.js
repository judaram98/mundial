import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('Faltan las variables de entorno SUPABASE_URL y SUPABASE_SERVICE_ROLE_KEY.');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false }
});

async function loadSeedData() {
  const filePath = resolve(process.cwd(), 'data', 'world_cup_2026.json');
  const raw = await readFile(filePath, 'utf-8');
  return JSON.parse(raw);
}

async function seedTeamStats(teams) {
  const rows = teams.map((team) => ({
    team_name: team.team_name,
    elo: team.elo,
    elo_cycle_start: team.elo_cycle_start,
    avg_goals_scored: team.avg_goals_scored,
    avg_goals_conceded: team.avg_goals_conceded,
    avg_xg_for: team.avg_xg_for,
    avg_xg_against: team.avg_xg_against,
    matches_played: team.matches_played,
    wins: team.wins,
    draws: team.draws,
    losses: team.losses,
    form_last_five: team.form_last_five,
    form_trend: team.form_trend,
    stats_period_start: team.stats_period_start,
    stats_period_end: team.stats_period_end,
    data_source: team.data_source
  }));

  const { error } = await supabase
    .from('team_stats')
    .upsert(rows, { onConflict: 'team_name', ignoreDuplicates: true });

  if (error) {
    throw new Error(`Error al poblar team_stats: ${error.message}`);
  }

  return rows.length;
}

const PLACEHOLDER_PATTERN = /\dº|Ganador|Perdedor|Grupo/;

function isPlaceholderMatch(match) {
  return PLACEHOLDER_PATTERN.test(match.home_team) || PLACEHOLDER_PATTERN.test(match.away_team);
}

function toMatchRow(match) {
  return {
    api_id: match.api_id,
    date: match.date,
    home_team: match.home_team,
    away_team: match.away_team,
    group_name: match.group ?? null,
    matchday: match.matchday ?? null,
    stage: match.stage ?? 'group'
  };
}

async function seedMatches(matches) {
  const resolvedRows = matches.filter((match) => !isPlaceholderMatch(match)).map(toMatchRow);
  const placeholderRows = matches
    .filter(isPlaceholderMatch)
    .map((match) => ({ ...toMatchRow(match), status: 'awaiting_teams' }));

  if (resolvedRows.length > 0) {
    const { error } = await supabase
      .from('matches')
      .upsert(resolvedRows, { onConflict: 'api_id' });

    if (error) {
      throw new Error(`Error al poblar matches: ${error.message}`);
    }

    const { error: promoteError } = await supabase
      .from('matches')
      .update({ status: 'pending' })
      .eq('status', 'awaiting_teams')
      .in('api_id', resolvedRows.map((row) => row.api_id));

    if (promoteError) {
      throw new Error(`Error al habilitar llaves resueltas: ${promoteError.message}`);
    }
  }

  if (placeholderRows.length > 0) {
    const { error } = await supabase
      .from('matches')
      .upsert(placeholderRows, { onConflict: 'api_id' });

    if (error) {
      throw new Error(`Error al poblar llaves pendientes: ${error.message}`);
    }
  }

  return { total: resolvedRows.length + placeholderRows.length, awaiting: placeholderRows.length };
}

async function main() {
  const data = await loadSeedData();
  console.log(`Cargando seed: ${data.tournament} — ${data.stage}`);
  console.log(`Metodología: ${data.stats_methodology.cycle} (${data.stats_methodology.data_source})`);

  const teamCount = await seedTeamStats(data.teams);
  console.log(`team_stats: ${teamCount} equipos insertados/actualizados.`);

  const { total, awaiting } = await seedMatches(data.matches);
  console.log(`matches: ${total} partidos insertados/actualizados (${awaiting} llaves con equipos por definir).`);

  console.log('Seed completado correctamente.');
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
