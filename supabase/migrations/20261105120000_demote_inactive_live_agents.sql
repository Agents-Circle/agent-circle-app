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
-- The condition is written as "live with no activity" rather than naming the two, so that
-- it cannot demote an agent that has since started trading, and so re-running it is a
-- no-op. `status` is constrained to ('live','vetting','paused').

update public.agents a
set status = 'vetting'
where a.status = 'live'
  and not exists (select 1 from public.listings l where l.agent_id = a.id)
  and not exists (select 1 from public.performance_snapshots p where p.agent_id = a.id);

-- Report, rather than assume. A `live` agent that survives this has activity behind it.
do $$
declare
  bad int;
begin
  select count(*) into bad
  from public.agents a
  where a.status = 'live'
    and not exists (select 1 from public.listings l where l.agent_id = a.id)
    and not exists (select 1 from public.performance_snapshots p where p.agent_id = a.id);

  if bad > 0 then
    raise exception '% agents are still live with no activity', bad;
  end if;
end
$$;
