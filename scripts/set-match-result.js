import { createClient } from '@supabase/supabase-js';

const FINISHED_STATUS = 'finished';

function printUsage() {
  console.error('Uso: npm run set-result -- "<Equipo Local>" "<Equipo Visitante>" <Goles Local> <Goles Visitante>');
  console.error('Ejemplo: npm run set-result -- "México" "Polonia" 2 1');
}

function parseArguments(argv) {
  const args = argv.slice(2);

  if (args.length !== 4) {
    console.error(`Se esperaban 4 argumentos y se recibieron ${args.length}.`);
    printUsage();
    process.exit(1);
  }

  const [homeTeam, awayTeam, rawHomeScore, rawAwayScore] = args.map((arg) => arg.trim());

  if (!homeTeam || !awayTeam) {
    console.error('Los nombres de los equipos no pueden estar vacíos.');
    printUsage();
    process.exit(1);
  }

  if (homeTeam === awayTeam) {
    console.error('El equipo local y el visitante no pueden ser el mismo.');
    process.exit(1);
  }

  const homeScore = parseScore(rawHomeScore, 'Goles Local');
  const awayScore = parseScore(rawAwayScore, 'Goles Visitante');

  return { homeTeam, awayTeam, homeScore, awayScore };
}

function parseScore(value, label) {
  if (!/^\d+$/.test(value)) {
    console.error(`${label} debe ser un número entero mayor o igual a 0 (se recibió "${value}").`);
    printUsage();
    process.exit(1);
  }

  return Number(value);
}

function createSupabaseClient() {
  const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    console.error('Faltan las variables de entorno SUPABASE_URL y SUPABASE_SERVICE_ROLE_KEY.');
    process.exit(1);
  }

  return createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false }
  });
}

async function findMatch(supabase, homeTeam, awayTeam) {
  const { data, error } = await supabase
    .from('matches')
    .select('id, date, home_team, away_team, status, home_score, away_score')
    .eq('home_team', homeTeam)
    .eq('away_team', awayTeam)
    .order('date', { ascending: true });

  if (error) {
    throw new Error(`Error al buscar el partido: ${error.message}`);
  }

  if (!data || data.length === 0) {
    throw new Error(
      `No se encontró ningún partido "${homeTeam}" vs "${awayTeam}". Verifica que los nombres coincidan exactamente con la base de datos.`
    );
  }

  return data.find((match) => match.status !== FINISHED_STATUS) ?? data[0];
}

async function setMatchResult(supabase, match, homeScore, awayScore) {
  const { data, error } = await supabase
    .from('matches')
    .update({ home_score: homeScore, away_score: awayScore, status: FINISHED_STATUS })
    .eq('id', match.id)
    .select('id, home_team, away_team, home_score, away_score, status')
    .single();

  if (error) {
    throw new Error(`Error al actualizar el partido: ${error.message}`);
  }

  return data;
}

async function main() {
  const { homeTeam, awayTeam, homeScore, awayScore } = parseArguments(process.argv);
  const supabase = createSupabaseClient();

  const match = await findMatch(supabase, homeTeam, awayTeam);

  if (match.status === FINISHED_STATUS) {
    console.log(
      `Aviso: el partido ya estaba finalizado con marcador ${match.home_score}-${match.away_score}. Se sobrescribirá el resultado.`
    );
  }

  const updated = await setMatchResult(supabase, match, homeScore, awayScore);

  console.log(
    `Resultado registrado: ${updated.home_team} ${updated.home_score} - ${updated.away_score} ${updated.away_team} (status: ${updated.status}).`
  );
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
