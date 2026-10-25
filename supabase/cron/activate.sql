-- MANUAL ACTIVATION ONLY, AFTER DEPLOYMENT. Never substitute real secrets into this file.
-- Enable pg_cron, pg_net and Vault in Supabase first.
-- In Vault UI create commuteguard_collect_url = deployed HTTPS /api/internal/commute/collect
-- and commuteguard_cron_secret = same dedicated secret as server env (32+ random characters).
-- This script contains no credentials. Review deployment protection/rate limits before activation.
create or replace function public.cg_dispatch_collection()
returns void language plpgsql security definer set search_path = '' as $$
declare target text; secret text; intended timestamptz := clock_timestamp();
begin
  -- Coarse UTC envelope covers BOTH New York EDT and EST. Application guard is authoritative.
  -- Candidate calls on Mon/Wed, 14:23..14:30 and 15:23..15:30 UTC only.
  if extract(isodow from intended at time zone 'UTC') not in (1,3)
     or extract(hour from intended at time zone 'UTC') not in (14,15)
     or extract(minute from intended at time zone 'UTC') not between 23 and 30 then return; end if;
  select decrypted_secret into target from vault.decrypted_secrets where name='commuteguard_collect_url';
  select decrypted_secret into secret from vault.decrypted_secrets where name='commuteguard_cron_secret';
  if target is null or target !~ '^https://[a-zA-Z0-9.-]+/api/internal/commute/collect$' or target ~* '(localhost|127\.0\.0\.1)' or secret is null or length(secret)<32 then raise exception 'COLLECTOR_NOT_CONFIGURED'; end if;
  perform net.http_post(url:=target,
    headers:=jsonb_build_object('Content-Type','application/json','Authorization','Bearer ' || secret),
    body:=jsonb_build_object('scheduledAt',to_char(intended at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')),
    timeout_milliseconds:=55000);
end;
$$;
revoke all on function public.cg_dispatch_collection() from public, anon, authenticated, service_role;
-- Safe to repeat: same named job is updated by pg_cron.
select cron.schedule('commuteguard-observations', '30 seconds', 'select public.cg_dispatch_collection()');
-- To disable: select cron.unschedule('commuteguard-observations');
-- Job success means dispatch SQL ran, not that HTTP acquisition succeeded.
-- Check net._http_response (status only, never dump headers) and pnpm collector:status.
