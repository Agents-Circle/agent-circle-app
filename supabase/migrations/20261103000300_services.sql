-- What the indexer and keeper need that the mirror did not provide.
--
-- Written while building the services rather than guessed at beforehand, which is why it
-- is a third migration instead of an edit to the first: the three tables here each exist
-- because a service could not do its job without them.

-- ───────────────────────────────────────────────────────── orders
--
-- `reconcile(uint128[] staleCloids)` takes the cloids to release. The vault stores
-- reservations in a `mapping(uint128 => Reservation)`, and a Solidity mapping cannot be
-- enumerated — so **there is no way to ask the chain which orders are outstanding.** The
-- only record is the `OrderPlaced` / `OrderReleased` event pair, which makes this table a
-- hard dependency of the keeper rather than a convenience.
--
-- It follows that a keeper starting with an empty database cannot release anything until
-- it has re-read the logs. The indexer's cursor therefore has to be durable, and the
-- keeper refuses to act on vaults the indexer has not caught up on.
create table public.hl_orders (
  vault_address text not null references public.hl_vaults (address) on delete cascade,
  -- uint128, so numeric rather than bigint.
  cloid numeric(39,0) not null,

  asset integer not null,
  is_buy boolean not null,
  -- Order size at 1e8 and the worst-case USDC (1e6) the vault reserved for it. The pair
  -- is what makes an over-reservation visible: `maxCost` against the notional of the
  -- fills that followed.
  size numeric(78,0) not null,
  max_cost numeric(78,0) not null,

  -- `MAX_ORDER_LIFETIME` after placement. The keeper passes a cloid to `reconcile` only
  -- once this has passed, because the contract silently skips anything that has not.
  expires_at timestamptz not null,

  released_at timestamptz,
  -- The contract's own word for why: "expired", "cancelled", "filled".
  released_reason text,

  placed_at timestamptz not null,
  placed_block bigint not null,
  primary key (vault_address, cloid)
);

-- The keeper's query, and the reason this index exists rather than a plain scan: find the
-- outstanding orders for one vault. Partial, because released orders are history and the
-- table only grows.
create index hl_orders_open_idx on public.hl_orders (vault_address, expires_at)
  where released_at is null;

-- ───────────────────────────────────────────────────────── vault events
--
-- Every event a vault emits, stored raw and append-only.
--
-- This is the one table the rollups are computed *from*, and the reason it exists rather
-- than four typed tables is idempotency. `agent_metrics_daily` needs the day's execution
-- fees, its performance-fee assessments, its deposits and withdrawals, and the equity and
-- high-water mark at the last reconcile — five different events. Accumulating those into
-- the daily row as they arrive would make a re-scanned block range double-count, and the
-- indexer re-scans block ranges every time it restarts.
--
-- Stored against `(vault, block, log_index)`, which is a log's actual identity, a day's
-- metrics become a pure function of the rows for that day: recomputing is free and
-- re-scanning changes nothing. `args` is jsonb because the alternative is a column per
-- event field and a migration per contract change; the typed meaning lives in the derived
-- tables, which is where a reader should look for it.
create table public.hl_vault_events (
  vault_address text not null references public.hl_vaults (address) on delete cascade,
  block_number bigint not null,
  log_index integer not null,

  name text not null,
  -- Numbers are strings in here. A uint64 of USDC exceeds jsonb's double precision at
  -- about 9 billion, and `jsonb` stores numerics as... numeric, but `JSON.parse` on the
  -- way back out does not. Strings cross that boundary intact.
  args jsonb not null,

  occurred_at timestamptz not null,
  tx_hash text not null,
  primary key (vault_address, block_number, log_index)
);

create index hl_vault_events_name_idx on public.hl_vault_events (vault_address, name, occurred_at desc);
create index hl_vault_events_day_idx on public.hl_vault_events (occurred_at desc);

-- ───────────────────────────────────────────────────────── cursors
--
-- Where each service got to. One row per (service, chain), updated after the work for a
-- range is committed — never before, so a crash re-does a range rather than skipping it.
-- Every derived table has a unique key on its natural identity precisely so that re-doing
-- a range is free.
create table public.indexer_cursors (
  service text not null check (service in ('indexer', 'keeper')),
  chain_id integer not null,

  last_block bigint not null default 0,
  -- Fills are paginated by time, not by block: `userFillsByTime` has no notion of a
  -- block. So the fill cursor is a millisecond timestamp and is kept separately.
  last_fill_time_ms bigint not null default 0,

  updated_at timestamptz not null default now(),
  primary key (service, chain_id)
);

-- ───────────────────────────────────────────────────────── keeper actions
--
-- An audit trail of what the keeper did, what it decided not to do, and why.
--
-- Public, like the fills, and for the same reason: in fast mode the product's claim is
-- that limits are *monitored*, and a monitor nobody can inspect is a claim rather than a
-- control. A dry run writes rows here too, with `sent = false`, so the gap between what a
-- keeper would have done and what it did is in the data.
create table public.keeper_actions (
  id bigserial primary key,
  chain_id integer not null,
  vault_address text not null,

  action text not null check (action in ('reconcile', 'breach_detected', 'skipped', 'failed')),
  -- The decision's reasons, as the keeper's policy names them: pending_bridge,
  -- stale_reservations, fills_since_reconcile, drawdown_near_limit, interval.
  reasons text[] not null default '{}',

  -- What the state looked like when the decision was made. Stored rather than re-read,
  -- because the point of an audit trail is to answer "why did it do that then".
  equity numeric(78,0),
  high_water_mark numeric(78,0),
  drawdown_bps integer,
  stale_cloids numeric(39,0)[] not null default '{}',

  -- False for a dry run or a refused mainnet send. A row with sent = false is the keeper
  -- saying what it would have done.
  sent boolean not null default false,
  tx_hash text,
  error text,

  created_at timestamptz not null default now()
);

create index keeper_actions_vault_idx on public.keeper_actions (vault_address, created_at desc);
create index keeper_actions_breach_idx on public.keeper_actions (created_at desc)
  where action = 'breach_detected';

-- ───────────────────────────────────────────────────────── units
--
-- The scales the mirror stores, recorded in the database rather than only in the service
-- that writes them. A column of `numeric(78,0)` with no stated scale is a number nobody
-- can interpret six months later, and the first person to guess will guess 1e18.
comment on column public.hl_fills.size is 'Signed, 1e8 — matches the order encoding the contracts use.';
comment on column public.hl_fills.price is '1e8.';
comment on column public.hl_fills.notional is 'USDC, 1e6.';
comment on column public.hl_fills.venue_fee is 'USDC, 1e6. Hyperliquid''s fee, not ours.';
comment on column public.hl_fills.execution_fee is 'USDC, 1e6. Ours, as accrued by the vault at reconcile.';
comment on column public.hl_fills.closed_pnl is 'USDC, 1e6.';
comment on column public.hl_orders.size is '1e8.';
comment on column public.hl_orders.max_cost is 'USDC, 1e6. Worst-case cost the vault reserved.';

-- ───────────────────────────────────────────────────────── RLS

alter table public.hl_orders enable row level security;
alter table public.hl_vault_events enable row level security;
alter table public.indexer_cursors enable row level security;
alter table public.keeper_actions enable row level security;

-- Orders and keeper actions are public for the same reason fills are.
create policy "orders are public" on public.hl_orders for select using (true);
create policy "vault events are public" on public.hl_vault_events for select using (true);
create policy "keeper actions are public" on public.keeper_actions for select using (true);

-- Cursors are not. They say nothing a reader wants and everything an attacker does:
-- exactly how far behind the indexer is, which is the window in which a stale number on
-- the leaderboard can be relied upon. No select policy, so only the service role reads
-- them.

-- Belt as well as braces. RLS with no select policy already returns nothing, but it
-- returns *nothing* rather than an error, and a permissive policy added later by someone
-- who did not read this comment would open it. Revoking the grant means the table is
-- unreadable whatever the policies say.
revoke select on public.indexer_cursors from anon, authenticated;
