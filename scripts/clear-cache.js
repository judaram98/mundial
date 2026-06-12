import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error('Error: Las credenciales de Supabase no están configuradas en el entorno (.env).');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

async function countPreservedCaches() {
  const { count, error } = await supabase
    .from('matches')
    .select('id', { count: 'exact', head: true })
    .eq('status', 'finished')
    .not('prediction_cache', 'is', null);

  if (error) {
    throw new Error(`Error al contar las predicciones preservadas: ${error.message}`);
  }

  return count ?? 0;
}

async function clearPendingCaches() {
  const { data, error } = await supabase
    .from('matches')
    .update({ prediction_cache: null })
    .neq('status', 'finished')
    .not('prediction_cache', 'is', null)
    .select('id');

  if (error) {
    throw new Error(`Error al limpiar la caché: ${error.message}`);
  }

  return data?.length ?? 0;
}

async function clearCache() {
  console.log('Iniciando limpieza selectiva de la caché de predicciones...');

  const preserved = await countPreservedCaches();
  const cleared = await clearPendingCaches();

  console.log(`Partidos limpiados: ${cleared} (status distinto de 'finished', volverán a predecirse con el bucle de retroalimentación).`);
  console.log(`Partidos preservados: ${preserved} (finalizados, conservan su prediction_cache para el historial de aciertos).`);
}

clearCache().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
