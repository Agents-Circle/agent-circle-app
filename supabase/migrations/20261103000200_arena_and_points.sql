-- Circle Arena, points, backer stakes and referrals.
--
-- The Arena exists because of the unit economics: fees are too small for too long to
-- attract either side of the marketplace, so prize pools and points do that work first.
-- See the handbook's economics section.

-- ───────────────────────────────────────────────────────── seasons

create table public.seasons (
  id serial primary key,
  slug text not null unique,
  name text not null,

  -- 0 = paper trading, 1 = Model Cup (lite), 2 = Builder League, 3 = Humans vs Agents.
  number integer not null unique,

  -- Which execution mode entries run in. Paper and lite seasons exist so Season 0 and 1
  -- can run before the vault is deployed anywhere, and the label has to survive into the
  -- data: a score from a paper season is not comparable to one from a live season, and
  -- presenting them on one leaderboard would be the most misleading thing we could do.
  mode text not null check (mode in ('paper', 'lite', 'vault', 'fast')),

  -- Fixed in USDC at 1e6, never denominated in a token that does not exist.
  prize_pool numeric(78,0) not null default 0,

  starts_at timestamptz not null,
  ends_at   timestamptz not null,
  status    text not null default 'draft' check (status in ('draft', 'open', 'running', 'scored', 'closed')),

  -- The published scoring formula, stored with the season rather than in code. A season's
  -- rules must not change retroactively because someone deployed.
  scoring_notes text,

  created_at timestamptz not null default now(),
  check (ends_at > starts_at)
);

create table public.brackets (
  id serial primary key,
  season_id integer not null references public.seasons (id) on delete cascade,
  slug text not null,
  name text not null,
  -- perps, hip3, hip4, polymarket — the four Builder League brackets.
  market text not null,
  prize_pool numeric(78,0) not null default 0,
  unique (season_id, slug)
);

-- ───────────────────────────────────────────────────────── entries

create table public.entries (
  id uuid primary key default gen_random_uuid(),
  season_id integer not null references public.seasons (id) on delete cascade,
  bracket_id integer references public.brackets (id) on delete set null,

  -- An entry is a builder's agent in a season. `listing_id` is null for paper and lite
  -- seasons, where there is no on-chain listing yet — which is the whole reason those
  -- seasons can run early.
  builder_wallet text not null,
  agent_id uuid,
  listing_id text references public.hl_listings (listing_id) on delete set null,
  vault_address text references public.hl_vaults (address) on delete set null,

  display_name text not null,
  -- Hash only. The plaintext API key is shown once at creation and never stored: a table
  -- of live trading keys is a liability with no upside, and we would be unable to claim
  -- custody safety while holding one.
  api_key_hash text,

  status text not null default 'pending' check (status in ('pending', 'active', 'disqualified', 'withdrawn')),
  disqualified_reason text,

  created_at timestamptz not null default now(),
  unique (season_id, builder_wallet, display_name)
);

create index entries_season_idx on public.entries (season_id, status);

-- ───────────────────────────────────────────────────────── scores

-- Drawdown-adjusted, net-of-fee return, computed from fills only.
--
-- Append-only per (entry, day) so a leaderboard can be replayed as of any date, which is
-- what makes a disputed result checkable instead of arguable.
create table public.scores (
  entry_id uuid not null references public.entries (id) on delete cascade,
  day date not null,

  net_return_bps   integer not null default 0,
  max_drawdown_bps integer not null default 0,
  -- The published formula's output. Stored rather than derived on read so the number a
  -- prize was paid against is the number in the table.
  score numeric(18,6) not null default 0,

  turnover_ratio numeric(12,4) not null default 0,
  fees_paid numeric(78,0) not null default 0,

  computed_at timestamptz not null default now(),
  primary key (entry_id, day)
);

create index scores_day_idx on public.scores (day desc, score desc);

-- ───────────────────────────────────────────────────────── points

-- Append-only ledger. Balances are a sum over this table, never a mutable column, so a
-- points balance can always be explained line by line.
create table public.points_ledger (
  id bigserial primary key,
  wallet text not null,

  -- The reasons points can be awarded for, and the list is the policy.
  --
  -- `volume` is absent *by construction*, not by convention. Volume-based points are an
  -- invitation to wash trade, and the execution fee already rewards turnover — adding
  -- points on top would pay an agent twice for churning a trader's capital. A CHECK
  -- constraint is the right place for that rule because it cannot be forgotten by a
  -- caller the way a code-level guard can.
  reason text not null check (
    reason in (
      'verified_pnl',
      'uptime',
      'aum_attracted',
      'allocation_days',
      'season_placement',
      'referral',
      'manual_adjustment'
    )
  ),

  points numeric(18,6) not null,

  -- What this award is traceable to. A points row with no evidence is a number somebody
  -- typed, and the review queue exists to catch exactly that.
  entry_id   uuid references public.entries (id) on delete set null,
  listing_id text references public.hl_listings (listing_id) on delete set null,
  season_id  integer references public.seasons (id) on delete set null,
  note       text,

  -- Anti-sybil and wash-trade heuristics flag rows for a human rather than silently
  -- dropping them, so a false positive is recoverable and a true positive is on record.
  review_status text not null default 'clear' check (review_status in ('clear', 'flagged', 'rejected')),
  review_note text,

  awarded_at timestamptz not null default now(),
  -- Idempotency for the awarding job: one award per wallet, reason and day.
  award_key text unique
);

create index points_ledger_wallet_idx on public.points_ledger (wallet, awarded_at desc);
create index points_ledger_review_idx on public.points_ledger (review_status)
  where review_status <> 'clear';

-- Only rows a human has not rejected count. Rejecting is therefore reversible and
-- auditable, where deleting would be neither.
create view public.points_balances as
  select wallet, sum(points) as points
  from public.points_ledger
  where review_status <> 'rejected'
  group by wallet;

-- ───────────────────────────────────────── backer stakes

-- Non-transferable curation positions behind an agent.
--
-- Non-transferable is the whole point, and it is why this replaced tradable per-agent
-- sub-tokens: a tradable claim becomes speculation on an asset whose price detaches from
-- the agent's performance, which is the opposite of curation. There is deliberately no
-- column to change the owner, so "transfer" is not a thing the schema can express.
create table public.backer_stakes (
  id uuid primary key default gen_random_uuid(),
  backer_wallet text not null,
  listing_id text not null references public.hl_listings (listing_id) on delete cascade,

  -- Points-denominated, pre-token. $AGENT does not exist and its launch is gated on a
  -- public fee threshold, so denominating these in it now would be a promise we cannot
  -- keep on a schedule we do not control.
  points_staked numeric(18,6) not null check (points_staked > 0),

  staked_at   timestamptz not null default now(),
  unstaked_at timestamptz,

  unique (backer_wallet, listing_id, staked_at)
);

create index backer_stakes_listing_idx on public.backer_stakes (listing_id)
  where unstaked_at is null;

-- ───────────────────────────────────────── referrals

create table public.referrals (
  id uuid primary key default gen_random_uuid(),
  referrer_wallet text not null,
  referred_wallet text not null unique,

  -- 10% of the platform's share for 12 months. Both are stored per row rather than read
  -- from config at payout time, so changing the policy later cannot retroactively alter
  -- what an existing referral was promised.
  share_bps integer not null default 1000 check (share_bps between 0 and 10000),
  expires_at timestamptz not null,

  created_at timestamptz not null default now(),
  check (referrer_wallet <> referred_wallet)
);

create index referrals_referrer_idx on public.referrals (referrer_wallet);

-- ───────────────────────────────────────────────────────── RLS

alter table public.seasons enable row level security;
alter table public.brackets enable row level security;
alter table public.entries enable row level security;
alter table public.scores enable row level security;
alter table public.points_ledger enable row level security;
alter table public.backer_stakes enable row level security;
alter table public.referrals enable row level security;

-- Public: a competition nobody can audit is not a competition.
create policy "seasons are public" on public.seasons for select using (true);
create policy "brackets are public" on public.brackets for select using (true);
create policy "scores are public" on public.scores for select using (true);

-- Entries are public except the key hash, which is excluded by selecting columns in the
-- app rather than by policy. Postgres RLS filters rows, not columns, so a column that
-- must never leave the database should not be selectable at all — see the note below.
create policy "entries are public" on public.entries for select using (true);

-- Points, stakes and referrals are public in aggregate and per-wallet. All three are
-- claims about a wallet that the wallet's owner can already verify, and the leaderboard
-- depends on them being checkable.
create policy "points are public" on public.points_ledger for select using (true);
create policy "stakes are public" on public.backer_stakes for select using (true);
create policy "referrals are public" on public.referrals for select using (true);

-- No insert, update or delete policy anywhere in this file. Every write goes through the
-- service role, which is held by the Arena API and the scoring job and never by a browser.
-- An entrant submits through an authenticated endpoint that validates them; they do not
-- get to write their own score.

-- `api_key_hash` must not be readable by the anon or authenticated roles, even though it
-- is only a hash.
--
-- RLS filters rows, not columns, so this has to be a grant. And it has to be done in this
-- order, which is the part that is easy to get wrong: **a column-level REVOKE does not
-- carve a column out of an existing table-level SELECT grant.** Supabase grants
-- table-level SELECT to anon and authenticated by default, so
-- `revoke select (api_key_hash) ...` on its own silently does nothing — it was written
-- that way here first and a test against real Postgres caught it.
--
-- Revoking the table grant and re-granting column by column is the only mechanism that
-- works. The cost is that a new column is invisible to the app until it is added to this
-- list, which is the right default for a table holding credentials.
revoke select on public.entries from anon, authenticated;
grant select (
  id,
  season_id,
  bracket_id,
  builder_wallet,
  agent_id,
  listing_id,
  vault_address,
  display_name,
  status,
  disqualified_reason,
  created_at
) on public.entries to anon, authenticated;
