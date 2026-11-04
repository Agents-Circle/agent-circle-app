-- Two faults in 20261103000200 and 20261103000100, found by re-running the Supabase
-- advisors after an unrelated migration. Neither is exploitable against today's data;
-- both are the wrong default.
--
-- 1. `points_balances` was created without `security_invoker`, so it runs with the
--    view owner's rights and bypasses row-level security on `points_ledger`. That is
--    harmless only for as long as `points_ledger` stays world-readable — the moment a
--    policy narrows it, the view would hand back rows the policy excludes. The advisor
--    rates it ERROR, and `arena_leaderboard` (20261104000100) already does this right.
--
--    `alter view` rather than drop and recreate, so the existing grants survive.
--
-- 2. `is_hex_address` and `is_hex32` were created without a fixed `search_path`. They are
--    `immutable` and used inside CHECK constraints on `hl_listings`, `hl_vaults` and
--    `hl_fills`, which is exactly where a resolvable-at-call-time name is worth removing:
--    a constraint should not depend on who is running the insert.
--
--    `create or replace` keeps each function's OID, so the constraints that reference
--    them keep working and are not revalidated. The bodies are unchanged apart from the
--    setting; `~` is a `pg_catalog` operator and needs no qualification.

alter view public.points_balances set (security_invoker = true);

create or replace function public.is_hex_address(value text)
  returns boolean
  language sql
  immutable
  set search_path = ''
as $$
  select value ~ '^0x[0-9a-f]{40}$';
$$;

create or replace function public.is_hex32(value text)
  returns boolean
  language sql
  immutable
  set search_path = ''
as $$
  select value ~ '^0x[0-9a-f]{64}$';
$$;

-- Fail rather than report success if either fault survives.
do $$
begin
  if not exists (
    select 1 from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'points_balances'
      and c.reloptions @> array['security_invoker=true']
  ) then
    raise exception 'points_balances is still not security_invoker';
  end if;

  -- Tests for the setting's presence rather than a literal value: Postgres stores an
  -- empty search_path as `search_path=` and a set one as `search_path=public`, and an
  -- assertion that matched only one spelling would pass while the fault survived.
  if exists (
    select 1 from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in ('is_hex_address', 'is_hex32')
      and not exists (
        select 1 from unnest(coalesce(p.proconfig, '{}')) as cfg
        where cfg like 'search_path=%'
      )
  ) then
    raise exception 'is_hex_address or is_hex32 still has a mutable search_path';
  end if;
end
$$;
