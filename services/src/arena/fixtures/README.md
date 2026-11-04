# Arena fixtures

## `mainnet-2026-11-04T0830Z.jsonl.gz`

Four minutes of recorded Hyperliquid mainnet data, for the replay tests in
`baselines.test.ts`.

- Source: `arena-data/recorder/mainnet/2026-11-04.jsonl`, written by `npm run arena:record`
  (systemd unit `agent-circle-recorder@mainnet`).
- Window: every event with `08:30:00.000 ≤ atMs < 08:34:00.000` UTC, 2026-11-04.
- Coins: BTC (asset 0), ETH (1) and SOL (5), from that directory's `recorder.json`. Lines for
  the other 12 recorded coins are dropped, and nothing else is changed: each kept line is the
  recorded line, byte for byte.
- 2,587 events: 135 books, 1,747 trades and 705 asset contexts. The longest book gap is 6.3 s,
  so the window never reaches `staleBookMs`.
- SHA-256 of the decompressed file:
  `7454f6b6a6c42e3a26aeb44cd909263f9ecf2de31d190af54d04b813304e454c`.
- Compressed with `gzip -9 -n` (no name or timestamp in the header).

The window is clear of the three disturbances in that day's recording:

- a reconnect at about 06:50 UTC (book gaps of 9.0–9.9 s),
- the move to systemd at 07:34 UTC (gaps of 19–20 s on every coin),
- OOM kills and restarts between 10:01 and 10:35 UTC (gaps of up to 5.7 minutes).

To cut another one, filter a day file by `atMs` and coin, keep the lines unchanged, and
`gzip -9 -n` the result.
