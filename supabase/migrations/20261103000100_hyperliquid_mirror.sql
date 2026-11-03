-- HyperEVM on-chain mirror.
--
-- Everything here is derived from a chain: registry events, vault events, and fills read
-- from the Hyperliquid info API. Nothing in this file is ever written by a user, which is
-- why the write policies are service-role only and why the leaderboard can be trusted in
-- a way the existing self-reported `performance_snapshots` table cannot.
--
-- Addresses and ids are stored as lowercase hex text rather than bytea. Postgres has no
-- native 20-byte type, bytea comparisons against a JSON-RPC response mean encoding on
-- every query, and the indexer, the app and a human reading psql all hold these as
-- `0x…` strings. A CHECK keeps the casing honest so `=` is reliable.

-- ───────────────────────────────────────────────────────── helpers

create or replace function public.is_hex_address(value text)
  returns boolean
  language sql
  immutable
as $$
  select value ~ '^0x[0-9a-f]{40}$';
$$;

create or replace function public.is_hex32(value text)
  returns boolean
  language sql
  immutable
as $$
  select value ~ '^0x[0-9a-f]{64}$';
$$;

-- ───────────────────────────────────────────────────────── listings

-- Mirror of `AgentRegistry` listings. Deliberately separate from the `agents` marketplace
-- index: an agent can exist in the catalogue with no on-chain listing, and a listing is
-- the only thing a vault can actually be opened against.
create table public.hl_listings (
  listing_id      text primary key check (public.is_hex32(listing_id)),
  chain_id        integer not null,
  builder         text not null check (public.is_hex_address(builder)),
  agent_authority text not null check (public.is_hex_address(agent_authority)),

  -- Mirrors `IAgentRegistry.ListingStatus`. Text rather than an enum so a new on-chain
  -- status does not require a migration before the indexer can record what it saw.
  status text not null check (
    status in ('None', 'Vetting', 'Live', 'Rejected', 'Suspended', 'Delisted')
  ),

  performance_fee_bps          integer not null default 0 check (performance_fee_bps between 0 and 10000),
  builder_split_bps            integer not null default 0 check (builder_split_bps between 0 and 10000),
  execution_fee_bps            integer not null default 0 check (execution_fee_bps between 0 and 10000),
  execution_builder_split_bps  integer not null default 0 check (execution_builder_split_bps between 0 and 10000),
  position_cap_bps             integer not null default 0 check (position_cap_bps between 0 and 10000),
  max_drawdown_bps             integer not null default 0 check (max_drawdown_bps between 0 and 10000),

  metadata_hash text check (public.is_hex32(metadata_hash)),

  -- Optional link to the marketplace catalogue. Nullable because the on-chain listing is
  -- the source of truth and may be indexed before anyone writes catalogue copy for it.
  agent_id uuid,

  -- How far the indexer has got. Lets a restart resume rather than re-read from genesis.
  last_block bigint not null default 0,
  updated_at timestamptz not null default now()
);

create index hl_listings_builder_idx on public.hl_listings (builder);
create index hl_listings_status_idx on public.hl_listings (status);
create index hl_listings_agent_idx on public.hl_listings (agent_id);

-- ───────────────────────────────────────────────────────── vaults

-- One row per clone. The address is the primary key because on HyperEVM the vault's
-- address *is* its HyperCore account — there is no more canonical identifier available.
create table public.hl_vaults (
  address    text primary key check (public.is_hex_address(address)),
  chain_id   integer not null,
  trader     text not null check (public.is_hex_address(trader)),
  listing_id text not null references public.hl_listings (listing_id) on delete restrict,

  status text not null default 'Active' check (status in ('None', 'Active', 'Paused', 'Closing')),

  -- USDC at 1e6, as HyperCore reports it. numeric(78,0) rather than bigint: these are
  -- uint64 today but the same columns will hold uint256 values if anything here ever
  -- denominates in wei, and widening a column later under live traffic is the kind of
  -- migration nobody enjoys.
  equity              numeric(78,0) not null default 0,
  high_water_mark     numeric(78,0) not null default 0,
  reserved            numeric(78,0) not null default 0,
  pending_bridge      numeric(78,0) not null default 0,
  pending_withdrawal  numeric(78,0) not null default 0,
  accrued_builder_fee numeric(78,0) not null default 0,
  accrued_platform_fee numeric(78,0) not null default 0,

  open_orders        integer not null default 0,
  position_cap_bps   integer not null default 0,
  max_drawdown_bps   integer not null default 0,

  -- Zero address when fast mode is off, mirroring the contract rather than using NULL, so
  -- a reader never has to know which representation means "off".
  api_wallet text not null default '0x0000000000000000000000000000000000000000'
    check (public.is_hex_address(api_wallet)),

  opened_at        timestamptz not null default now(),
  last_reconciled  timestamptz,
  updated_at       timestamptz not null default now()
);

create index hl_vaults_trader_idx on public.hl_vaults (trader);
create index hl_vaults_listing_idx on public.hl_vaults (listing_id);

-- A trader opens at most one vault per listing, which the factory enforces on-chain via a
-- deterministic salt. Repeated here so a mirror bug cannot invent a second one.
create unique index hl_vaults_trader_listing_idx on public.hl_vaults (trader, listing_id);

-- Fast mode is the mode where limits are monitored rather than enforced, so the keeper
-- needs to find those vaults cheaply and without scanning every row.
create index hl_vaults_fast_mode_idx on public.hl_vaults (chain_id)
  where api_wallet <> '0x0000000000000000000000000000000000000000';

-- ───────────────────────────────────────────────────────── fills

-- Fills from the Hyperliquid info API (`userFills`), keyed by vault address.
--
-- This table is the foundation of every ranking claim the product makes. If a number on
-- the leaderboard cannot be traced to a row here, it does not belong on the leaderboard.
create table public.hl_fills (
  id bigserial primary key,
  vault_address text not null references public.hl_vaults (address) on delete cascade,

  asset     integer not null,
  coin      text,
  is_buy    boolean not null,
  -- Signed, so a close is distinguishable from an open without reconstructing state.
  size      numeric(78,0) not null,
  price     numeric(78,0) not null,
  notional  numeric(78,0) not null,

  -- Hyperliquid's own fee, and separately ours. Keeping them apart matters: net-of-fee
  -- ranking has to subtract both, and conflating them would hide which one is growing.
  venue_fee     numeric(78,0) not null default 0,
  execution_fee numeric(78,0) not null default 0,

  closed_pnl numeric(78,0) not null default 0,

  order_id bigint,
  cloid    text,
  -- Hyperliquid reports fill times in milliseconds.
  filled_at timestamptz not null,
  recorded_at timestamptz not null default now()
);

-- Idempotency. The indexer re-reads overlapping windows after a restart, and `userFills`
-- is paginated by time rather than by cursor, so overlap is the normal case rather than
-- an error path. `order_id` is unique per account on Hyperliquid.
create unique index hl_fills_vault_order_idx on public.hl_fills (vault_address, order_id)
  where order_id is not null;

create index hl_fills_vault_time_idx on public.hl_fills (vault_address, filled_at desc);
create index hl_fills_asset_idx on public.hl_fills (asset);

-- ───────────────────────────────────────── daily metrics

-- One row per listing per day, computed from `hl_fills` and vault equity.
--
-- Pre-aggregated rather than computed on read because the leaderboard is the most-read
-- surface in the product and a per-request scan of every fill would be the first thing to
-- fall over.
create table public.agent_metrics_daily (
  listing_id text not null references public.hl_listings (listing_id) on delete cascade,
  day date not null,

  -- Both, always. Ranking uses net; showing gross beside it is what makes the fee drag
  -- visible, and the fee drag is the thing the execution fee makes worth watching.
  gross_return_bps integer not null default 0,
  net_return_bps   integer not null default 0,

  max_drawdown_bps integer not null default 0,

  -- Notional traded over the day, and the same figure as a multiple of equity. Turnover is
  -- shown on every listing by design: it is how a trader sees a churning agent.
  notional         numeric(78,0) not null default 0,
  turnover_ratio   numeric(12,4) not null default 0,

  fees_paid        numeric(78,0) not null default 0,
  equity_close     numeric(78,0) not null default 0,
  high_water_mark  numeric(78,0) not null default 0,

  -- The 30-day "fees exceeded gross profit" condition, evaluated by the keeper and stored
  -- so the flag has an audit trail rather than being recomputed and forgotten.
  fees_exceed_profit boolean not null default false,

  computed_at timestamptz not null default now(),
  primary key (listing_id, day)
);

create index agent_metrics_daily_day_idx on public.agent_metrics_daily (day desc);

-- ───────────────────────────────────────────────────────── RLS
--
-- Enabled on every table. With RLS on and no matching policy a query returns nothing
-- rather than everything, so a forgotten policy fails closed.
--
-- Reads are public: the whole point of computing returns from fills is that anyone can
-- check them. Writes have no policy at all, which means only the service role — holding
-- the key the indexer and keeper use — can perform them. No user-submitted number ever
-- reaches these tables.

alter table public.hl_listings enable row level security;
alter table public.hl_vaults enable row level security;
alter table public.hl_fills enable row level security;
alter table public.agent_metrics_daily enable row level security;

create policy "listings are public" on public.hl_listings for select using (true);
create policy "fills are public" on public.hl_fills for select using (true);
create policy "daily metrics are public" on public.agent_metrics_daily for select using (true);

-- Vaults are public too, and that is a deliberate choice rather than an oversight. A vault
-- address is already visible on-chain, its equity is readable from a precompile by anyone,
-- and the product's claim is that performance is verifiable. Hiding it here would protect
-- nothing while making the claim unauditable.
--
-- Note what is *not* here: no column holds anything a trader did not put on a public
-- chain. If that ever changes, this policy has to change with it.
create policy "vaults are public" on public.hl_vaults for select using (true);
