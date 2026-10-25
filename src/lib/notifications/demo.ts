import type { CommuteDecisionService } from '../commute/service.js';
import type { NotificationStore } from './store.js';
import type { PushSender } from './sender.js';
import { expiredSubscription } from './sender.js';
import { departureInstant, localDate, notificationFor, validateTime } from './model.js';

export const DEMO_TIMING = Object.freeze({ observations:7, intervalSeconds:30, leadSeconds:210, startGraceSeconds:30, settingsRefreshMilliseconds:5000 });
export function requireDemoDevelopment(env: Readonly<Record<string,string|undefined>>) {
  if (env.NODE_ENV === 'production') throw Error('LOCAL_DEMO_ONLY');
}
/** Separate any-day planning; normal departurePlan and collector schedule are untouched. */
export function demoPlan(now: string, departure: string, scope: string) {
  validateTime(departure);
  const milliseconds = Date.parse(now); if (!Number.isFinite(milliseconds)) throw Error('INVALID_DEMO_CLOCK');
  const today = localDate(now);
  let date = today, end = departureInstant(date,departure);
  if (milliseconds >= end) {
    date = new Date(Date.parse(`${today}T12:00:00Z`)+86400000).toISOString().slice(0,10);
    end = departureInstant(date,departure);
  }
  const start = end-DEMO_TIMING.leadSeconds*1000;
  return { departureTime:departure, departure:new Date(end).toISOString(), start:new Date(start).toISOString(),
    occurrence:`demo:v1:${scope}:${date}:${departure}`,
    ready: milliseconds>=start && milliseconds<=start+DEMO_TIMING.startGraceSeconds*1000,
    missed: milliseconds>start+DEMO_TIMING.startGraceSeconds*1000 };
}
export function demoClockLabel(at: string): string {
  return new Intl.DateTimeFormat('en-US',{timeZone:'America/New_York',hour:'numeric',minute:'2-digit',second:'2-digit'}).format(new Date(at));
}
export interface DemoDependencies {
  store: Pick<NotificationStore,'settings'|'subscription'|'claim'|'finish'|'removeSubscription'>;
  service: Pick<CommuteDecisionService,'ingestLive'|'assess'>;
  scope: string; clock:()=>string; sleep:(milliseconds:number)=>Promise<void>;
  send:PushSender; log:(line:string)=>void; signal?:AbortSignal;
}
function checkAbort(d: DemoDependencies) { if (d.signal?.aborted) throw Error('DEMO_STOPPED'); }
/** A claimed occurrence runs once. Seven real acquisitions; assessment makes no eighth request. */
export async function runDemoOccurrence(d: DemoDependencies, plan: ReturnType<typeof demoPlan>): Promise<string> {
  checkAbort(d);
  const current = demoPlan(d.clock(),plan.departureTime,d.scope);
  if (!current.ready || current.occurrence !== plan.occurrence) return 'OUTSIDE_DEMO_START';
  if (!await d.store.claim(plan.occurrence,plan.departureTime)) return 'ALREADY_CLAIMED_OR_CHANGED';
  let result='FAILED';
  try {
    for(let index=0;index<DEMO_TIMING.observations;index++) {
      checkAbort(d);
      const ingestion=await d.service.ingestLive();
      d.log(`\nObservation ${index+1}/${DEMO_TIMING.observations}`);
      d.log(`VM: ${ingestion.vehicleMonitoring}\nSM: ${ingestion.stopMonitoring}\nStored: ${ingestion.stored?'YES':'NO'}`);
      if(index<DEMO_TIMING.observations-1) {
        // Wait after completion, preventing overlapping calls or catch-up request bursts.
        await d.sleep(DEMO_TIMING.intervalSeconds*1000);
      }
    }
    checkAbort(d);
    d.log('\nAssessing recent evidence...');
    const decision=await d.service.assess();
    const message=notificationFor(decision,plan.occurrence);
    d.log(`\nSTATUS: ${decision.primaryLeg.status}\nRECOMMENDATION: ${message.body}`);
    checkAbort(d);
    const subscription=await d.store.subscription();
    if(!subscription) { result='NO_SUBSCRIPTION'; d.log('\nNOTIFICATION NOT SENT: enable notifications on the website.'); return result; }
    d.log('\nSending push notification...');
    try {
      await d.send(subscription,message);result='SENT';
      d.log('\nNOTIFICATION SENT (push provider accepted; system display is not guaranteed)');
    } catch(error) {
      if(expiredSubscription(error)) await d.store.removeSubscription(subscription.endpoint);
      d.log('\nNOTIFICATION FAILED: check subscription and VAPID settings.');
    }
    d.log('\nDemo complete.');return result;
  } finally { await d.store.finish(plan.occurrence,result); }
}
/** Poll only saved settings while waiting; changing time needs no process restart. */
export async function waitForDemo(d: DemoDependencies): Promise<string> {
  let previous='';
  let blockedOccurrence='';
  while(true) {
    checkAbort(d);
    const settings=await d.store.settings();
    const plan=demoPlan(d.clock(),settings.departure_time,d.scope);
    const identity=`${plan.occurrence}:${plan.missed}`;
    if(identity!==previous) {
      const subscribed=!!await d.store.subscription();
      d.log(`\nSaved departure: ${demoClockLabel(plan.departure)}\nDemo collection start: ${demoClockLabel(plan.start)}\nObservations planned: ${DEMO_TIMING.observations}\nCadence: ${DEMO_TIMING.intervalSeconds} seconds\nRoute: Bx28\nStop: BAINBRIDGE AV/E 206 ST\nNotification: ${subscribed?'ENABLED':'NOT ENABLED'}`);
      d.log(plan.missed?'\nToo late to start seven paced observations. Save a departure at least four minutes ahead.':'\nWaiting for demo collection window...');
      previous=identity;
    }
    if(plan.ready && plan.occurrence!==blockedOccurrence) {
      const result=await runDemoOccurrence(d,plan);
      if(result!=='ALREADY_CLAIMED_OR_CHANGED') return result;
      d.log('\nOccurrence already claimed or departure changed. Save a new future departure for another demo.');
      blockedOccurrence=plan.occurrence;
      // Settings can change between read and claim; keep listening without re-running a claimed occurrence.
      previous=identity;
      await d.sleep(DEMO_TIMING.settingsRefreshMilliseconds);
    } else await d.sleep(DEMO_TIMING.settingsRefreshMilliseconds);
  }
}
