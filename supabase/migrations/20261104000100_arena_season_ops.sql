-- What running a season needs beyond the schema the engine was built against.
--
-- `rules_hash` ties the row to the engine. The rules live in code (`SEASON_0` in
-- `services/src/arena/rules.ts`) and their SHA-256 is what the season page publishes, so
-- the hash has to live with the season, not in free text: the engine refuses to start a
-- season whose stored hash differs from the rules it is about to run, and the page can
-- print the column rather than a copy of it someone forgot to update.
alter table public.seasons
  add column rules_hash text check (rules_hash ~ '^[0-9a-f]{64}$');

-- When an entry's key was issued, for rotation and for the beta's audit trail. The key
-- itself is never stored; see `entries.api_key_hash`.
alter table public.entries
  add column key_issued_at timestamptz;

-- Public, like every other non-credential column of `entries`. The column-level grant in
-- 20261103000200 means a new column is invisible to anon until it is listed here.
grant select (key_issued_at) on public.entries to anon, authenticated;

-- The engine's own rank and prize eligibility, written with each score. Ranking again in
-- SQL would have to copy the engine's tie-breaks (lower drawdown, then earlier
-- registration) and the eligibility rule (active days, presence), and a copy that drifts
-- is a leaderboard that disagrees with the replay. So the page reads what the engine said.
alter table public.scores
  add column rank integer check (rank > 0),
  add column eligible boolean not null default false;

-- The Arena leaderboard: one row per entry for its latest scored day, ranked within the
-- season. Paper seasons only show here; `/arena` must never mix modes (plans §4), and the
-- marketplace leaderboard never reads this view. `security_invoker` so it is filtered by
-- the reader's own grants: the anon role sees no `api_key_hash` through it either.
create view public.arena_leaderboard
with (security_invoker = true) as
select
  s.slug as season_slug,
  s.mode as season_mode,
  e.id as entry_id,
  e.display_name,
  e.builder_wallet,
  e.status,
  sc.day,
  sc.net_return_bps,
  sc.max_drawdown_bps,
  sc.score,
  sc.turnover_ratio,
  sc.fees_paid,
  sc.eligible,
  sc.rank,
  sc.computed_at
from public.seasons s
join public.entries e on e.season_id = s.id and e.status = 'active'
join lateral (
  select *
  from public.scores x
  where x.entry_id = e.id
  order by x.day desc
  limit 1
) sc on true;

grant select on public.arena_leaderboard to anon, authenticated;
