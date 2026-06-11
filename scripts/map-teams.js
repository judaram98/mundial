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

const TEAM_IDENTIFIERS = {
  'México': { api_football_team_id: 16, eloratings_team_name: 'Mexico', fbref_team_id: 'b009a548' },
  'Sudáfrica': { api_football_team_id: 1531, eloratings_team_name: 'South Africa', fbref_team_id: '506f1741' },
  'República de Corea': { api_football_team_id: 17, eloratings_team_name: 'South Korea', fbref_team_id: '473f0fbf' },
  'Canadá': { api_football_team_id: 5529, eloratings_team_name: 'Canada', fbref_team_id: '9c6d90a0' },
  'Marruecos': { api_football_team_id: 31, eloratings_team_name: 'Morocco', fbref_team_id: 'af41ccda' },
  'Ecuador': { api_football_team_id: 2382, eloratings_team_name: 'Ecuador', fbref_team_id: '123acaf8' },
  'Austria': { api_football_team_id: 775, eloratings_team_name: 'Austria', fbref_team_id: 'd5121f10' },
  'Estados Unidos': { api_football_team_id: 2384, eloratings_team_name: 'United States', fbref_team_id: '0f66725b' },
  'Japón': { api_football_team_id: 12, eloratings_team_name: 'Japan', fbref_team_id: 'ffcf1690' },
  'Noruega': { api_football_team_id: 1090, eloratings_team_name: 'Norway', fbref_team_id: '599eba19' },
  'Ghana': { api_football_team_id: 1504, eloratings_team_name: 'Ghana', fbref_team_id: '9349828d' },
  'Argentina': { api_football_team_id: 26, eloratings_team_name: 'Argentina', fbref_team_id: 'f9fddd6e' },
  'Senegal': { api_football_team_id: 13, eloratings_team_name: 'Senegal', fbref_team_id: '9ab5c684' },
  'Suiza': { api_football_team_id: 15, eloratings_team_name: 'Switzerland', fbref_team_id: '81021a70' },
  'Jordania': { api_football_team_id: 1548, eloratings_team_name: 'Jordan', fbref_team_id: '3e22f0fa' },
  'Francia': { api_football_team_id: 2, eloratings_team_name: 'France', fbref_team_id: null },
  'Túnez': { api_football_team_id: 28, eloratings_team_name: 'Tunisia', fbref_team_id: null },
  'Uruguay': { api_football_team_id: 7, eloratings_team_name: 'Uruguay', fbref_team_id: null },
  'Nueva Zelanda': { api_football_team_id: null, eloratings_team_name: 'New Zealand', fbref_team_id: null },
  'Brasil': { api_football_team_id: 6, eloratings_team_name: 'Brazil', fbref_team_id: null },
  'Croacia': { api_football_team_id: 3, eloratings_team_name: 'Croatia', fbref_team_id: null },
  'RI de Irán': { api_football_team_id: 22, eloratings_team_name: 'Iran', fbref_team_id: null },
  'Panamá': { api_football_team_id: 11, eloratings_team_name: 'Panama', fbref_team_id: null },
  'Inglaterra': { api_football_team_id: 10, eloratings_team_name: 'England', fbref_team_id: null },
  'Argelia': { api_football_team_id: null, eloratings_team_name: 'Algeria', fbref_team_id: null },
  'Australia': { api_football_team_id: 20, eloratings_team_name: 'Australia', fbref_team_id: null },
  'Curazao': { api_football_team_id: null, eloratings_team_name: 'Curaçao', fbref_team_id: null },
  'España': { api_football_team_id: 9, eloratings_team_name: 'Spain', fbref_team_id: null },
  'Egipto': { api_football_team_id: 32, eloratings_team_name: 'Egypt', fbref_team_id: null },
  'Escocia': { api_football_team_id: 1108, eloratings_team_name: 'Scotland', fbref_team_id: null },
  'Arabia Saudí': { api_football_team_id: 23, eloratings_team_name: 'Saudi Arabia', fbref_team_id: null },
  'Portugal': { api_football_team_id: 27, eloratings_team_name: 'Portugal', fbref_team_id: null },
  'Colombia': { api_football_team_id: 8, eloratings_team_name: 'Colombia', fbref_team_id: null },
  'Uzbekistán': { api_football_team_id: null, eloratings_team_name: 'Uzbekistan', fbref_team_id: null },
  'Haití': { api_football_team_id: null, eloratings_team_name: 'Haiti', fbref_team_id: null },
  'Alemania': { api_football_team_id: 25, eloratings_team_name: 'Germany', fbref_team_id: null },
  'Costa de Marfil': { api_football_team_id: null, eloratings_team_name: 'Ivory Coast', fbref_team_id: null },
  'Paraguay': { api_football_team_id: 2380, eloratings_team_name: 'Paraguay', fbref_team_id: null },
  'Catar': { api_football_team_id: 1569, eloratings_team_name: 'Qatar', fbref_team_id: null },
  'Países Bajos': { api_football_team_id: 1118, eloratings_team_name: 'Netherlands', fbref_team_id: null },
  'Cabo Verde': { api_football_team_id: null, eloratings_team_name: 'Cape Verde', fbref_team_id: null },
  'Irak': { api_football_team_id: null, eloratings_team_name: 'Iraq', fbref_team_id: null },
  'Bélgica': { api_football_team_id: 1, eloratings_team_name: 'Belgium', fbref_team_id: null },
  'Turquía': { api_football_team_id: 777, eloratings_team_name: 'Turkey', fbref_team_id: null },
  'Bosnia y Herzegovina': { api_football_team_id: null, eloratings_team_name: 'Bosnia and Herzegovina', fbref_team_id: null },
  'RD Congo': { api_football_team_id: null, eloratings_team_name: 'DR Congo', fbref_team_id: null },
  'República Checa': { api_football_team_id: null, eloratings_team_name: 'Czechia', fbref_team_id: null },
  'Suecia': { api_football_team_id: null, eloratings_team_name: 'Sweden', fbref_team_id: null }
};

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

async function main() {
  const teamNames = await loadTournamentTeamNames();
  console.log(`${teamNames.length} equipos detectados en data/world_cup_2026.json.`);

  const unmapped = teamNames.filter((name) => !TEAM_IDENTIFIERS[name]);

  if (unmapped.length > 0) {
    console.error(`Equipos sin identificadores en el diccionario: ${unmapped.join(', ')}.`);
    process.exit(1);
  }

  const tournamentNames = new Set(teamNames);
  const staleEntries = Object.keys(TEAM_IDENTIFIERS).filter((name) => !tournamentNames.has(name));

  if (staleEntries.length > 0) {
    console.error(`Entradas del diccionario que no están en el calendario: ${staleEntries.join(', ')}.`);
    process.exit(1);
  }

  let updated = 0;
  let withoutApiFootball = 0;
  const missingInDatabase = [];

  for (const name of teamNames) {
    const ids = TEAM_IDENTIFIERS[name];
    const { data, error } = await supabase
      .from('team_stats')
      .update(ids)
      .eq('team_name', name)
      .select('team_name');

    if (error) {
      throw new Error(`Error al actualizar ${name}: ${error.message}`);
    }

    if (!data || data.length === 0) {
      missingInDatabase.push(name);
      continue;
    }

    if (ids.api_football_team_id == null) {
      withoutApiFootball += 1;
    }

    console.log(
      `${name} → eloratings: ${ids.eloratings_team_name}, api_football: ${ids.api_football_team_id ?? 'pendiente'}, fbref: ${ids.fbref_team_id ?? 'pendiente'}`
    );
    updated += 1;
  }

  if (missingInDatabase.length > 0) {
    console.error(`Equipos no encontrados en team_stats: ${missingInDatabase.join(', ')}.`);
    process.exit(1);
  }

  console.log(`Mapeo completado: ${updated} equipos actualizados en team_stats.`);

  if (withoutApiFootball > 0) {
    console.log(
      `${withoutApiFootball} equipos quedan sin api_football_team_id verificado; se completarán cuando exista API_FOOTBALL_KEY.`
    );
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
