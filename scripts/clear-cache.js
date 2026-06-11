import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error('Error: Las credenciales de Supabase no están configuradas en el entorno (.env).');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

async function clearCache() {
  console.log('Iniciando limpieza de la caché de predicciones...');

  const { data, error } = await supabase
    .from('matches')
    .update({ prediction_cache: null })
    .not('prediction_cache', 'is', null);

  if (error) {
    console.error('Error al limpiar la caché:', error.message);
    process.exit(1);
  }

  console.log('Caché de predicciones limpiada exitosamente para todos los partidos.');
}

clearCache();
