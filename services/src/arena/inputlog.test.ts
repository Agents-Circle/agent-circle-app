import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { InputEvent } from "./engine.ts";
import { decodeEvent, encodeEvent, readLog, repairTornTail, Sequencer } from "./inputlog.ts";
import { TIF } from "./rules.ts";

const submit: InputEvent = {
  kind: "submit",
  atMs: 1_000,
  entryId: "e1",
  order: {
    asset: 0,
    isBuy: true,
    limitPx: 10_001_000_000_000n,
    sz: 1_000_000n,
    reduceOnly: false,
    tif: TIF.gtc,
    cloid: (1n << 127n) + 5n, // past Number.MAX_SAFE_INTEGER by a long way
  },
};

async function scratch(): Promise<string> {
  return join(await mkdtemp(join(tmpdir(), "arena-log-")), "season.jsonl");
}

test("bigints survive the round trip exactly, including a uint128 cloid", () => {
  assert.deepEqual(decodeEvent(encodeEvent(submit)), submit);
});

test("a missing log is an empty season", async () => {
  const events: InputEvent[] = [];
  for await (const e of readLog(await scratch())) events.push(e);
  assert.deepEqual(events, []);
});

test("a torn final line is skipped, and repaired before anything is appended", async () => {
  const path = await scratch();
  await writeFile(path, encodeEvent(submit) + "\n" + '{"kind":"clo');

  const events: InputEvent[] = [];
  for await (const e of readLog(path)) events.push(e);
  assert.equal(events.length, 1);

  assert.equal(await repairTornTail(path), true);
  assert.equal(await readFile(path, "utf8"), encodeEvent(submit) + "\n");
  assert.equal(await repairTornTail(path), false);
});

test("an unreadable line in the middle refuses to replay", async () => {
  const path = await scratch();
  await writeFile(path, encodeEvent(submit) + "\n" + "garbage\n" + encodeEvent({ kind: "clock", atMs: 2_000 }) + "\n");
  await assert.rejects(async () => {
    for await (const _ of readLog(path)) void _;
  }, /:2: unreadable input log line/);
});

test("the sequencer persists before it applies, in stamp order, and never goes back in time", async () => {
  const order: string[] = [];
  const clock = [5_000, 4_000, 6_000]; // the wall clock steps backwards once
  const seq = new Sequencer<number>({
    sink: async (line) => {
      await new Promise((r) => setTimeout(r, 1));
      order.push(`write ${decodeEvent(line).atMs}`);
    },
    apply: (event) => {
      order.push(`apply ${event.atMs}`);
      return event.atMs;
    },
    now: () => clock.shift()!,
  });

  const results = await Promise.all([1, 2, 3].map(() => seq.accept((atMs) => ({ kind: "clock", atMs }))));
  assert.deepEqual(
    results.map((r) => r.result),
    [5_000, 5_000, 6_000]
  );
  assert.deepEqual(order, ["write 5000", "apply 5000", "write 5000", "apply 5000", "write 6000", "apply 6000"]);
});

test("a failed write is never applied, and does not wedge the queue", async () => {
  let fail = true;
  const applied: number[] = [];
  const seq = new Sequencer({
    sink: async () => {
      if (fail) {
        fail = false;
        throw new Error("disk full");
      }
    },
    apply: (event) => void applied.push(event.atMs),
    now: () => 1,
  });
  await assert.rejects(seq.accept((atMs) => ({ kind: "clock", atMs })), /disk full/);
  await seq.accept((atMs) => ({ kind: "clock", atMs }));
  assert.deepEqual(applied, [1]);
});
