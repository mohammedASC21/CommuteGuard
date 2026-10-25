import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { DEMO_TIMING, demoPlan, runDemoOccurrence, waitForDemo, requireDemoDevelopment, type DemoDependencies } from '../src/lib/notifications/demo.js';
import type { NotificationStore } from '../src/lib/notifications/store.js';
import { SupabaseNotificationStore } from '../src/lib/notifications/store.js';
import type { Subscription, PushMessage } from '../src/lib/notifications/model.js';
import { departurePlan } from '../src/lib/notifications/model.js';
import { localWorkerTick } from '../src/lib/notifications/worker.js';
import { CommuteDecisionService, DEFAULT_COMMUTE, InMemoryObservationHistory } from '../src/lib/commute/index.js';
import type { ObservationHistoryStore } from '../src/lib/commute/types.js';
import { batch } from './fixtures/reliability/current-trip.js';
import { migratedDb, sqlRest } from './helpers/persistent-db.js';
import { SupabaseObservationHistory } from '../src/lib/history/supabase-history.js';
import { commuteScope } from '../src/lib/history/scope.js';
import { createCommuteHandler } from '../src/server/commute-handler.js';
const START='2026-10-25T13:56:30.000Z'; // Sunday, 09:56:30 New York; saved departure 10:00
const subscription:Subscription={endpoint:'https://fcm.googleapis.com/fcm/send/FAKE_DEMO',keys:{p256dh:'B'+'a'.repeat(86),auth:'a'.repeat(22)}};
function harness(history:ObservationHistoryStore=new InMemoryObservationHistory()) {
  let now=Date.parse(START),departure='10:00',attempts=0,reads=0;
  const claims=new Set<string>(),results=new Map<string,string>(),messages:PushMessage[]=[],logs:string[]=[],waits:number[]=[];
  const store:NotificationStore={settings:async()=>{reads++;return {departure_time:departure,timezone:'America/New_York',updated_at:START};},
    saveTime:async t=>{departure=t;},subscription:async()=>subscription,saveSubscription:async()=>{},removeSubscription:async()=>{},heartbeat:async()=>{},
    claim:async(id,t)=>{if(t!==departure||claims.has(id))return false;claims.add(id);return true;},finish:async(id,result)=>{results.set(id,result);}};
  const clock=()=>new Date(now).toISOString();
  function sourceBatch(index:number,context:'vehicle'|'stop') {
    const b=batch(index,context);b.responseTimestamp=clock();b.deliveries=[{responseTimestamp:clock(),validUntil:new Date(now+60000).toISOString()}];
    const o=b.observations[0]!;o.timestamp=new Date(now-1000).toISOString();o.serviceDate='2026-10-25';o.routeId=DEFAULT_COMMUTE.target.routeId;
    o.staticAssignment={directionId:'1',destinationId:'MTA_101530',destinationName:DEFAULT_COMMUTE.destination};o.monitoredCall!.staticReference.stopId=DEFAULT_COMMUTE.target.stopId;
    return b;
  }
  const source={vehicleMonitoring:async()=>sourceBatch(attempts++,'vehicle'),stopMonitoring:async()=>sourceBatch(attempts-1,'stop')};
  const service=new CommuteDecisionService({history,source,clock});
  const deps:DemoDependencies={store,service,clock,scope:commuteScope(DEFAULT_COMMUTE),sleep:async ms=>{waits.push(ms);now+=ms;},send:async(_,m)=>{messages.push(m);},log:line=>logs.push(line)};
  return {deps,store,service,source,history,messages,logs,waits,claims,results,clock,sourceBatch,setNow:(at:string)=>{now=Date.parse(at);},setDeparture:(t:string)=>{departure=t;},attempts:()=>attempts,reads:()=>reads};
}
test('demo Sunday plan uses saved New York departure and centralized seven/30 timing',()=>{
  const p=demoPlan(START,'10:00','scope');assert.equal(p.ready,true);assert.equal(p.departure,'2026-10-25T14:00:00.000Z');assert.equal(p.start,START);
  assert.equal(DEMO_TIMING.observations,7);assert.equal(DEMO_TIMING.intervalSeconds,30);assert.match(p.occurrence,/^demo:v1:/);
});
test('demo refuses production while normal Sunday plan remains ineligible',async()=>{
  assert.throws(()=>requireDemoDevelopment({NODE_ENV:'production'}));assert.doesNotThrow(()=>requireDemoDevelopment({NODE_ENV:'development'}));
  assert.equal(departurePlan(START,'10:00','scope').collect,false);
  const h=harness();let collected=0;
  assert.equal(await localWorkerTick({...h.deps,store:h.store,collect:async()=>{collected++;}}),'WAITING');assert.equal(collected,0);assert.equal(h.attempts(),0);
});
test('exactly seven existing-service ingestion cycles, six paced waits and one genuine assessment push',async()=>{
  const h=harness();const result=await runDemoOccurrence(h.deps,demoPlan(h.clock(),'10:00',h.deps.scope));
  assert.equal(result,'SENT');assert.equal(h.attempts(),7);assert.deepEqual(h.waits,Array(6).fill(30000));
  const saved=await h.history.getRecent(h.clock());assert.equal(saved.length,7);assert.ok(saved.every(f=>f.acquisitionId));
  const decision=await h.service.assess();assert.equal(decision.primaryLeg.status,'VERIFIED');assert.equal(h.messages.length,1);
  assert.equal(h.messages[0]!.body,'Use the normal Bx28 route.');
  assert.ok(h.logs.indexOf('\nAssessing recent evidence...')<h.logs.indexOf('\nSending push notification...'));
});
test('waiting demo discovers changed departure without restart',async()=>{
  const h=harness();h.setNow('2026-10-25T13:55:00Z');
  const sleep=h.deps.sleep;let first=true;
  h.deps.sleep=async ms=>{if(first){first=false;h.setDeparture('10:15');h.setNow('2026-10-25T14:11:30Z');}else await sleep(ms);};
  assert.equal(await waitForDemo(h.deps),'SENT');assert.ok(h.reads()>=2);assert.equal(h.attempts(),7);
  assert.ok(h.logs.some(line=>line.includes('10:15:00 AM')));assert.ok([...h.claims][0]!.endsWith(':10:15'));
});
test('late start does not rush seven requests; saved departure identifies a future occurrence',async()=>{
  const h=harness();h.setNow('2026-10-25T13:58:00Z');const plan=demoPlan(h.clock(),'10:00',h.deps.scope);
  assert.equal(plan.missed,true);assert.equal(await runDemoOccurrence(h.deps,plan),'OUTSIDE_DEMO_START');assert.equal(h.attempts(),0);
  h.setNow('2026-10-25T14:01:00Z');assert.equal(demoPlan(h.clock(),'10:00',h.deps.scope).departure,'2026-10-26T14:00:00.000Z');
});
test('completed occurrence does not collect or notify again on restart',async()=>{
  const h=harness();const plan=demoPlan(h.clock(),'10:00',h.deps.scope);await runDemoOccurrence(h.deps,plan);
  h.setNow(START);assert.equal(await runDemoOccurrence({...h.deps},plan),'ALREADY_CLAIMED_OR_CHANGED');assert.equal(h.attempts(),7);assert.equal(h.messages.length,1);
});
test('new future departure is a separate demo occurrence',()=>{
  assert.notEqual(demoPlan(START,'10:00','s').occurrence,demoPlan(START,'10:15','s').occurrence);
  assert.notEqual(demoPlan(START,'10:00','s').occurrence,departurePlan(START,'10:00','s').occurrence);
});
test('abort between observations stops the run without a push and preserves acquired history',async()=>{
  const h=harness(),abort=new AbortController();h.deps.signal=abort.signal;h.deps.sleep=async()=>abort.abort();
  await assert.rejects(()=>runDemoOccurrence(h.deps,demoPlan(h.clock(),'10:00',h.deps.scope)));
  assert.equal(h.attempts(),1);assert.equal(h.messages.length,0);assert.equal((await h.history.getRecent(h.clock())).length,1);assert.equal([...h.results.values()][0],'FAILED');
});
test('real absent-source evidence is not forced VERIFIED',async()=>{
  const h=harness();h.source.vehicleMonitoring=async()=>{const b=h.sourceBatch(0,'vehicle');b.observations=[];return b;};h.source.stopMonitoring=async()=>{const b=h.sourceBatch(0,'stop');b.observations=[];return b;};
  await runDemoOccurrence(h.deps,demoPlan(h.clock(),'10:00',h.deps.scope));
  assert.equal(h.messages[0]!.title,'CommuteGuard — Bx28 Unverified');assert.equal(h.messages[0]!.body,'Walk to the D train.');
});
for(const status of ['VERIFIED','UNVERIFIED','HIGH_GHOST_RISK'] as const)test(`demo forwards assessed ${status} notification exactly once`,async()=>{
  const h=harness();const assess=h.service.assess.bind(h.service);
  // Transport mapping only; the separate genuine-engine tests establish classification.
  h.deps.service={ingestLive:()=>h.service.ingestLive(),assess:async()=>{const d=await assess();return {...d,primaryLeg:{...d.primaryLeg,status}};}};
  await runDemoOccurrence(h.deps,demoPlan(h.clock(),'10:00',h.deps.scope));
  assert.equal(h.messages.length,1);assert.equal(h.messages[0]!.title,`CommuteGuard — Bx28 ${status==='VERIFIED'?'Verified':status==='HIGH_GHOST_RISK'?'Warning':'Unverified'}`);
});
test('database dedup survives recreation and real demo history is shared with fresh web assessment',async()=>{
  const db=await migratedDb();try{
    await db.exec(await readFile('supabase/migrations/202610250001_local_notifications.sql','utf8'));
    await db.query('select cg_save_departure($1)',['10:00']);
    const scope=commuteScope(DEFAULT_COMMUTE,'demo_regression');
    const history=()=>new SupabaseObservationHistory({url:'https://offline.example',secretKey:'sb_secret_FAKE',scope},sqlRest(db));
    const h=harness(history());h.deps.scope=scope;
    const env={SUPABASE_URL:'https://offline.example',SUPABASE_SECRET_KEY:'sb_secret_FAKE',COMMUTEGUARD_HISTORY_BACKEND:'supabase'};
    const fetcher:typeof fetch=async(_,init)=>{
      const p=JSON.parse(String(init?.body));
      const r=await db.query<{ok:boolean}>('select cg_claim_notification($1,$2) as ok',[p.p_occurrence,p.p_departure]);return Response.json(r.rows[0]!.ok);
    };
    h.deps.store.claim=(id,t)=>new SupabaseNotificationStore(env,fetcher).claim(id,t);
    const plan=demoPlan(h.clock(),'10:00',scope);await runDemoOccurrence(h.deps,plan);
    const before=await h.service.assess();assert.equal(before.primaryLeg.status,'VERIFIED');
    const stored=await history().getRecent(h.clock());assert.equal(stored.length,7);
    const last=stored.at(-1)!;h.setNow(new Date(Date.parse(h.clock())+5000).toISOString());
    const duplicate=structuredClone(last);
    for(const b of [duplicate.vm!,duplicate.sm!]){b.responseTimestamp=h.clock();b.deliveries=[{responseTimestamp:h.clock(),validUntil:new Date(Date.parse(h.clock())+60000).toISOString()}];}
    const web=new CommuteDecisionService({history:history(),clock:h.clock,source:{vehicleMonitoring:async()=>duplicate.vm!,stopMonitoring:async()=>duplicate.sm!}});
    const response=await createCommuteHandler(()=>web)();const decision=await response.json();
    assert.equal(decision.primaryLeg.status,'VERIFIED');assert.equal(decision.primaryLeg.evidence.framesRetained,8);
    assert.equal(decision.primaryLeg.evidence.distinctCurrentTripObservations,7);assert.equal(decision.primaryLeg.evidence.progressingObservations,6);
    h.setNow(START);assert.equal(await runDemoOccurrence({...h.deps},plan),'ALREADY_CLAIMED_OR_CHANGED');assert.equal(h.messages.length,1);
  }finally{await db.close();}
});
