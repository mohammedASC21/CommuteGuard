import { setTimeout } from 'node:timers/promises';
import { createHistoryBackend } from '../src/lib/history/backend.js';
import { SupabaseObservationHistory } from '../src/lib/history/supabase-history.js';
import { CommuteDecisionService, createMtaCommuteSource, DEFAULT_COMMUTE } from '../src/lib/commute/index.js';
import { collectScheduled } from '../src/lib/collector/collector.js';
import { SupabaseNotificationStore } from '../src/lib/notifications/store.js';
import { createPushSender } from '../src/lib/notifications/sender.js';
import { localWorkerTick } from '../src/lib/notifications/worker.js';
try {
  if (process.env.NODE_ENV === 'production') throw Error();
  const history = createHistoryBackend(process.env);
  if (history.backend !== 'SUPABASE' || !(history.store instanceof SupabaseObservationHistory)) throw Error();
  const source = createMtaCommuteSource({ apiKey:process.env.MTA_BUS_TIME_API_KEY ?? '', routeId:DEFAULT_COMMUTE.target.routeId, stopId:'103617', directionId:'1' });
  const clock = () => new Date().toISOString();
  const service = new CommuteDecisionService({ history:history.store, source, clock });
  const store = new SupabaseNotificationStore(process.env), send = createPushSender(process.env);
  await store.settings();
  let stopping = false;
  const abort = new AbortController();
  for (const signal of ['SIGINT','SIGTERM'] as const) process.on(signal, () => { stopping = true; abort.abort(); });
  console.log('Local scheduler running. Mac must remain awake. Monday/Wednesday; saved New York departure; no cloud Cron.');
  while (!stopping) {
    try {
      const result = await localWorkerTick({ store,scope:history.scope,clock,service,send,
        collect:(schedule,now) => collectScheduled({ scope:history.scope, history:history.store as SupabaseObservationHistory,source,schedule,clock },now) });
      if (result !== 'WAITING' && result !== 'ALREADY_CLAIMED_OR_CHANGED') console.log(result);
    } catch { console.error('LOCAL_SCHEDULER_TICK_FAILED: sensitive details omitted.'); }
    try { await setTimeout(5000,undefined,{signal:abort.signal}); } catch { /* shutdown */ }
  }
} catch { console.error('LOCAL_SCHEDULER_UNAVAILABLE: check migration, Supabase and VAPID configuration.'); process.exitCode=1; }
