-- Take approve_agent, reject_agent and report_performance away from the browser.
--
-- All three are SECURITY DEFINER functions created in the dashboard, so they are not in
-- this directory and their argument lists are not known here (see supabase/README.md).
-- They are therefore matched by name in pg_proc rather than by signature, which also
-- catches any overload someone added alongside the original.
--
-- approve_agent / reject_agent: callable by anon, gated only by a code passed as an
-- argument. Anyone holding the anon key (every browser) could brute-force or replay the
-- code and move an agent from `vetting` to `live`. After this they are callable only by
-- service_role, which only the server route app/api/admin/vetting holds, and that route
-- requires a signature from an allowlisted admin wallet.
--
-- report_performance: lets a builder self-report the numbers the leaderboard shows. The
-- indexer computes those from fills now, so nothing should call it. It is revoked, not
-- dropped, because its body exists only on the live project and has never been
-- captured; drop it once `supabase db pull` has recorded the baseline.
--
-- Why PUBLIC as well as anon/authenticated: Postgres grants EXECUTE to PUBLIC on every
-- new function, and anon inherits from PUBLIC. Revoking from anon alone leaves it able
-- to call the function.
--
-- Caveat for whoever edits these in the dashboard later: CREATE OR REPLACE keeps these
-- grants, but DROP + CREATE resets them to Supabase's default privileges, which grant
-- EXECUTE to anon again. Re-run this migration's checks after any such change.
--
-- On a database without these functions (a fresh environment, before the baseline
-- exists) this is a no-op apart from a notice.

do $$
declare
  fn record;
  signature text;
  matched int := 0;
  has_supabase_roles boolean :=
    exists (select 1 from pg_roles where rolname = 'anon')
    and exists (select 1 from pg_roles where rolname = 'authenticated');
  has_service_role boolean := exists (select 1 from pg_roles where rolname = 'service_role');
begin
  for fn in
    select p.oid, n.nspname, p.proname
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in ('approve_agent', 'reject_agent', 'report_performance')
  loop
    matched := matched + 1;
    signature := format(
      '%I.%I(%s)', fn.nspname, fn.proname, pg_get_function_identity_arguments(fn.oid)
    );

    execute format('revoke all on function %s from public', signature);
    if has_supabase_roles then
      execute format('revoke all on function %s from anon, authenticated', signature);
    end if;

    -- Supabase's default privileges grant service_role directly, so it is reset too and
    -- only the vetting pair is granted back. report_performance stays callable by its
    -- owner alone, so a service-role caller cannot quietly revive self-reporting.
    if has_service_role then
      execute format('revoke all on function %s from service_role', signature);
      if fn.proname in ('approve_agent', 'reject_agent') then
        execute format('grant execute on function %s to service_role', signature);
      end if;
    end if;
  end loop;

  if matched = 0 then
    raise notice 'approve_agent / reject_agent / report_performance not present; nothing to lock';
  end if;

  -- Fail the migration rather than report success with a hole still open. This covers
  -- grants inherited through PUBLIC and through role membership, which a read of
  -- proacl alone would miss.
  if has_supabase_roles then
    perform 1
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in ('approve_agent', 'reject_agent', 'report_performance')
      and (has_function_privilege('anon', p.oid, 'EXECUTE')
           or has_function_privilege('authenticated', p.oid, 'EXECUTE'));
    if found then
      raise exception 'anon or authenticated can still execute a locked function';
    end if;
  end if;
end
$$;
