-- Two agents have been `live` on the public site since 23 July with no activity behind
-- them: `Agent King` and `PhantomX`. Neither has a listing, a performance snapshot, or
-- anything else that would make "live" true. They are the last of the same family as the
-- seeded demo agents removed on 3 November — not fabricated numbers this time, but a
-- status the data does not support, which is the same problem wearing a different hat.
--
-- Demoted to `vetting` rather than deleted. `vetting` is the honest description of an
-- agent with nothing behind it, the move is one `update` to reverse, and deleting rows
-- someone may want to look at is not ours to do.
--
-- The condition is written as "live with no activity" rather than naming the two, so it
-- cannot demote an agent that has since started trading, and re-running it is a no-op.
-- `agents.status` is constrained to ('live','vetting','paused').
--
-- ## Why this is wrapped in an existence check
--
-- `agents`, `listings` and `performance_snapshots` are **not created by any migration in
-- this directory**. They exist only in the live database: the July schema predates the
-- migration discipline and was never captured. So `supabase/migrations/` cannot rebuild
-- this database from nothing, and CI's `migrations` job — which applies every file in
-- order to an empty Postgres — has only ever proved that the November migrations apply to
-- an empty schema. This is the first migration to reference a July table, which is why it
-- is the first to fail there.
--
-- The guard keeps that gap from blocking this fix, and the gap itself is worth closing
-- separately: nobody can stand up a fresh environment, and a restore would not reproduce
-- the schema either.

do $$
declare
  demoted int;
begin
  -- All three, not just `agents`: PL/pgSQL plans the `update` when it first runs it, so a
  -- database with `agents` but no `listings` would still fail inside the block. Either
  -- every table this needs is present or there is nothing here to do.
  if to_regclass('public.agents') is null
    or to_regclass('public.listings') is null
    or to_regclass('public.performance_snapshots') is null
  then
    raise notice 'the July schema is not present here; nothing to demote';
    return;
  end if;

  update public.agents a
  set status = 'vetting'
  where a.status = 'live'
    and not exists (
      select 1 from public.listings l where l.agent_id = a.id
    )
    and not exists (
      select 1 from public.performance_snapshots p where p.agent_id = a.id
    );

  get diagnostics demoted = row_count;
  raise notice 'demoted % inactive live agents', demoted;

  -- Report rather than assume. A `live` agent that survives this has activity behind it.
  if exists (
    select 1 from public.agents a
    where a.status = 'live'
      and not exists (select 1 from public.listings l where l.agent_id = a.id)
      and not exists (select 1 from public.performance_snapshots p where p.agent_id = a.id)
  ) then
    raise exception 'agents are still live with no activity';
  end if;
end
$$;
