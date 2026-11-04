#!/usr/bin/env python3
"""Copy a time window of a recorded day out of the recorder's file, unchanged.

    python3 scorer/tools/slice_recording.py SRC START_MS END_MS COIN [COIN ...] > slice.jsonl

Opens SRC read-only and never writes beside it: the live day file is still being
appended. Keeps the market events (book, trade, ctx) for COIN with START_MS <= atMs <
END_MS, byte for byte, so the slice replays exactly as the original lines would.
"""

import gzip
import json
import sys


def main() -> int:
    src, start, end, *coins = sys.argv[1:]
    start, end, wanted = int(start), int(end), set(coins)
    opener = gzip.open if src.endswith(".gz") else open
    with opener(src, "rt", encoding="utf-8", newline="") as lines:
        for line in lines:
            if not line.endswith("\n"):
                break  # a torn final line: the recorder is mid-append
            event = json.loads(line)
            if event["atMs"] < start:
                continue
            if event["atMs"] >= end:
                break
            data = event.get("book") or event.get("trade") or event.get("ctx") or {}
            if data.get("coin") in wanted:
                sys.stdout.write(line)
    return 0


if __name__ == "__main__":
    sys.exit(main())
