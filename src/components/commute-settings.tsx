'use client';
import React, { useEffect, useState } from 'react';
import { validateTime } from '../lib/notifications/model.js';
export function readableTime(time: string): string {
  const [hour,minute] = time.split(':').map(Number);
  return `${hour! % 12 || 12}:${String(minute).padStart(2,'0')} ${hour! >= 12 ? 'PM' : 'AM'}`;
}
function supportsPush() { return typeof window !== 'undefined' && window.isSecureContext && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window; }
export function CommuteSettings() {
  const [time,setTime] = useState('10:30'), [saved,setSaved] = useState<string|null>(null);
  const [message,setMessage] = useState('Loading saved departure…'), [busy,setBusy] = useState(false);
  const [push,setPush] = useState('Checking browser support…'), [enabled,setEnabled] = useState(false), [pushBusy,setPushBusy] = useState(false);
  const [supported,setSupported] = useState(false);
  useEffect(() => {
    const abort = new AbortController();
    void fetch('/api/settings',{cache:'no-store',signal:abort.signal}).then(async r => {
      if (!r.ok) throw Error(); const s = await r.json(); const value = validateTime(s.departure_time);
      if (!abort.signal.aborted) { setTime(value); setSaved(value); setMessage(''); }
    }).catch(() => { if (!abort.signal.aborted) setMessage('Settings unavailable. Apply the local notification migration and check Supabase.'); });
    setSupported(supportsPush());
    if (!supportsPush()) setPush('This browser does not support Web Push here. Try Chrome or Firefox on localhost.');
    else {
      setPush(Notification.permission === 'denied' ? 'Blocked in browser settings.' : 'Not enabled');
      void navigator.serviceWorker.getRegistration('/').then(async r => {
        const s = await r?.pushManager.getSubscription();
        if (s && !abort.signal.aborted) { setEnabled(true); setPush('Enabled on this browser'); }
      }).catch(() => {});
    }
    return () => abort.abort();
  },[]);
  async function save(event: React.FormEvent) {
    event.preventDefault(); setBusy(true);
    try {
      validateTime(time);
      const r = await fetch('/api/settings',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({departure_time:time}),cache:'no-store'});
      if (!r.ok) throw Error(); const s = await r.json(); setSaved(validateTime(s.departure_time)); setMessage('Departure time saved.');
    } catch { setMessage('Could not save departure time. Please try again.'); }
    finally { setBusy(false); }
  }
  async function enable() {
    if (!supportsPush()) return;
    if (Notification.permission === 'denied') { setPush('Blocked in browser settings.'); return; }
    setPushBusy(true);
    try {
      const key = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
      if (!key) throw Error('VAPID');
      await navigator.serviceWorker.register('/sw.js');
      // Only this explicit button handler can ask for permission.
      const permission = await Notification.requestPermission();
      if (permission !== 'granted') { setPush(permission === 'denied' ? 'Blocked in browser settings.' : 'Not enabled'); return; }
      const registration = await navigator.serviceWorker.ready;
      const binary = atob(key.replace(/-/g,'+').replace(/_/g,'/'));
      const applicationServerKey = new Uint8Array(binary.length);
      for (let i=0;i<binary.length;i++) applicationServerKey[i]=binary.charCodeAt(i);
      const subscription = await registration.pushManager.getSubscription() ?? await registration.pushManager.subscribe({userVisibleOnly:true,applicationServerKey});
      const response = await fetch('/api/notifications/subscribe',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(subscription.toJSON()),cache:'no-store'});
      if (!response.ok) throw Error(); setEnabled(true); setPush('Enabled on this browser');
    } catch { setPush('Could not enable notifications. Check VAPID configuration and Supabase migration.'); }
    finally { setPushBusy(false); }
  }
  async function test() {
    setPushBusy(true);
    try {
      const r = await fetch('/api/notifications/test',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}',cache:'no-store'});
      if (!r.ok) throw Error(); setPush('Test push accepted. Check system notifications.');
    } catch { setPush('Test push failed. Check subscription, VAPID and browser notification settings.'); }
    finally { setPushBusy(false); }
  }
  return <section className="settings-card" aria-label="Commute settings">
    <h2>Departure & notifications</h2>
    <p>Monday & Wednesday · New York time</p>
    <form onSubmit={event => void save(event)}>
      <label htmlFor="departure-time">Departure time</label>
      <input id="departure-time" type="time" required value={time} onChange={event => setTime(event.target.value)} />
      <button disabled={busy} type="submit">{busy ? 'Saving…' : 'Save departure time'}</button>
    </form>
    {saved && <p>Saved: {readableTime(saved)} · America/New_York</p>}
    <p role="status">{message}</p>
    <h3>Notifications</h3><p role="status">{push}</p>
    <button type="button" disabled={pushBusy || !supported} onClick={() => void enable()}>{enabled ? 'Reconnect notifications' : 'Enable notifications'}</button>
    {enabled && <button type="button" disabled={pushBusy} onClick={() => void test()}>Send test notification</button>}
    <p className="settings-note">Local testing requires an awake Mac and the local scheduler running. One current assessment is sent at departure; delivery is not guaranteed.</p>
  </section>;
}
