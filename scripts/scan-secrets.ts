import { readdir, readFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import { join } from 'node:path';

// Load the ignored environment through the command, never print the credential.
const key = process.env.MTA_BUS_TIME_API_KEY;
if (!key?.trim()) {
  console.error('Secret scan unavailable: server credential is not configured.');
  process.exit(1);
}
const secrets = [key, process.env.VAPID_PRIVATE_KEY, process.env.SUPABASE_SECRET_KEY, process.env.SUPABASE_SERVICE_ROLE_KEY, process.env.COMMUTEGUARD_CRON_SECRET, process.env.VERCEL_TOKEN, process.env.SUPABASE_DB_PASSWORD].filter((s): s is string => !!s);
const variants = secrets.flatMap(value => [value, encodeURIComponent(value), JSON.stringify(value).slice(1, -1)]);
let filesScanned = 0;
let compressedFilesDecompressed = 0;
let credentialFoundOutsideLocalEnvironmentFiles = false;
async function scan(directory: string): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (['node_modules', '.pnpm-store', '.git'].includes(entry.name) || (entry.name.startsWith('.env') && entry.name !== '.env.example')) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await scan(path);
    else if (entry.isFile()) {
      const bytes = await readFile(path);
      const content = entry.name.endsWith('.gz') ? (compressedFilesDecompressed++, gunzipSync(bytes).toString('utf8')) : bytes.toString('utf8');
      filesScanned++;
      if (variants.some(value => content.includes(value))) credentialFoundOutsideLocalEnvironmentFiles = true;
    }
  }
}
try {
  await scan('.');
  console.log(JSON.stringify({ filesScanned, compressedFilesDecompressed, credentialFoundOutsideLocalEnvironmentFiles }));
  process.exitCode = credentialFoundOutsideLocalEnvironmentFiles ? 1 : 0;
} catch {
  console.error('Secret scan failed; file details have been withheld.');
  process.exitCode = 1;
}
