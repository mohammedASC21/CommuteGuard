import { setTimeout } from 'node:timers/promises';
import { createHistoryBackend } from '../src/lib/history/backend.js';
import { SupabaseObservationHistory } from '../src/lib/history/supabase-history.js';
import { CommuteDecisionService, createMtaCommuteSource, DEFAULT_COMMUTE } from '../src/lib/commute/index.js';
import { SupabaseNotificationStore } from '../src/lib/notifications/store.js';
import { createPushSender } from '../src/lib/notifications/sender.js';
import { requireDemoDevelopment, waitForDemo } from '../src/lib/notifications/demo.js';
const abort=new AbortController();
for(const signal of ['SIGINT','SIGTERM'] as const)process.on(signal,()=>abort.abort());
try {
  requireDemoDevelopment(process.env);
  const history=createHistoryBackend(process.env);
  if(history.backend!=='SUPABASE'||!(history.store instanceof SupabaseObservationHistory))throw Error('SUPABASE_REQUIRED');
  const source=createMtaCommuteSource({apiKey:process.env.MTA_BUS_TIME_API_KEY??'',routeId:DEFAULT_COMMUTE.target.routeId,
    stopId:DEFAULT_COMMUTE.target.stopId.replace(/^MTA_/,''),directionId:DEFAULT_COMMUTE.target.directionId});
  const clock=()=>new Date().toISOString();
  const service=new CommuteDecisionService({history:history.store,source,clock});
  const store=new SupabaseNotificationStore(process.env),send=createPushSender(process.env);
  const secrets=[process.env.MTA_BUS_TIME_API_KEY,process.env.SUPABASE_SECRET_KEY,process.env.SUPABASE_SERVICE_ROLE_KEY,process.env.VAPID_PRIVATE_KEY].filter((s):s is string=>!!s);
  const log=(line:string)=>{for(const secret of secrets)line=line.replaceAll(secret,'[REDACTED]');console.log(line);};
  log('COMMUTEGUARD LOCAL DEMO\n-----------------------\nAny-day local demonstration. Real MTA evidence and classifier.\nKeep Mac awake. Stop the normal local worker before recording.\nCtrl+C stops; use a new future departure to re-run an interrupted occurrence.');
  await waitForDemo({store,service,send,scope:history.scope,clock,signal:abort.signal,log,
    sleep:milliseconds=>setTimeout(milliseconds,undefined,{signal:abort.signal})});
} catch {
  if(abort.signal.aborted)console.log('\nDemo stopped. No further notification will be attempted.');
  else {console.error('LOCAL_DEMO_UNAVAILABLE: check saved settings, Supabase, MTA and VAPID configuration. Sensitive details omitted.');process.exitCode=1;}
}
