-- Server-only normalized observations. No user/account tables or stored decisions.
begin;
create table public.commute_observation_frames (
  scope_id text not null check (length(scope_id) between 10 and 200),
  acquisition_id uuid not null,
  completed_at timestamptz not null,
  created_at timestamptz not null default clock_timestamp(),
  frame jsonb not null,
  primary key (scope_id, acquisition_id),
  constraint normalized_frame_shape check (
    jsonb_typeof(frame) = 'object'
    and (frame - array['acquisitionId','completedAt','vm','sm','errors']) = '{}'::jsonb
    and jsonb_typeof(frame->'acquisitionId') = 'string' and jsonb_typeof(frame->'completedAt') = 'string'
    and frame->>'acquisitionId' = acquisition_id::text
    and (frame->>'completedAt')::timestamptz = completed_at
    and frame ? 'completedAt' and frame ? 'acquisitionId'
    and octet_length(frame::text) <= 1048576
  )
);
create index commute_frames_recent_idx on public.commute_observation_frames (scope_id, completed_at desc, acquisition_id desc);
create index commute_frames_retention_idx on public.commute_observation_frames (scope_id, created_at);
alter table public.commute_observation_frames enable row level security;
revoke all on public.commute_observation_frames from public, anon, authenticated;
grant usage on schema public to service_role;
grant select, insert, delete on public.commute_observation_frames to service_role;

-- Retry is a no-op only for an identical acquisition. Never overwrite evidence.
create function public.cg_append_frame(p_scope text, p_acquisition_id uuid, p_completed_at timestamptz, p_frame jsonb, p_retention_seconds integer)
returns void language plpgsql security invoker set search_path = '' as $$
declare existing jsonb;
begin
  if p_retention_seconds < 600 or p_retention_seconds > 604800 then raise exception 'INVALID_RETENTION'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_scope, 0));
  insert into public.commute_observation_frames(scope_id, acquisition_id, completed_at, frame)
    values (p_scope, p_acquisition_id, p_completed_at, p_frame)
    on conflict (scope_id, acquisition_id) do nothing;
  select f.frame into existing from public.commute_observation_frames f where f.scope_id = p_scope and f.acquisition_id = p_acquisition_id;
  if existing is distinct from p_frame then raise exception 'ACQUISITION_CONFLICT'; end if;
  -- Opportunistic cleanup, not a background job; ingested-row retention is independent of evidence age.
  delete from public.commute_observation_frames f where f.scope_id = p_scope
    and f.created_at < clock_timestamp() - pg_catalog.make_interval(secs => p_retention_seconds);
end;
$$;

create function public.cg_recent_frames(p_scope text, p_evaluated_at timestamptz, p_window_seconds integer, p_limit integer)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare result jsonb;
begin
  if p_window_seconds <> 600 or p_limit < 1 or p_limit > 40 then raise exception 'INVALID_HISTORY_QUERY'; end if;
  -- Future rows are intentionally retained so the existing engine can reject clock conflicts.
  select coalesce(jsonb_agg(r.frame order by r.completed_at, r.acquisition_id), '[]'::jsonb) into result
  from (select f.frame, f.completed_at, f.acquisition_id from public.commute_observation_frames f
    where f.scope_id = p_scope and f.completed_at >= p_evaluated_at - pg_catalog.make_interval(secs => p_window_seconds)
    order by f.completed_at desc, f.acquisition_id desc limit p_limit) r;
  return result;
end;
$$;
-- Manual maintenance for inactive scopes; no scheduler is installed by this migration.
create function public.cg_prune_history(p_scope text, p_retention_seconds integer)
returns bigint language plpgsql security invoker set search_path = '' as $$
declare removed bigint;
begin
  if p_retention_seconds < 600 or p_retention_seconds > 604800 then raise exception 'INVALID_RETENTION'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_scope, 0));
  delete from public.commute_observation_frames f where f.scope_id = p_scope
    and f.created_at < clock_timestamp() - pg_catalog.make_interval(secs => p_retention_seconds);
  get diagnostics removed = row_count;
  return removed;
end;
$$;
revoke all on function public.cg_prune_history(text,integer) from public, anon, authenticated;
grant execute on function public.cg_prune_history(text,integer) to service_role;
revoke all on function public.cg_append_frame(text,uuid,timestamptz,jsonb,integer) from public, anon, authenticated;
revoke all on function public.cg_recent_frames(text,timestamptz,integer,integer) from public, anon, authenticated;
grant execute on function public.cg_append_frame(text,uuid,timestamptz,jsonb,integer) to service_role;
grant execute on function public.cg_recent_frames(text,timestamptz,integer,integer) to service_role;
notify pgrst, 'reload schema';
commit;
