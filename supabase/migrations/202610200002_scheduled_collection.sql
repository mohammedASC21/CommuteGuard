-- No cron activation or secrets in this migration. Apply after Phase 5.
begin;
create table public.commute_collection_state (
  scope_id text primary key check (length(scope_id) between 10 and 200),
  slot_at timestamptz not null,
  acquisition_id uuid not null,
  lease_token uuid not null,
  lease_until timestamptz not null,
  result text not null check (result in ('IN_PROGRESS','COLLECTED','UPSTREAM_PARTIAL_FAILURE','UPSTREAM_FAILURE','UPSTREAM_ISSUES')),
  last_completed_at timestamptz,
  last_result text
);
alter table public.commute_collection_state enable row level security;
revoke all on public.commute_collection_state from public, anon, authenticated;
grant select, insert, update, delete on public.commute_collection_state to service_role;

create function public.cg_claim_collection(p_scope text, p_slot timestamptz, p_id uuid, p_token uuid)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare state public.commute_collection_state; gap boolean := false;
begin
  -- Serialize claims and commits across separate serverless instances; never hold across HTTP.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_scope, 0));
  select * into state from public.commute_collection_state where scope_id = p_scope;
  if found then
    if p_slot <= state.slot_at then return jsonb_build_object('status','DUPLICATE_ACQUISITION','gap',false); end if;
    if state.result = 'IN_PROGRESS' and state.lease_until > clock_timestamp() then
      return jsonb_build_object('status','COLLECTION_IN_PROGRESS','gap',false);
    end if;
    gap := state.result = 'IN_PROGRESS'; -- expired/crashed/failed-write owner; preserve continuity break
  end if;
  insert into public.commute_collection_state(scope_id,slot_at,acquisition_id,lease_token,lease_until,result)
    values(p_scope,p_slot,p_id,p_token,clock_timestamp() + interval '90 seconds','IN_PROGRESS')
    on conflict(scope_id) do update set slot_at=excluded.slot_at, acquisition_id=excluded.acquisition_id,
      lease_token=excluded.lease_token, lease_until=excluded.lease_until, result='IN_PROGRESS';
  return jsonb_build_object('status','ACQUIRED','gap',gap);
end;
$$;

create function public.cg_complete_collection(p_scope text, p_slot timestamptz, p_token uuid, p_frame jsonb, p_result text, p_retention_seconds integer)
returns void language plpgsql security invoker set search_path = '' as $$
declare state public.commute_collection_state;
begin
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_scope, 0));
  select * into state from public.commute_collection_state where scope_id=p_scope;
  if not found or state.slot_at <> p_slot or state.lease_token <> p_token then raise exception 'COLLECTION_FENCED'; end if;
  if state.result <> 'IN_PROGRESS' then
    if exists(select 1 from public.commute_observation_frames f where f.scope_id=p_scope and f.acquisition_id=state.acquisition_id and f.frame=p_frame) then return; end if;
    raise exception 'COLLECTION_CONFLICT';
  end if;
  if state.lease_until <= clock_timestamp() then raise exception 'COLLECTION_LEASE_EXPIRED'; end if;
  if p_frame->>'acquisitionId' <> state.acquisition_id::text or p_result not in ('COLLECTED','UPSTREAM_PARTIAL_FAILURE','UPSTREAM_FAILURE','UPSTREAM_ISSUES') then raise exception 'INVALID_COLLECTION'; end if;
  -- Frame insertion and completion are one transaction. Failed writes leave an expiring lease.
  perform public.cg_append_frame(p_scope,state.acquisition_id,(p_frame->>'completedAt')::timestamptz,p_frame,p_retention_seconds);
  update public.commute_collection_state set result=p_result,last_result=p_result,last_completed_at=(p_frame->>'completedAt')::timestamptz where scope_id=p_scope;
end;
$$;
create function public.cg_collection_status(p_scope text)
returns jsonb language sql security invoker set search_path = '' as $$
  select coalesce((select jsonb_build_object('slot',slot_at,'state',case when result='IN_PROGRESS' and lease_until <= clock_timestamp() then 'ABANDONED' else result end,'lastCompletedAt',last_completed_at,'lastResult',last_result) from public.commute_collection_state where scope_id=p_scope),'{}'::jsonb);
$$;
revoke all on function public.cg_claim_collection(text,timestamptz,uuid,uuid) from public, anon, authenticated;
revoke all on function public.cg_complete_collection(text,timestamptz,uuid,jsonb,text,integer) from public, anon, authenticated;
revoke all on function public.cg_collection_status(text) from public, anon, authenticated;
grant execute on function public.cg_claim_collection(text,timestamptz,uuid,uuid) to service_role;
grant execute on function public.cg_complete_collection(text,timestamptz,uuid,jsonb,text,integer) to service_role;
grant execute on function public.cg_collection_status(text) to service_role;
notify pgrst, 'reload schema';
commit;
