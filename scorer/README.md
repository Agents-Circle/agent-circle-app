# Independent scorer

A second implementation of the Circle Arena scorer, so a disputed prize can be settled by
arithmetic. It replays a season's input log and prints the final ranking. Nothing else goes
in: no network, no database, no keys.

    python3 scorer/arena_scorer.py <season.jsonl[.gz]> [--season FILE] [--json]

- Python 3.10+, standard library only. It shares no code with `services/src/arena/`.
- Inputs: the input log (JSONL, bigints as `{"$n":"…"}`, optionally gzipped) and its
  `.season.json`. The rules come from the published page; the season file's `rulesHash`
  proves they are the rules the season ran under.
- The default output is line for line what `npm run arena:replay -- <log>` prints, so the
  two can be diffed. `--json` adds the detail behind each row (fees by kind, funding,
  equity, presence, rejections), a `prizeRank` for eligible entries only (D4), and an
  `audit` block that counts how often each divergence below affected this season.

## Tests

    python3 -m unittest discover -s scorer -v

The fixtures are built by the TypeScript engine itself, so the test checks the scorer
against what the engine does, not what we think it does:

    cd services && npm install && cd ..
    node scorer/tools/make-fixtures.mjs [recorded-slice.jsonl]

| Fixture | What it covers |
| --- | --- |
| `edge-cases` | 17 entries over 3.5 h: thin levels at the 25% share, GTC rest then maker fills, touch vs through, IOC remainder, ALO cross, 8-order limit, reused cloid, expiry at exactly +1 h, reduce-only clamp, exact 12% cap, auto-pause with depth-limited exits, funding both ways, no-mark minute, registration before the start and twice, same-millisecond ties, after-the-end close, every rejection |
| `long-season` | 12 days, 5 entries: eligibility, weekly performance fees, late registration, fills after the end |
| `recorded-mainnet` | 19 minutes of real mainnet BTC, ETH and SOL from the recorder (04 Nov 2026 08:50 UTC, across the 09:00 funding), 6 scripted entries |

For a recorded fixture, cut a window out of a recorder day file with
`scorer/tools/slice_recording.py`. It only reads the source; the recorder directory is
never written.

CI runs the Python tests, and regenerates the synthetic fixtures with the engine and fails
if they change, so an engine change that alters results shows up as a fixture diff.

## Where the engine and the published rules disagree

Sources, in order of authority: the published page (`builders/arena-rules-and-scoring.mdx`),
`SEASON_0` in `rules.ts`, then plan §1 (`handbook/plans/arena-season0.md`). The scorer
reproduces the engine in every case below, so it can check the engine's arithmetic. These
are for a decision, not fixed here — except D1, which was decided on 5 November and is now
applied in both implementations; its remaining half is listed as D1b. The code tags each
behaviour taken from the engine rather than a published source as `[engine]`.

| | Published / plan | Engine | Seen in fixtures |
| --- | --- | --- | --- |
| **D1** ✅ *fills* | "A book older than 10 seconds is not traded against; orders on that asset wait" (page). "Orders on it are held" (plan). | **Applied to trading, 5 November.** A book is stale when `receiveTime − book.timeMs` exceeds the limit: no taker fill on a book already that old on arrival, and no maker fill on a print while the asset's book is. Orders are not cancelled and keep their place. | recorded: never binds (669 books, oldest 1,375 ms); edge: 5 refusals |
| **D1b** | The page says nothing about the mark. | **Still open.** Valuing an account is not trading, so a mark still uses a book mid of any age, and so does the cap check at submit — refusing a stale mid there would *reject* orders during a feed gap, which is the opposite of "they wait". Whether a *recorded* minute mark should accept an old mid is the decision. | edge: 209 marks from an old book |
| **D2** | The first book "with timestamp ≥ t_recv + D" (plan). | Receive times only. A book received after activation counts even if Hyperliquid stamped it earlier. | recorded: 2 activations |
| **D3** | Equity "at mark". The mark source is not published. | The latest `activeAssetCtx.markPx`, however old; the book mid only for an asset that has never had a context. **A position with no mark is valued at zero.** | edge: `sol_long` takes a 977 bps drawdown from one minute with no SOL ask. A feed gap alone can push an entry past the 15% auto-pause |
| **D4** | "An entry is ranked only if it meets both minimums." | Every entry is ranked; `scores.rank` is written for ineligible entries too and the leaderboard reads it. | long: `holder` is rank 1 and not eligible. `--json` gives `prizeRank` |
| **D5** | Weekly assessments "plus a final one at T1" (plan). Page: "assessed weekly". | Weekly only, from max(start, registration). No final assessment, so a late registrant's last part-week is never charged. Separately, the plan's formula compares gross `G_k` with a net high-water mark, which would charge again on flat equity; the engine compares net with net, which looks like the intent, so the plan text needs fixing. | long: 4 weekly fees |
| **D6** | "The rounding error runs in the entrant's favour, never against them." | True for fees and buys. Truncating toward zero works against the entrant on funding receipts, sale proceeds and the value of a long (all under 1e-6 USDC each). | recorded: 1 funding receipt; edge: 3 |
| **D7** | "A public trade prints strictly through its price." | The print's aggressor side is not consulted. Consistent with the page, which is silent on it; listed so it is a decision. | |
| **D8** | Reservations release on cancel or expiry, "never when it fills". | An ALO that would cross and an IOC remainder also keep their reservation and open-order slot until cancel or expiry. That is the vault's behaviour (it cannot see either), but the page doesn't say it: an ALO refused at activation costs one of 8 slots for an hour. | edge, recorded: `alo`, `ioc` |
| **D9** | Presence: "a position or resting order". | An order still inside its 2 s activation delay also counts. | |
| **D10** | Not published. | Orders are refused from `endMs`, but orders already resting keep filling from prints after it, and **those fill days count toward the 10-day minimum**. The mark at exactly `endMs` is included. | long: `after_end` is eligible only because of a fill after the end (prize rank 3) |
| **D11** | `S = R − λ·MDD`, real-valued. | R, MDD and S are each truncated to whole bps before comparing. Under a 12% cap, returns are small, so entries less than 1 bp apart tie and go to the tie-breaks. Same-millisecond registrations fall back to log order. | edge: 3 entries tie at 1 bp, 9 at 0 |
| **D12** | The page prints a rules hash. | The hash is SHA-256 of JSON with sorted keys in which the bigint-typed fields are strings and the rest numbers. Which is which lives only in `rules.ts`, so nobody can recompute the hash from the page alone. Publish the canonical JSON beside the hash. | |
| **D13** | House baselines are not prize-eligible; at most 2 entries per builder, one designated for prizes (plan §1). | Nothing in the input log says which entries are baselines or designated, so neither the engine nor this scorer applies these rules. A prize list needs them from outside the log. | |
| **D14** | "15% from the high-water mark, then auto-pause." | Checked only at minute marks, against the highest marked equity. A weekly performance fee lowers equity at the mark, so the fee counts as drawdown. Between marks, new orders are refused at current equity but the entry isn't paused. | edge: `paused` |

## Not verified

- Real data covers 19 minutes and 3 coins. Weekly performance fees, multi-day eligibility
  and auto-pause run only on synthetic books.
- Speed on a full recorded day (~135 MB compressed, 15 coins) with many entries hasn't been
  measured. The recorded fixture replays 11.6k events in about 2 s.
- `capMode: "per_position"` is implemented but not exercised; Season 0 is aggregate.
- No fixture has two entries with the same score and different drawdowns, so the first
  tie-break runs only through the sort key.
