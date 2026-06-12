import { createClient } from '@supabase/supabase-js';
import { buildDeterministicReport } from '../src/lib/prediction-engine.js';
import { requestConsensus } from '../src/pages/api/predict.js';
import { buildTournamentFeedback } from '../src/lib/feedback-loop.js';

const supabaseUrl = process.env.PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error('Error: Las credenciales de Supabase no están configuradas en el entorno (.env).');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function precompute() {
  const { data: matches, error: matchesError } = await supabase
    .from('matches')
    .select('*')
    .eq('status', 'pending')
    .is('prediction_cache', null)
    .order('date', { ascending: true });

  if (matchesError) {
    console.error('Error al consultar partidos pendientes:', matchesError.message);
    process.exit(1);
  }

  if (!matches || matches.length === 0) {
    console.log('No hay partidos pendientes por precomputar.');
    return;
  }

  console.log(`Iniciando precomputación para ${matches.length} partidos...`);

  const { data: stats, error: statsError } = await supabase.from('team_stats').select('*');

  if (statsError || !stats) {
    console.error('Error al cargar las estadísticas de los equipos:', statsError?.message);
    process.exit(1);
  }

  const statsMap = new Map();
  for (const stat of stats) {
    statsMap.set(stat.team_name, stat);
  }

  for (let i = 0; i < matches.length; i++) {
    const match = matches[i];
    console.log(`Precomputando partido ${i + 1} de ${matches.length}... (${match.home_team} vs ${match.away_team})`);

    const homeStats = statsMap.get(match.home_team);
    const awayStats = statsMap.get(match.away_team);

    if (!homeStats || !awayStats) {
      console.error(`Error: Estadísticas no encontradas para el partido ${match.id}`);
      continue;
    }

    const deterministicReport = buildDeterministicReport(homeStats, awayStats);

    const matchContext = {
      partido: {
        fecha: match.date,
        equipo_local: match.home_team,
        equipo_visitante: match.away_team
      },
      ciclo_estadistico: {
        inicio: homeStats.stats_period_start,
        fin: homeStats.stats_period_end,
        data_source: homeStats.data_source
      },
      estadisticas_local: homeStats,
      estadisticas_visitante: awayStats,
      calculos_deterministas: deterministicReport
    };

    const tournamentFeedback = await buildTournamentFeedback(
      match.home_team,
      match.away_team
    ).catch(() => null);

    if (tournamentFeedback) {
      console.log(`↺ Lecciones del torneo aplicadas al partido ${match.id}.`);
    }

    try {
      const { prediction, failure } = await requestConsensus(
        matchContext,
        match.home_team,
        match.away_team,
        tournamentFeedback
      );

      if (!prediction) {
        console.error(`Validación estricta fallida para el partido ${match.id}: ${failure}`);
        continue;
      }

      const cacheEntry = {
        prediction,
        motor_determinista: deterministicReport,
        generado_en: new Date().toISOString()
      };

      const { error: updateError } = await supabase
        .from('matches')
        .update({ prediction_cache: cacheEntry })
        .eq('id', match.id);

      if (updateError) {
        console.error(`Error al guardar en caché el partido ${match.id}:`, updateError.message);
      } else {
        console.log(`✅ Partido ${match.id} (${match.home_team} vs ${match.away_team}) precomputado y guardado exitosamente.`);
      }
    } catch (err) {
      console.error(`Excepción no manejada en el partido ${match.id}:`, err);
    }

    if (i < matches.length - 1) {
      await delay(4000);
    }
  }

  console.log('🏁 Precomputación finalizada para todos los partidos.');
}

precompute();
