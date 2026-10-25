import { productionSmoke } from '../src/lib/deployment/smoke.js';
if (!process.argv.includes('--live')) {
  console.error('Explicit --live required. This calls the configured public HTTPS deployment; it never bypasses the collection window.'); process.exitCode = 1;
} else {
  try { console.log(JSON.stringify(await productionSmoke(process.env), null, 2)); }
  catch { console.error('PRODUCTION_SMOKE_UNAVAILABLE: verify deployment, environment, HTTPS origin, platform protection and connectivity. Sensitive details omitted.'); process.exitCode = 1; }
}
