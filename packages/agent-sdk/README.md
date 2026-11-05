# @agent-circle/agent-sdk

Clients for building an Agent Circle agent: trade Circle Arena on paper, then trade a real
`HLAgentVault` on HyperEVM testnet with the same code.

| | |
|---|---|
| `PaperClient` | Circle Arena's order API (Season 0): place, cancel, read the account. |
| `VaultClient`, `findVault` | Vault mode: `placeOrder`, `cancelOrder`, `cancelAll`, `reconcile` and the vault's reads, through viem, and the factory lookup for a trader's clone. **Signs on HyperEVM testnet (998) only.** |
| `InfoClient` | Hyperliquid's public info API: asset indices from `meta`, the top of book, an order's status on HyperCore. No key. |
| `roundPrice`, `roundSize`, `sizeForNotional` | Prices and sizes on Hyperliquid's tick, as exact decimal strings. |
| `agentAccountFromEnv` | The agent's key from a Foundry keystore (or, for throwaway testnet keys, the environment). |

Both trading clients take the same order, in the shape `HLAgentVault.placeOrder` takes:

```ts
{ asset: 0, isBuy: true, limitPx: "99490", sz: "0.00012", tif: "alo", cloid: 123n }
```

An agent that trades the Arena is already written against a vault.

> **Paper trading. Simulated fills on live Hyperliquid prices. No funds at risk. Not an
> on-chain track record.** Anything that shows Arena results must carry this label.

## Status

| | |
|---|---|
| Paper client against the real Arena engine and order API | ✅ Tested in-process over HTTP (`npm test`), and run against a local Arena on Hyperliquid's live mainnet feed |
| Vault client: calldata, simulate-then-send, revert names, `OrderPlaced` check, testnet-only guard | ✅ Tested against a mock node |
| Vault client reads against the live testnet deployment: factory and registry wiring, whitelist queue, `findVault` | ✅ `npm run testnet:check`, run 2026-11-04 |
| Foundry keystores | ✅ Tested against a keystore written by `cast wallet new` |
| **An order placed through a real vault on testnet, end to end** | ❌ **Not done.** Testnet markets become executable at 2026-11-06 02:35 UTC, and the run needs a live listing, a funded vault and keys held by a person. The command is below. |
| Fast mode and lite mode (orders signed by an API wallet) | Not in this package. Whether fast mode exists at launch is an open decision. |
| Example agents for other market types (HIP-3, spot) | Not yet. One perps example. |

---

## Your first agent, in an hour

You need Node 22.18 or later. Nothing else: no wallet, no database, no keys.

### 1. Install (5 minutes)

```bash
cd packages/agent-sdk
npm install
```

### 2. Start an Arena on your machine (1 minute)

```bash
npm run arena:local
```

This is the Season 0 engine and order API from `services/src/arena`, unchanged, fed by
Hyperliquid's live public WebSocket, with no database and one API key. It prints the key:

```
ARENA_API_KEY=Jx3…
```

It reads mainnet's feed by default because Season 0 does. `ARENA_COINS` (default
`BTC,ETH,SOL`), `NETWORK=testnet` and `ARENA_PORT` (default 8787) change that.

### 3. Run the example agent (1 minute)

In a second terminal:

```bash
ARENA_API_KEY=Jx3… npm run example:perp
```

```json
{"msg":"Paper trading. Simulated fills on live Hyperliquid prices. No funds at risk. Not an on-chain track record."}
{"msg":"quote","coin":"BTC","network":"mainnet","asset":0,"isBuy":true,"limitPx":"77916","sz":"0.00015","tif":"alo","cloid":"6129…"}
{"msg":"paper order accepted","cloid":"6129…"}
{"msg":"paper account","equity":"10000000000","order":"pending"}
{"msg":"paper order cancelled"}
```

It read BTC's asset index from `meta`, rested a post-only bid 50 bps under the best bid,
sized at $11, found it in the account, and cancelled it. `COIN`, `OFFSET_BPS` and
`NOTIONAL_USD` change the quote. The code is [`examples/perp-quote.ts`](examples/perp-quote.ts).

### 4. Write your own (the rest of the hour)

Put it next to the example, say `examples/my-agent.ts`, and run it with
`node examples/my-agent.ts`. The package isn't published, and Node won't strip types from
`.ts` files inside `node_modules`, so it can't be installed as a dependency until it has a
build step.

```ts
import { InfoClient, PaperClient, roundPrice, sizeForNotional } from "../src/index.ts";

const info = new InfoClient({ network: "mainnet" }); // the network the Arena trades
const arena = new PaperClient({ baseUrl: "http://127.0.0.1:8787", apiKey: process.env.ARENA_API_KEY! });

const eth = await info.market("ETH"); // { asset, szDecimals } from meta, never hardcoded
const { ask } = await info.bookTop("ETH");
const limitPx = roundPrice(ask, eth.szDecimals, "up");

const verdict = await arena.placeOrder({
  asset: eth.asset,
  isBuy: false,
  limitPx,
  sz: sizeForNotional("25", limitPx, eth.szDecimals),
  tif: "alo",
});
if (!verdict.accepted) console.log("rejected:", verdict.reason); // e.g. PositionCapExceeded

const account = await arena.account(); // equity (USDC 1e6), positions (1e8), orders, fees
await arena.cancelAll();
```

`placeOrder` answers with the engine's verdict straight away. `accepted` means the order
passed the vault's checks and holds a reservation, not that it filled. It activates two
seconds later against the next book, and fills show up in `account()`.

### 5. Trade the real Arena

Same code, different URL and key. Season operators issue entry keys with
`npm run arena:admin -- entry issue …` (see `services/README.md`). The key is shown once.

```bash
ARENA_URL=https://… ARENA_API_KEY=… npm run example:perp
```

---

## Going live: vault mode on HyperEVM testnet

In vault mode the agent calls `placeOrder` on a trader's `HLAgentVault` clone. The vault
checks its limits before the order reaches HyperCore through CoreWriter. The agent's key
is the listing's **agent authority**: it can place and cancel orders and nothing else.

### Before you start

1. **A live listing whose `agentAuthority` is your agent's address.** The builder submits
   it and governance approves it.
2. **A vault for that listing**, deployed by a trader through the factory and funded with
   at least **100 USDC**. Under a 12% position cap, 15 USDC can't carry Hyperliquid's $10
   minimum order.
3. **An executable market.** Check with:

   ```bash
   npm run testnet:check
   ```

   ```
   BTC   asset 3    szDecimals 5  queued at 1200 bps, executable from 2026-11-06T02:35:34.000Z (governance must call executeAddition)
   ```

   It exits non-zero until every coin reads `listed: orders allowed`. Add the trader and
   listing to find the vault the factory deployed for them (`findVault` in code):

   ```bash
   TRADER=0x<trader> LISTING_ID=0x<listing id> npm run testnet:check
   ```

   Trade only an address this reports as `deployed`, never one you were handed.
4. **The agent key in a Foundry keystore**, holding a little testnet HYPE for gas:

   ```bash
   cast wallet import agent --interactive
   ```

   Never paste a key into a file, a chat or a repository.

### Run

```bash
MODE=vault VAULT=0x<vault clone> AGENT_KEYSTORE=agent COIN=BTC npm run example:perp
```

It prompts for the keystore password (or reads `KEYSTORE_PASSWORD_FILE`), then:

1. Reads the vault, the listing and the whitelist, and stops with a reason if the vault
   isn't `Active`, the listing isn't `Live`, the key isn't the agent authority or the
   market isn't executable.
2. Simulates `placeOrder` and stops with the contract's error name if it would revert.
3. Sends it, waits for the receipt and checks for the `OrderPlaced` event.
4. Polls HyperCore's `orderStatus` for the cloid until Core answers (`open`, or a
   rejection).
5. Cancels through the vault and polls until Core no longer shows it open.

**Not run yet.** Record the transaction hashes and Core's statuses in the PR or in
`agent-circle-evm/docs/runbooks/testnet-e2e.md` when it is.

### What a mined `placeOrder` doesn't tell you

CoreWriter is fire-and-forget. A mined `placeOrder` means the vault's checks passed and
the action was handed to HyperCore, which acts on it a few seconds later. If Core rejects
it (off-tick price, under $10, no margin in the perp balance) **the vault never hears
about it** and keeps the reservation until the order expires. That's why the example asks
Core directly, and why `placeOrder` checks the tick when you pass `szDecimals`.

---

## Rules that will bite you

- **Never hardcode an asset index.** On testnet BTC is 3 and ETH 4; on mainnet BTC is 0.
  The contract checks that an index is whitelisted, not that it's the coin you meant.
  Read `meta` (`InfoClient.market`) from the network you are trading, and for paper, from
  the network the Arena reads (mainnet for Season 0).
- **Ticks.** At most five significant figures and `6 − szDecimals` decimals, and sizes in
  whole lots. Use `roundPrice` and `roundSize`. The Arena rejects off-tick orders
  (`InvalidPrice`, `InvalidSize`); HyperCore drops them silently.
- **$10 minimum notional** on Hyperliquid. `sizeForNotional` rounds up so you stay above it.
- **Cancel what you're done with.** A vault can't see fills, so a reservation is released
  only by a cancel or by expiry (one hour), never by a fill. The Arena does the same. With
  eight open orders at most, an agent that never cancels stops trading.
- **The position cap counts reservations.** Every open order's worst-case cost
  (`sz × limitPx`) counts against `equity × cap` (12% by default), on top of positions at
  mark.
- **Drawdown.** At the vault's drawdown limit (15% by default) below the high-water mark,
  it refuses new orders, and `reconcile` pauses it and closes positions.
- **Testnet only.** `VaultClient` refuses to sign on any chain but 998. There's no mainnet
  deployment, and the contracts are unaudited.

## Development

```bash
npm run typecheck
npm test
```

Node runs the `.ts` files directly (type stripping), like `services/`: no build step,
relative imports carry `.ts`, and `erasableSyntaxOnly` rules out `enum` and friends. The
tests start the real Arena engine from `services/src/arena` in-process. `src/abis/` is
generated by `npm run sync-abis` at the repo root, together with the app's and the
services' copies.
