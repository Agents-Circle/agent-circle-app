import assert from "node:assert/strict";
import { test } from "node:test";

import { logIsLost } from "./publish.ts";

/**
 * The input log *is* the season: every start replays it, and an independent scorer scores
 * from it. Losing it on a platform with an ephemeral filesystem is silent — `freezeSeason`
 * writes a fresh season file, the replay returns zero, and the process starts the season
 * again from the opening equity while every entry and API key still works in the database.
 *
 * Published scores are the evidence that this has happened, because only the Arena process
 * writes them.
 */

test("scores with an empty replay means the log is lost", () => {
  assert.equal(logIsLost(0, 1), true);
  assert.equal(logIsLost(0, 4_210), true);
});

test("a fresh season is not a lost log", () => {
  // Day one, before the first minute mark: nothing replayed and nothing published.
  assert.equal(logIsLost(0, 0), false);
});

test("a log that replays is never lost, however much has been published", () => {
  assert.equal(logIsLost(1, 0), false);
  assert.equal(logIsLost(11_607, 4_210), false);
  // The asymmetry is deliberate: a log ahead of the scores is a season that has not
  // reached its next mark, which is the normal state between marks.
  assert.equal(logIsLost(11_607, 0), false);
});
