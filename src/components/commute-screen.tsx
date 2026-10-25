'use client';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { DEFAULT_COMMUTE } from '../lib/commute/types.js';
import type { CommuteDecision, CommuteReason } from '../lib/commute/types.js';
import { decisionDisplayDeadline } from '../lib/commute/presentation.js';

const reasons: Partial<Record<CommuteReason, string>> = {
  PREVIOUS_TRIP: 'The vehicle is still associated with its previous trip.',
  INSUFFICIENT_OBSERVATIONS: 'There are not enough distinct realtime observations yet.',
  LAYOVER: 'The vehicle is in a source-indicated layover. Its departure is not confirmed.',
  STALE_OBSERVATIONS: 'Vehicle information is too old to rely on.',
  INSUFFICIENT_PROGRESS: 'Consistent progress toward your stop has not been confirmed.',
  ORIGIN_REQUIRES_STABLE_CURRENT_TRIP: 'Your stop starts the route. More consistent current-trip evidence is needed.',
  TARGET_STOP_UNCONFIRMED: 'Service at your boarding stop could not be confirmed.',
  DATA_UNAVAILABLE: 'Current realtime information could not be verified.',
  HISTORY_UNAVAILABLE: 'Recent observation history is unavailable.',
};
export function checkedTime(value: string): string {
  return new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit' }).format(new Date(value));
}
/** Reject incomplete transport responses; this does not assess transit evidence. */
export function isDecision(value: unknown): value is CommuteDecision {
  if (!value || typeof value !== 'object') return false;
  const d = value as CommuteDecision;
  return !!d.primaryLeg && ['VERIFIED', 'UNVERIFIED', 'HIGH_GHOST_RISK'].includes(d.primaryLeg.status)
    && typeof d.primaryLeg.route === 'string' && typeof d.primaryLeg.stop?.name === 'string'
    && typeof d.primaryLeg.destination === 'string' && typeof d.primaryLeg.summary === 'string'
    && Array.isArray(d.primaryLeg.reasonCodes) && d.primaryLeg.reasonCodes.every(r => typeof r === 'string')
    && !!d.recommendation && ['NORMAL_ROUTE', 'BACKUP_ROUTE'].includes(d.recommendation.action) && typeof d.recommendation.label === 'string'
    && d.recommendation.action === (d.primaryLeg.status === 'VERIFIED' ? 'NORMAL_ROUTE' : 'BACKUP_ROUTE')
    && !!d.dataHealth && ['HEALTHY', 'DEGRADED', 'UNAVAILABLE'].includes(d.dataHealth.status)
    && (d.primaryLeg.status !== 'VERIFIED' || d.dataHealth.status === 'HEALTHY')
    && (d.displayExpiresAt === undefined || Number.isFinite(Date.parse(d.displayExpiresAt)))
    && typeof d.evaluatedAt === 'string' && Number.isFinite(Date.parse(d.evaluatedAt));
}
export function DecisionCard({ decision }: { decision: CommuteDecision }) {
  const leg = decision.primaryLeg;
  const details = [...new Set(leg.reasonCodes.map(code => reasons[code]).filter((s): s is string => !!s))];
  return <>
    <div className="route-heading"><span className="route-badge">{leg.route}</span><div><p className="stop">{leg.stop.name}</p><p className="direction">Toward {leg.destination}</p></div></div>
    <div className={`status status-${leg.status.toLowerCase()}`}><span aria-hidden="true" className="status-dot" />{leg.status.replaceAll('_', ' ')}</div>
    <p className="eyebrow">Recommended action</p>
    <h2 className="recommendation">{decision.recommendation.label}</h2>
    <p className="explanation">{leg.summary}</p>
    {leg.status === 'HIGH_GHOST_RISK' && <p className="inference">High Ghost Risk is a CommuteGuard inference, not an official MTA designation.</p>}
    {decision.dataHealth.status !== 'HEALTHY' && <p className="health" role="note">{decision.dataHealth.status === 'UNAVAILABLE' ? 'Realtime data is currently unavailable.' : 'Realtime data is currently incomplete.'} The {leg.route} could not be verified.</p>}
    {details.length > 0 && <details><summary>Why this recommendation?</summary><p>Notes from recent observations; some may describe earlier evidence. The summary above describes this check.</p><ul>{details.map(text => <li key={text}>{text}</li>)}</ul></details>}
    <div className="checked">Last checked <time dateTime={decision.evaluatedAt}>{checkedTime(decision.evaluatedAt)} <span>{new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric' }).format(new Date(decision.evaluatedAt))} · New York time</span></time></div>
  </>;
}
export function CommuteScreen({ children }: { children?: React.ReactNode }) {
  const [decision, setDecision] = useState<CommuteDecision | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'error' | 'expired'>('loading');
  const inFlight = useRef(false);
  const controller = useRef<AbortController | null>(null);
  const check = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    const request = new AbortController();
    controller.current = request;
    setDecision(null); setState('loading');
    try {
      const response = await fetch('/api/commute', { cache: 'no-store', signal: request.signal });
      if (!response.ok) throw new Error('CHECK_FAILED');
      const result: unknown = await response.json();
      if (!isDecision(result)) throw new Error('INVALID_DECISION');
      if (!request.signal.aborted && controller.current === request) { setDecision(result); setState('ready'); }
    } catch { if (!request.signal.aborted) setState('error'); }
    finally { if (controller.current === request) inFlight.current = false; }
  }, []);
  useEffect(() => {
    void check();
    return () => { controller.current?.abort(); inFlight.current = false; };
  }, [check]);
  useEffect(() => {
    if (!decision || state !== 'ready') return;
    const deadline = decisionDisplayDeadline(decision);
    const budget = Math.max(0, deadline - Date.parse(decision.evaluatedAt));
    const started = performance.now();
    // A slow or adjusted phone clock must not extend the server's remaining lifetime.
    const remaining = () => Math.min(deadline - Date.now(), budget - (performance.now() - started));
    let timer: ReturnType<typeof setTimeout>;
    let active = true;
    const expire = () => {
      if (!active || inFlight.current) return;
      clearTimeout(timer);
      const left = remaining();
      if (left <= 0) { setDecision(null); setState('expired'); }
      else timer = setTimeout(expire, Math.max(1, Math.ceil(left)));
    };
    expire();
    // A suspended phone tab may not run its timer until it becomes visible again.
    document.addEventListener('visibilitychange', expire);
    return () => { active = false; clearTimeout(timer); document.removeEventListener('visibilitychange', expire); };
  }, [decision, state]);
  return <main className="shell">
    <header><a className="brand" href="/" aria-label="CommuteGuard home"><span className="brand-mark" aria-hidden="true">C</span>COMMUTEGUARD</a><p className="intro">A little clarity before you leave.</p></header>
    <div className="page-title"><p className="eyebrow">Your route to Lehman</p><h1>Morning commute<span>.</span></h1></div>
    <section className="decision-card" aria-label="Current commute decision" aria-busy={state === 'loading'}>
      <div aria-live="polite" aria-atomic="true">
        {state === 'loading' && <div className="pending"><span className="route-badge">{DEFAULT_COMMUTE.route}</span><h2>Checking your {DEFAULT_COMMUTE.route}…</h2><p>Looking at current realtime information.</p></div>}
        {state === 'ready' && decision && <DecisionCard decision={decision} />}
        {state === 'expired' && <div className="error-state"><span className="route-badge">{DEFAULT_COMMUTE.route}</span><p className="status status-unverified">UNVERIFIED</p><h2>This check has expired.</h2><p>Refresh for a current assessment. Use your backup until the bus can be verified again.</p><p className="eyebrow">Recommended action</p><p className="recommendation">{DEFAULT_COMMUTE.backupLabel}</p></div>}
        {state === 'error' && <div className="error-state"><span className="route-badge">{DEFAULT_COMMUTE.route}</span><h2>Current data couldn’t be verified.</h2><p>CommuteGuard couldn’t verify current transit data. Use your backup while information is unavailable.</p><p className="eyebrow">Recommended action</p><p className="recommendation">Walk to the D train.</p></div>}
      </div>
      <button type="button" disabled={state === 'loading'} onClick={() => void check()}>{state === 'loading' ? 'Checking…' : state === 'error' ? 'Try again' : 'Check again'}<span aria-hidden="true">↻</span></button>
    </section>
    {children}
    <footer>A snapshot of the evidence, not a promise of arrival.<br />Open near departure for a fresh assessment.</footer>
  </main>;
}
