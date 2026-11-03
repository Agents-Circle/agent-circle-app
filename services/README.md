# services

Two long-running processes behind the HyperEVM vaults.

| | |
|---|---|
| **indexer** | Reads the registry, the factory, the vault clones and the Hyperliquid info API; writes the mirror the app reads and rolls up the daily agent metrics. |
| **keeper** | Calls `reconcile` on the vaults that need it, and watches the ones running in fast mode. |

Both are plain Node. There is no build step: Node 22.18+ strips the types and runs the
`.ts` files directly, which is why relative imports carry their real `.ts` extension and
why `tsconfig.json` sets `erasableSyntaxOnly` — no `enum`, no `namespace`, no parameter
properties, because those would need a compiler.

```bash
npm install
cp .env.example .env     # then fill it in

npm run typecheck
npm test

npm run indexer          # add -- --once for a single pass
npm run keeper
```

---

## What the keeper can and cannot do

This is the part to read before deploying anything.

The keeper's only authority is `reconcile`, which is **permissionless** — anyone can call
it, and everything it does is either neutral or in the trader's favour. `pause` is
`onlyTrader`. `cancelOrder` is `onlyTraderOrAgent`. The keeper is neither, by design: a
key that could pause vaults is a key worth stealing.

So:

- **A drawdown breach has a remedy the keeper can trigger.** `reconcile` pauses the vault
  and sends reduce-only closes once drawdown reaches the limit. The keeper's contribution
  is calling it sooner than anyone else would, which is why the poll interval is the real
  bound on how far past the limit a vault can travel.
- **A position-cap breach in fast mode does not.** In fast mode orders reach HyperCore
  without passing through the vault, so the cap is observed rather than enforced, and once
  a position is oversized there is no call the keeper is authorised to make that reduces
  it. It records the breach in `keeper_actions` and logs at error level. The remedies are
  the trader's (pause, withdraw) and governance's (suspend the listing) — both of them
  people, who have to be told.

That asymmetry is exactly what a trader accepts when the UI makes them type *"monitored,
not enforced"* before fast mode can be enabled. Nothing here should ever be described as
enforcing a limit in fast mode.

### Why the execution fee needs the keeper at all

The vault charges its execution fee at `reconcile`, on `|szi_now - szi_last| * markPx`
summed across tracked assets. A position opened and closed entirely between two reconciles
shows no net change and is **not billed**. That is a revenue loss rather than a trader
harm, and it is the correct direction to be wrong in — the alternative, billing requested
size at `placeOrder`, charges for orders HyperCore rejected. But it means an idle keeper is
an unpaid platform, and that is why fills since the last reconcile are one of the reasons
to call it.

---

## Sending transactions

Nothing is signed unless `KEEPER_SEND=true`. The default is a dry run that makes every
decision, writes every audit row with `sent = false`, and signs nothing — so "what would
the keeper have done" is a question with an answer in the database.

On **mainnet**, `KEEPER_SEND=true` is not enough. `KEEPER_MAINNET_ACK` must be set to
exactly:

```
I have read services/README.md and accept that this signs mainnet transactions
```

A boolean would be copied out of the example file without being read. The thing being
acknowledged is that these contracts have never been audited and, at the time of writing,
have only ever run against a mocked HyperCore — and that `reconcile` can pause a live vault
and fire reduce-only closes against somebody's real position.

The keeper's key needs HYPE for gas and nothing else. It holds no authority over any
vault's funds, so a leak costs gas.

---

## Units

The contracts work in integers; the info API returns decimal strings. Nothing in these
services parses a decimal through a float — `parseDecimal` reads digit by digit and
truncates toward zero, so the error is always against us and never against a trader.

| | Scale |
|---|---|
| `hl_fills.size`, `hl_orders.size` | 1e8, signed for fills |
| `hl_fills.price` | 1e8 |
| Everything denominated in money | 1e6 (USDC) |

Size and price at 1e8 to match the order encoding the contracts use, so a fill can be
compared against the `OrderPlaced` event that caused it without converting either.

---

## What the numbers mean

`agent_metrics_daily` is computed per **listing**, not per vault: an agent running in nine
vaults has one track record, and the rows are combined by the capital each vault actually
held. A 50% gain on $100 beside a 1% loss on $1,000,000 is a loss.

- `net_return_bps` — after every fee, venue and ours. **Ranking uses this.**
- `gross_return_bps` — before every fee. Shown beside net so the fee drag is visible.
- `fees_paid` — venue + execution + performance, USDC at 1e6.

Deposits and withdrawals are excluded, or a trader funding a vault would read as a return.
Hyperliquid's own fees are already inside HyperCore's `accountValue`; **ours are not**, so
net subtracts them explicitly — without that, every agent is flattered by exactly our take.

`fees_exceed_profit` is the 30-day guardrail. Because gross profit is net plus fees,
`fees > gross` is the same statement as `net < 0`: there is no way to pay out an unflagged
fee on a losing month.

---

## Known limits, written down rather than assumed away

- **Equity is sampled at `Reconciled` events.** A 40% dip between two reconciles is
  invisible to `max_drawdown_bps` — exactly as it is invisible to the on-chain auto-pause,
  which is also only evaluated at reconcile. The daily figure is a lower bound.
- **Reorgs.** Each pass re-scans the last `INDEXER_CONFIRMATIONS` blocks, which is free
  because every table is keyed on a log's own identity. It covers a shallow reorg that
  *adds* logs. Nothing here deletes, so a log reorged out stays in the mirror.
- **The leaderboard depends on an off-chain API.** There is no precompile that enumerates
  fills, so history comes from Hyperliquid's info API. The claim is not "no server is
  involved", it is "every number traces to a fill Hyperliquid reports and anyone can
  re-fetch" — which is why fills are stored with their order ids.
- **`hl_fills.execution_fee` is always zero.** Our fee is not a per-fill quantity; see
  above. The accrued figure reaches `agent_metrics_daily.fees_paid` instead.
- **The keeper trusts the mirror for one thing only**: which orders are outstanding, which
  the chain genuinely cannot answer. Everything a decision turns on is read from the chain
  in the same pass.

---

## Deployment shape

Both are single processes with no shared state beyond Postgres, and both are safe to
restart at any point — the cursor advances only after a range's writes land, so a crash
re-does work rather than skipping it.

Run **one indexer per chain**. Two would duplicate work harmlessly but double the RPC load.
Run **one keeper**; two would race to reconcile the same vault and one would pay gas for a
transaction that reverts nothing.
