-- Single-user local MVP. No browser/anonymous access; server-only REST operations.
create table public.commute_settings (
  singleton boolean primary key default true check (singleton),
  departure_time text not null default '10:30' check (departure_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  timezone text not null default 'America/New_York' check (timezone = 'America/New_York'),
  updated_at timestamptz not null default now()
);
insert into public.commute_settings(singleton) values(true);
create table public.commute_push_subscription (
  singleton boolean primary key default true check(singleton),
  endpoint text not null check(length(endpoint) <= 2048),
  p256dh text not null, auth text not null,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table public.commute_notification_occurrences (
  occurrence text primary key, departure_time text not null,
  claimed_at timestamptz not null default now(),
  result text not null default 'ATTEMPTING' check(result in ('ATTEMPTING','SENT','FAILED','NO_SUBSCRIPTION'))
);
create table public.commute_local_worker (
  singleton boolean primary key default true check(singleton), heartbeat_at timestamptz not null default now()
);
create function public.cg_claim_notification(p_occurrence text, p_departure text) returns boolean
language plpgsql security definer set search_path = public, pg_temp as $$
declare inserted integer;
begin
  -- A settings write and a notification claim serialize on the one settings row.
  perform 1 from public.commute_settings where singleton and departure_time = p_departure for update;
  if not found then return false; end if;
  insert into public.commute_notification_occurrences(occurrence, departure_time) values(p_occurrence,p_departure) on conflict do nothing;
  get diagnostics inserted = row_count;
  return inserted = 1;
end $$;
create function public.cg_save_departure(p_departure text) returns void
language sql security definer set search_path = public, pg_temp as $$
  update public.commute_settings set departure_time = p_departure, updated_at = now() where singleton;
$$;
alter table public.commute_settings enable row level security;
alter table public.commute_push_subscription enable row level security;
alter table public.commute_notification_occurrences enable row level security;
alter table public.commute_local_worker enable row level security;
revoke all on public.commute_settings, public.commute_push_subscription, public.commute_notification_occurrences, public.commute_local_worker from public, anon, authenticated;
grant select on public.commute_settings to service_role;
grant select, insert, update, delete on public.commute_push_subscription to service_role;
grant select, update on public.commute_notification_occurrences to service_role;
grant select, insert, update on public.commute_local_worker to service_role;
revoke all on function public.cg_claim_notification(text,text), public.cg_save_departure(text) from public, anon, authenticated;
grant execute on function public.cg_claim_notification(text,text), public.cg_save_departure(text) to service_role;
