# Supabase

## Read this before running anything

**This migration set is not yet complete, and it will not stand up a working app on a
fresh project.**

The live `agent-circle` project (`lbehucddorwvtmrnlcme`) already contains schema that was
created through the dashboard rather than through migrations: the `agents`, `builders` and
`performance_snapshots` tables, and nine RPCs the app calls —

```
siws_start   siws_verify   submit_agent   get_my_agents   get_my_listings
report_performance   update_my_agent_description   approve_agent   reject_agent
```

`siws_verify` in particular does ed25519 signature verification in Postgres via pgsodium
and mints a session token. **None of that is in this directory**, because it has never
been captured.

It was not reconstructed from the app's queries on purpose. The column list can be
inferred from `select(...)` calls, but the constraints, defaults, grants and the RPC
bodies cannot, and a migration that *almost* matches production is worse than no migration
at all — it diverges silently and the divergence is only discovered when a fresh
environment behaves differently from the live one.

### Capturing the baseline

The project is currently **paused**, so it cannot be introspected. Someone with access
needs to:

```bash
supabase link --project-ref lbehucddorwvtmrnlcme
supabase db pull            # writes the existing schema as a migration
```

That produces the baseline migration this directory is missing. It must sort **before**
the files below, so give it an earlier timestamp than `20261103000100`.

Until that is done, `supabase db reset` on a fresh project gives you the HyperEVM and
Arena tables and an app that cannot sign anyone in.

---

## What is here

| Migration | Contents |
|---|---|
| `20261103000100_hyperliquid_mirror.sql` | On-chain mirror: listings, vaults, fills, daily agent metrics |
| `20261103000200_arena_and_points.sql` | Seasons, brackets, entries, scores, points ledger, backer stakes, referrals |

## Conventions these follow

**Row-level security is on for every table, and the default is deny.** A table with RLS
enabled and no matching policy returns nothing rather than everything, so forgetting a
policy fails closed.

**Writes belong to the service role.** The indexer and keeper hold the service key; the
browser holds the anon key and can only read. Nothing a user submits reaches these tables
through the anon key, because every number in them is supposed to come from a chain rather
than from a claim.

**Idempotency is a constraint, not a convention.** The indexer re-reads overlapping ranges
after a restart, so anything derived from a chain event carries a unique key on its
natural identity (`(vault_address, order_id)` for a fill, `(listing_id, day)` for a daily
metric) and inserts with `on conflict do nothing` or `do update`. Replay safety that
depends on the indexer behaving is not replay safety.

**Prefixed `hl_` for the HyperEVM mirror.** The existing `agents` table is the marketplace
index, which is a different thing from the on-chain registry listing, and conflating the
two is how a leaderboard ends up showing self-reported numbers next to measured ones.

---

## How these were verified

Applied against **Postgres 17** in a throwaway container, with `anon` and `authenticated`
roles and `ALTER DEFAULT PRIVILEGES ... GRANT SELECT ON TABLES`, which is the arrangement
Supabase sets up and therefore the order a migration really runs in. Then exercised:

| Claim | Result |
|---|---|
| `points_ledger` rejects a `volume` reason | ✅ check constraint fires |
| A duplicate fill on `(vault_address, order_id)` is rejected | ✅ unique index fires |
| A second vault for the same `(trader, listing_id)` is rejected | ✅ unique index fires |
| An uppercase address is rejected | ✅ check constraint fires |
| `anon` can `select` from the public tables | ✅ |
| `anon` cannot `insert` | ✅ RLS, no insert policy |
| `anon` cannot read `entries.api_key_hash` | ✅ permission denied |
| `anon` can read the other `entries` columns | ✅ |

**Running it found a real bug.** `entries.api_key_hash` was originally protected with
`revoke select (api_key_hash) on public.entries from anon`. That silently does nothing: a
column-level `REVOKE` cannot carve a column out of an existing **table-level** `SELECT`
grant, and Supabase grants table-level `SELECT` to `anon` by default. The hash would have
been readable by any browser. It now revokes the table grant and re-grants column by
column, which is the only form that works.

Worth knowing about one result that looks like a gap and is not: an `anon` `UPDATE` with no
update policy does not error — it matches zero rows and reports success. That is RLS
failing closed correctly, but it means "the statement succeeded" is not evidence a write
landed. Anything that must confirm a write needs to check the affected row count.

**Not verified:** nothing here has run against the real project, because it is paused and
the baseline above is missing.
