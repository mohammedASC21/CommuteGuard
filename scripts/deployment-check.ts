import { checkProductionEnvironment } from '../src/lib/deployment/config.js';
const result = checkProductionEnvironment(process.env);
console.log(JSON.stringify({ deploymentConfiguration: result.ready ? 'PASS' : 'USER_ACTION_REQUIRED', ...result }, null, 2));
process.exitCode = result.ready ? 0 : 1;
