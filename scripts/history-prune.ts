import { createHistoryBackend } from '../src/lib/history/backend.js';
import { SupabaseObservationHistory } from '../src/lib/history/supabase-history.js';
const binding = createHistoryBackend(process.env);
try {
  if (!(binding.store instanceof SupabaseObservationHistory)) throw new Error();
  await binding.store.prune();
  console.log(`History backend: SUPABASE; expired rows pruned for active scope: ${binding.scope}`);
} catch { console.error('HISTORY_PRUNE_UNAVAILABLE: configure Supabase and apply the migration. Sensitive details omitted.'); process.exitCode = 1; }
