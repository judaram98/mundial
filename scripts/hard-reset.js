import { createClient } from '@supabase/supabase-js';
import { execSync } from 'child_process';

const supabaseUrl = process.env.SUPABASE_URL || process.env.PUBLIC_SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error('Error: Las credenciales de Supabase no están configuradas en el entorno (.env).');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

async function hardReset() {
  console.log('Iniciando HARD RESET de la base de datos...');
  
  const tables = ['matches', 'team_stats', 'team_match_history', 'team_elo_history', 'ingestion_runs'];
  
  for (const table of tables) {
    console.log(`Purgando tabla: ${table}...`);
    if (table === 'team_stats') {
      const { error } = await supabase.from(table).delete().neq('team_name', 'INVALID_TEAM_NAME_FOR_PURGE');
      if (error) console.error(`Error purgando ${table}:`, error.message);
    } else {
      const { error } = await supabase.from(table).delete().neq('id', -1);
      if (error) console.error(`Error purgando ${table}:`, error.message);
    }
  }
  
  console.log('Todas las tablas han sido purgadas.');
  
  console.log('Iniciando re-seed con los 48 equipos reales...');
  try {
    execSync('node --env-file=.env scripts/seed.js', { stdio: 'inherit' });
    console.log('Seed completado exitosamente.');
  } catch (err) {
    console.error('Error durante la ejecución del seed:', err.message);
    process.exit(1);
  }
}

hardReset();
