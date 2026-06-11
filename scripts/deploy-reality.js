import { execSync } from 'child_process';

const steps = [
  { name: 'Hard Reset (Purga y Seed)', command: 'npm run hard-reset' },
  { name: 'Mapeo de APIs (API IDs y Elo)', command: 'npm run map-teams' },
  { name: 'Ingesta de Datos Reales', command: 'npm run ingest' },
  { name: 'Precomputación de Predicciones', command: 'npm run precompute' }
];

console.log('=============================================');
console.log('🌍 INICIANDO DESPLIEGUE DE REALIDAD MUNDIAL 2026');
console.log('=============================================');

for (let i = 0; i < steps.length; i++) {
  const step = steps[i];
  console.log(`\n▶ [Paso ${i + 1}/${steps.length}]: ${step.name}...`);
  try {
    execSync(step.command, { stdio: 'inherit' });
    console.log(`✅ Paso completado con éxito: ${step.name}`);
  } catch (err) {
    console.error(`\n❌ ERROR CRÍTICO durante el paso: ${step.name}`);
    console.error(err.message);
    process.exit(1);
  }
}

console.log('\n=============================================');
console.log('🎉 DESPLIEGUE FINALIZADO. DATOS 100% REALES INYECTADOS.');
console.log('=============================================');
