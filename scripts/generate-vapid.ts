import { open } from 'node:fs/promises';
import webpush from 'web-push';
// Exclusive creation, private permissions; never writes .env.local or logs key values.
try {
  const file = await open('.env.vapid.local','wx',0o600);
  try { const keys = webpush.generateVAPIDKeys(); await file.writeFile(`NEXT_PUBLIC_VAPID_PUBLIC_KEY=${keys.publicKey}\nVAPID_PRIVATE_KEY=${keys.privateKey}\nVAPID_SUBJECT=mailto:replace-with-your-email@example.com\n`); }
  finally { await file.close(); }
  console.log('Created ignored .env.vapid.local with owner-only permissions. Copy its entries privately into .env.local; set VAPID_SUBJECT. Existing files were not overwritten.');
} catch { console.error('VAPID_FILE_NOT_CREATED: target may already exist. No key values displayed.'); process.exitCode=1; }
