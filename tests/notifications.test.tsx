import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { migratedDb } from './helpers/persistent-db.js';
import { departurePlan, departureInstant, validateTime, validateSubscription, notificationFor, TEST_NOTIFICATION, LOCAL_SCHEDULE } from '../src/lib/notifications/model.js';
import type { Subscription } from '../src/lib/notifications/model.js';
import type { NotificationStore } from '../src/lib/notifications/store.js';
import { SupabaseNotificationStore } from '../src/lib/notifications/store.js';
import { localWorkerTick, type LocalWorkerDependencies } from '../src/lib/notifications/worker.js';
import { requireLocal, localBody } from '../src/server/local-api.js';
import { collectionWindow } from '../src/lib/collector/schedule.js';
import { CommuteDecisionService, InMemoryObservationHistory, DEFAULT_COMMUTE } from '../src/lib/commute/index.js';
import { frames, time, commuteConfiguration } from './fixtures/reliability/current-trip.js';
import { renderToStaticMarkup } from 'react-dom/server';
import React from 'react';
import { CommuteSettings } from '../src/components/commute-settings.js';
const subscription: Subscription = { endpoint:'https://fcm.googleapis.com/fcm/send/FAKE_TEST', keys:{p256dh:'B'+'a'.repeat(86),auth:'a'.repeat(22)} };
function memoryStore() {
  let departure = '10:30'; let sub: Subscription|null = subscription;
  const claims = new Map<string,string>();
  const store: NotificationStore = {
    settings: async () => ({departure_time:departure,timezone:'America/New_York',updated_at:'2026-10-25T00:00:00Z'}),
    saveTime: async t => { departure=validateTime(t); }, subscription:async()=>sub,
    saveSubscription:async s=>{sub=validateSubscription(s);}, removeSubscription:async()=>{sub=null;},
    claim:async(id,t)=>{if(t!==departure||claims.has(id))return false;claims.set(id,'ATTEMPTING');return true;},
    finish:async(id,result)=>{claims.set(id,result);},heartbeat:async()=>{},
  }; return {store,claims};
}
async function harness() {
  const m=memoryStore(); let now='2026-10-26T14:30:00Z';let sent=0,ingested=0,collected=0;
  const engine=new CommuteDecisionService({history:new InMemoryObservationHistory(),clock:()=>time(122),config:commuteConfiguration});
  for(const f of frames())await engine.ingest(f);
  const d:LocalWorkerDependencies={store:m.store,scope:'FIXTURE_SCOPE',clock:()=>now,
    service:{ingestLive:async()=>{ingested++;return {stored:true,vehicleMonitoring:'SUCCEEDED',stopMonitoring:'SUCCEEDED',vehicleObservationCount:1,stopObservationCount:1};},assess:()=>engine.assess()},
    collect:async()=>{collected++;},send:async()=>{sent++;}};
  return {...m,d,setNow:(value:string)=>{now=value;},counts:()=>({sent,ingested,collected})};
}
for (const [departure,start] of [['10:30','14:23'],['11:15','15:08'],['09:45','13:38']]) {
  test(`derived window ${departure} starts seven minutes earlier`,()=>{
    const p=departurePlan('2026-10-26T12:00:00Z',departure!,'s');assert.equal(p.start.slice(11,16),start);
  });
}
test('New York DST uses appropriate offset',()=>{
  assert.equal(new Date(departureInstant('2026-10-26','10:30')).toISOString(),'2026-10-26T14:30:00.000Z');
  assert.equal(new Date(departureInstant('2026-11-02','10:30')).toISOString(),'2026-11-02T15:30:00.000Z');
});
test('native time validation rejects malformed times',()=>{for(const value of ['25:00','10:60','9:00','10:30:00',null,{},''])assert.throws(()=>validateTime(value));});
test('midnight Monday window includes Sunday tail but not unrelated days',()=>{
  const p=departurePlan('2026-10-26T03:58:00Z','00:03','s');assert.equal(p.collect,true);assert.equal(p.start,'2026-10-26T03:56:00.000Z');
  assert.equal(collectionWindow('2026-10-26T03:58:00Z',{...LOCAL_SCHEDULE,departure:'00:03'}).allowed,true);
});
test('worker ignores noncommute days and time before window',async()=>{
  const h=await harness();for(const t of ['2026-10-25T14:30:00Z','2026-10-27T14:25:00Z','2026-10-26T14:22:59Z']){h.setNow(t);assert.equal(await localWorkerTick(h.d),'WAITING');}
  assert.deepEqual(h.counts(),{sent:0,ingested:0,collected:0});
});
test('worker starts collection at derived boundary and discovers changed time without restart',async()=>{
  const h=await harness();h.setNow('2026-10-26T14:23:00Z');assert.equal(await localWorkerTick(h.d),'COLLECTION_TICK');
  await h.store.saveTime('11:00');assert.equal(await localWorkerTick(h.d),'WAITING');
  h.setNow('2026-10-26T14:53:00Z');assert.equal(await localWorkerTick(h.d),'COLLECTION_TICK');
  assert.equal(h.counts().collected,2);
});
test('one send attempt per occurrence including new worker instance',async()=>{
  const h=await harness();assert.equal(await localWorkerTick(h.d),'SENT');
  assert.equal(await localWorkerTick({...h.d}),'ALREADY_CLAIMED_OR_CHANGED');assert.equal(h.counts().sent,1);
});
test('changed departure creates new deterministic occurrence without repeating the old one',async()=>{
  const h=await harness();await localWorkerTick(h.d);await h.store.saveTime('11:00');
  assert.equal(await localWorkerTick(h.d),'WAITING');h.setNow('2026-10-26T15:00:00Z');assert.equal(await localWorkerTick(h.d),'SENT');
  assert.equal(h.claims.size,2);
});
test('failed push never modifies the decision and is not retried on restart',async()=>{
  const h=await harness();h.d.send=async()=>{throw Error('private capability');};
  assert.equal(await localWorkerTick(h.d),'FAILED');assert.equal((await h.d.service.assess()).primaryLeg.status,'VERIFIED');
  assert.equal(await localWorkerTick({...h.d}),'ALREADY_CLAIMED_OR_CHANGED');
});
test('expired push subscription removed safely',async()=>{
  const h=await harness();h.d.send=async()=>{throw {statusCode:410};};await localWorkerTick(h.d);assert.equal(await h.store.subscription(),null);
});
test('stale prior VERIFIED generates backup notification on current reassessment',async()=>{
  const h=await harness();const history=new InMemoryObservationHistory();for(const f of frames())await history.add(f);
  const service=new CommuteDecisionService({history,clock:()=>time(300),config:commuteConfiguration});
  h.d.service.assess=()=>service.assess();let body='';h.d.send=async(_,m)=>{body=m.body;assert.match(m.title,/Unverified/);};
  await localWorkerTick(h.d);assert.equal(body,'Walk to the D train.');
});
for(const status of ['VERIFIED','UNVERIFIED','HIGH_GHOST_RISK'] as const)test(`notification wording ${status}`,async()=>{
  const h=await harness();const d=await h.d.service.assess();d.primaryLeg.status=status;
  const m=notificationFor(d,'occurrence');assert.equal(m.body,status==='VERIFIED'?'Use the normal Bx28 route.':status==='HIGH_GHOST_RISK'?'Repeated warning signs detected. Walk to the D train.':'Walk to the D train.');
  assert.doesNotMatch(JSON.stringify(m),/vehicleId|reasonCodes|Supabase/);
});
test('test notification never claims real transit status',()=>{assert.equal(TEST_NOTIFICATION.title,'CommuteGuard Test');assert.equal(TEST_NOTIFICATION.body,'Local push notifications are working.');assert.doesNotMatch(TEST_NOTIFICATION.body,/VERIFIED|normal Bx28/);});
test('subscription validates providers and keys without SSRF targets',()=>{
  assert.deepEqual(validateSubscription(subscription),subscription);
  for(const endpoint of ['http://fcm.googleapis.com/x','https://localhost/x','https://127.0.0.1/x','https://evil.example/x','https://fcm.googleapis.com.evil.example/x'])assert.throws(()=>validateSubscription({...subscription,endpoint}));
  assert.throws(()=>validateSubscription({...subscription,keys:{auth:'short',p256dh:'short'}}));
});
test('local APIs reject foreign origins, wrong content types and remote hosts',async()=>{
  assert.doesNotThrow(()=>requireLocal(new Request('http://localhost:3000/api/settings',{headers:{origin:'http://localhost:3000','content-type':'application/json'}}),true));
  for(const url of ['https://remote.example/api/settings','http://localhost:3000/api/settings'])assert.throws(()=>requireLocal(new Request(url,{headers:{origin:'https://evil.example','content-type':'application/json'}}),true));
  await assert.rejects(()=>localBody(new Request('http://localhost:3000',{method:'POST',body:'x'.repeat(5000)})));
});
test('settings UI renders without permission prompts or hydration-dependent attributes',()=>{
  const output=renderToStaticMarkup(<CommuteSettings/>);assert.match(output,/type="time"/);assert.match(output,/Enable notifications/);
  assert.match(output,/Monday/);assert.doesNotMatch(output,/VAPID_PRIVATE_KEY/);
});
test('private VAPID sender cannot enter client dependency graph',async()=>{
  const visited=new Set<string>();
  async function visit(path:string){if(visited.has(path))return;visited.add(path);const code=await readFile(path,'utf8');assert.doesNotMatch(code,/VAPID_PRIVATE_KEY|SUPABASE_SECRET_KEY|from ['"]web-push/);const imports=[...code.matchAll(/from ['"]([^'"]+)['"]/g)];for(const m of imports)if(m[1]!.startsWith('.')){const {resolve,dirname}=await import('node:path');let next=resolve(dirname(path),m[1]!);next=next.replace(/\.js$/,'.ts');try{await visit(next);}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')await visit(next.replace(/\.ts$/,'.tsx'));else throw e;}}}
  await visit('src/components/commute-settings.tsx');
});
test('active Bx28 configuration unchanged',()=>{assert.equal(DEFAULT_COMMUTE.route,'Bx28');assert.equal(DEFAULT_COMMUTE.target.stopId,'MTA_103617');assert.equal(DEFAULT_COMMUTE.target.directionId,'1');assert.equal(DEFAULT_COMMUTE.target.isOrigin,false);});

test('real migrated database: settings, subscription, restricted roles, atomic deduplication across instances',async()=>{
  const db:PGlite=await migratedDb();
  try {
    await db.exec(await readFile('supabase/migrations/202610250001_local_notifications.sql','utf8'));
    let row=await db.query<{departure_time:string}>('select departure_time from commute_settings');assert.equal(row.rows[0]!.departure_time,'10:30');
    await db.query('select cg_save_departure($1)',['11:15']);row=await db.query('select departure_time from commute_settings');assert.equal(row.rows[0]!.departure_time,'11:15');
    await assert.rejects(()=>db.query('select cg_save_departure($1)',['99:00']));
    const endpoint=subscription.endpoint;
    await db.query('insert into commute_push_subscription(singleton,endpoint,p256dh,auth) values(true,$1,$2,$3)',[endpoint,subscription.keys.p256dh,subscription.keys.auth]);
    assert.equal((await db.query('select * from commute_push_subscription')).rows.length,1);
    const claim=async()=> (await db.query<{ok:boolean}>('select cg_claim_notification($1,$2) as ok',['s:2026-10-26:11:15','11:15'])).rows[0]!.ok;
    assert.equal(await claim(),true);assert.equal(await claim(),false);
    assert.equal((await db.query<{ok:boolean}>('select cg_claim_notification($1,$2) as ok',['other','10:30'])).rows[0]!.ok,false);
    for(const role of ['anon','authenticated'])assert.equal((await db.query<{ok:boolean}>("select has_table_privilege($1,'public.commute_push_subscription','SELECT') as ok",[role])).rows[0]!.ok,false);
    const fake:typeof fetch=async(input,init)=>{
      const path=new URL(String(input)).pathname;
      if(path.endsWith('cg_save_departure')){await db.query('select cg_save_departure($1)',[JSON.parse(String(init!.body)).p_departure]);return new Response(null,{status:204});}
      if(path.endsWith('commute_settings'))return Response.json((await db.query('select departure_time,timezone,updated_at from commute_settings')).rows);
      throw Error('UNEXPECTED_PATH');
    };
    const env={SUPABASE_URL:'https://offline.example',SUPABASE_SECRET_KEY:'sb_secret_FAKE',COMMUTEGUARD_HISTORY_BACKEND:'supabase'};
    const first=new SupabaseNotificationStore(env,fake);assert.equal((await first.settings()).departure_time,'11:15');
    await first.saveTime('09:45');assert.equal((await new SupabaseNotificationStore(env,fake).settings()).departure_time,'09:45');
  }finally{await db.close();}
});

test('settings UI loads/saves departure and never requests notification permission on mount',async()=>{
  const {JSDOM}=await import('jsdom');const {createRoot}=await import('react-dom/client');const {act}=await import('react');
  const dom=new JSDOM('<div id="root"></div>',{url:'http://localhost:3000'});
  const previous={window:globalThis.window,document:globalThis.document,fetch:globalThis.fetch};
  Object.assign(globalThis,{window:dom.window,document:dom.window.document,IS_REACT_ACT_ENVIRONMENT:true});
  let saved='11:15';let permissionCalls=0;
  Object.defineProperty(dom.window,'isSecureContext',{value:true});
  Object.defineProperty(dom.window,'PushManager',{value:function(){}});
  Object.defineProperty(dom.window,'Notification',{value:{permission:'default',requestPermission:()=>{permissionCalls++;return Promise.resolve('granted');}}});
  globalThis.fetch=async(url,init)=>{assert.equal(url,'/api/settings');if(init?.method==='PUT')saved=JSON.parse(String(init.body)).departure_time;return Response.json({departure_time:saved,timezone:'America/New_York',updated_at:'2026-10-25T00:00:00Z'});};
  const root=createRoot(document.getElementById('root')!);
  try{
    await act(async()=>root.render(<CommuteSettings/>));
    assert.match(document.body.textContent!,/11:15 AM/);assert.equal(permissionCalls,0);
    await act(async()=>document.querySelector('form')!.dispatchEvent(new dom.window.Event('submit',{bubbles:true,cancelable:true})));
    assert.match(document.body.textContent!,/Departure time saved/);assert.equal(saved,'11:15');assert.equal(permissionCalls,0);
    assert.match(document.body.textContent!,/does not support Web Push/);
  }finally{await act(async()=>root.unmount());Object.assign(globalThis,previous);dom.window.close();}
});
test('service worker displays validated push and focuses app on click, without fetch caching',async()=>{
  const {runInNewContext}=await import('node:vm');
  const handlers=new Map<string,(event:unknown)=>void>();let displayed=0,focused=0;let task:Promise<unknown>|undefined;
  const self={location:{origin:'http://localhost:3000'},addEventListener:(name:string,handler:(event:unknown)=>void)=>handlers.set(name,handler),
    registration:{showNotification:async(title:string)=>{assert.equal(title,'CommuteGuard Test');displayed++;}},
    clients:{matchAll:async()=>[{url:'http://localhost:3000/',focus:async()=>{focused++;}}],openWindow:async()=>{throw Error('should focus');}}};
  runInNewContext(await readFile('public/sw.js','utf8'),{self,URL});
  handlers.get('push')!({data:{json:()=>TEST_NOTIFICATION},waitUntil:(p:Promise<unknown>)=>{task=p;}});await task;assert.equal(displayed,1);
  handlers.get('push')!({data:{json:()=>({title:'malicious',body:'x',tag:'x'})},waitUntil:(p:Promise<unknown>)=>{task=p;}});await task;assert.equal(displayed,1);
  handlers.get('notificationclick')!({notification:{close:()=>{}},waitUntil:(p:Promise<unknown>)=>{task=p;}});await task;assert.equal(focused,1);assert.equal(handlers.has('fetch'),false);
});
for(const permission of ['default','denied'] as const)test(`explicit push permission flow: ${permission}`,async()=>{
  const {JSDOM}=await import('jsdom');const {createRoot}=await import('react-dom/client');const {act}=await import('react');
  const dom=new JSDOM('<div id="root"></div>',{url:'http://localhost:3000'});
  const previous={window:globalThis.window,document:globalThis.document,fetch:globalThis.fetch};
  const navDescriptor=Object.getOwnPropertyDescriptor(globalThis,'navigator'), notificationDescriptor=Object.getOwnPropertyDescriptor(globalThis,'Notification');
  const key=process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY='B'+'a'.repeat(86);
  let prompts=0,registered=0,persisted=0;
  const notification={permission,requestPermission:async()=>{prompts++;return 'granted';}};
  Object.defineProperty(dom.window,'isSecureContext',{value:true});Object.defineProperty(dom.window,'PushManager',{value:function(){}});Object.defineProperty(dom.window,'Notification',{value:notification});
  const registration={pushManager:{getSubscription:async()=>null,subscribe:async()=>({toJSON:()=>subscription})}};
  Object.defineProperty(globalThis,'navigator',{configurable:true,value:{serviceWorker:{getRegistration:async()=>undefined,register:async()=>{registered++;return registration;},ready:Promise.resolve(registration)}}});
  Object.defineProperty(globalThis,'Notification',{configurable:true,value:notification});
  Object.assign(globalThis,{window:dom.window,document:dom.window.document,IS_REACT_ACT_ENVIRONMENT:true});
  globalThis.fetch=async(url,options)=>{
    if(url==='/api/settings')return Response.json({departure_time:'10:30'});
    assert.equal(url,'/api/notifications/subscribe');assert.deepEqual(JSON.parse(String(options?.body)),subscription);persisted++;return Response.json({subscribed:true});
  };
  const root=createRoot(document.getElementById('root')!);
  try{
    await act(async()=>root.render(<CommuteSettings/>));assert.equal(prompts,0);
    const button=[...document.querySelectorAll('button')].find(b=>b.textContent==='Enable notifications')!;
    await act(async()=>button.click());
    if(permission==='denied'){assert.equal(prompts,0);assert.equal(registered,0);assert.equal(persisted,0);assert.match(document.body.textContent!,/Blocked in browser settings/);}
    else {assert.equal(prompts,1);assert.equal(registered,1);assert.equal(persisted,1);assert.match(document.body.textContent!,/Enabled on this browser/);}
  }finally{
    await act(async()=>root.unmount());Object.assign(globalThis,previous);
    if(navDescriptor)Object.defineProperty(globalThis,'navigator',navDescriptor);else Reflect.deleteProperty(globalThis,'navigator');
    if(notificationDescriptor)Object.defineProperty(globalThis,'Notification',notificationDescriptor);else Reflect.deleteProperty(globalThis,'Notification');
    if(key===undefined)delete process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;else process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY=key;
    dom.window.close();
  }
});

for (const at of ['2026-10-25T00:00:00Z','2026-10-25T17:00:00Z','2026-10-27T23:59:59Z']) {
  test(`test push endpoint works outside commute days/windows at ${at}`,async t=>{
    const {createTestNotificationHandler}=await import('../src/server/test-notification-handler.js');
    t.mock.method(Date,'now',()=>Date.parse(at));
    let sends=0;
    // Settings access would fail: delivery tests must never read departure configuration.
    const store={subscription:async()=>subscription,removeSubscription:async()=>{},settings:async()=>{throw Error('MUST_NOT_READ_SCHEDULE');}};
    const handler=createTestNotificationHandler(()=>store,()=>async(s,message)=>{
      sends++;assert.deepEqual(s,subscription);assert.deepEqual(message,{title:'CommuteGuard Test',body:'Local push notifications are working.',tag:'commuteguard-test'});
      assert.doesNotMatch(JSON.stringify(message),/VERIFIED|UNVERIFIED/);
    });
    const request=()=>new Request('http://localhost:3000/api/notifications/test',{method:'POST',headers:{origin:'http://localhost:3000','content-type':'application/json'},body:'{}'});
    const result=await handler(request());assert.equal(result.status,200);assert.deepEqual(await result.json(),{accepted:true});
    assert.equal((await handler(request())).status,200);assert.equal(sends,2);
  });
}
