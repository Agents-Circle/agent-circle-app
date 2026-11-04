import { createReadStream } from "node:fs";
import { appendFile, mkdir, open, stat, truncate } from "node:fs/promises";
import { dirname } from "node:path";
import { createInterface } from "node:readline";
import { createGunzip } from "node:zlib";

import type { InputEvent } from "./engine.ts";

/**
 * The season's input log: one `InputEvent` per line, JSON, append-only.
 *
 * ## The log is written before the engine sees the event
 *
 * Every input passes through `Sequencer.accept`, which stamps the receive time, appends
 * the line, and only then hands the event to the engine. So anything the engine ever
 * acted on is on disk, and replaying the file reproduces the season exactly — every fill,
 * mark and score. A crash between the append and the engine is harmless: the replay on
 * restart applies the event the live process never got to.
 *
 * ## bigints
 *
 * JSON has no bigint and a float would lose a uint128 cloid, so every bigint is written as
 * `{"$n":"<decimal>"}`. Nothing in an `InputEvent` is legitimately an object with exactly
 * that one key, so the encoding is unambiguous.
 */

export function encodeEvent(event: InputEvent): string {
  return JSON.stringify(event, (_key, value) => (typeof value === "bigint" ? { $n: value.toString() } : value));
}

export function decodeEvent(line: string): InputEvent {
  return JSON.parse(line, (_key, value) => {
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      const keys = Object.keys(value);
      if (keys.length === 1 && keys[0] === "$n" && typeof value.$n === "string") return BigInt(value.$n);
    }
    return value;
  }) as InputEvent;
}

/**
 * Every event in a log, in order. A missing file is an empty season, not an error.
 * A `.gz` path is read through gunzip, so a recorded day can be archived compressed and
 * still replayed as it is.
 */
export async function* readLog(path: string): AsyncGenerator<InputEvent> {
  try {
    await stat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }

  const raw = createReadStream(path);
  const input = path.endsWith(".gz") ? raw.pipe(createGunzip()) : raw;
  input.setEncoding("utf8");
  const lines = createInterface({ input, crlfDelay: Infinity });
  // A torn *final* line is what a crash mid-append leaves, and the engine never applied
  // it, so it is skipped. An unreadable line with anything after it is a corrupted
  // season, and a prize must not be paid against it.
  let number = 0;
  let torn: Error | null = null;
  for await (const line of lines) {
    number += 1;
    if (line.trim() === "") continue;
    if (torn) throw torn;
    let event: InputEvent;
    try {
      event = decodeEvent(line);
    } catch (error) {
      torn = new Error(`${path}:${number}: unreadable input log line (${(error as Error).message})`);
      continue;
    }
    yield event;
  }
}

/**
 * Trim a torn final line before anything is appended after it. Without this, the next
 * live event lands on the end of the fragment and the log stops replaying. Returns
 * whether anything was trimmed.
 */
export async function repairTornTail(path: string): Promise<boolean> {
  let handle;
  try {
    handle = await open(path, "r");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
  // Reads back from the end only as far as the last newline: a recorded day runs to
  // gigabytes, and the whole file never needs to be in memory to find its last line.
  try {
    const { size } = await handle.stat();
    const chunk = Buffer.alloc(64 * 1024);
    let end = size;
    while (end > 0) {
      const start = Math.max(0, end - chunk.length);
      const { bytesRead } = await handle.read(chunk, 0, end - start, start);
      const newline = chunk.subarray(0, bytesRead).lastIndexOf(0x0a);
      if (newline >= 0) {
        const keep = start + newline + 1;
        if (keep === size) return false;
        await truncate(path, keep);
        return true;
      }
      end = start;
    }
    if (size === 0) return false;
    await truncate(path, 0);
    return true;
  } finally {
    await handle.close();
  }
}

/** The time of a log's last complete event, or null if it has none. Reads only the tail. */
export async function lastEventMs(path: string): Promise<number | null> {
  let handle;
  try {
    handle = await open(path, "r");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  try {
    const { size } = await handle.stat();
    let length = Math.min(size, 64 * 1024);
    while (length > 0) {
      const buffer = Buffer.alloc(length);
      await handle.read(buffer, 0, length, size - length);
      const lines = buffer.toString("utf8").split("\n").filter((line) => line.trim() !== "");
      // The first line in the window may be cut off; any line after it is whole.
      const whole = length === size ? lines : lines.slice(1);
      const last = whole[whole.length - 1];
      if (last !== undefined) return decodeEvent(last).atMs;
      if (length === size) return null;
      length = Math.min(size, length * 4);
    }
    return null;
  } finally {
    await handle.close();
  }
}

export type Sink = (line: string) => Promise<void>;

export function fileSink(path: string): Sink {
  let ready: Promise<unknown> | null = null;
  return async (line) => {
    ready ??= mkdir(dirname(path), { recursive: true });
    await ready;
    await appendFile(path, line + "\n", "utf8");
  };
}

/**
 * The single door every input goes through, live.
 *
 * Holds the clock the engine runs on. `Date.now()` can step backwards (NTP), and the
 * engine refuses out-of-order input, so the receive time is clamped to never go below the
 * last one stamped. Writes are serialised so lines land in the order times were stamped.
 */
export class Sequencer<R = void> {
  readonly #sink: Sink;
  readonly #apply: (event: InputEvent) => R;
  readonly #now: () => number;
  #lastMs: number;
  #queue: Promise<void> = Promise.resolve();

  constructor(options: { sink: Sink; apply: (event: InputEvent) => R; now?: () => number; resumeAfterMs?: number }) {
    this.#sink = options.sink;
    this.#apply = options.apply;
    this.#now = options.now ?? Date.now;
    this.#lastMs = options.resumeAfterMs ?? Number.NEGATIVE_INFINITY;
  }

  get lastMs(): number {
    return this.#lastMs;
  }

  /**
   * Stamp, persist, then apply. Resolves once the engine has handled the event, with
   * whatever applying it returned — so a caller gets the outcome of *its* event, not
   * whichever event happened to be applied last.
   */
  accept<E extends InputEvent>(build: (atMs: number) => E): Promise<{ event: E; result: R }> {
    const run = async () => {
      const atMs = Math.max(this.#now(), this.#lastMs);
      this.#lastMs = atMs;
      const event = build(atMs);
      await this.#sink(encodeEvent(event));
      return { event, result: this.#apply(event) };
    };
    const result = this.#queue.then(run);
    this.#queue = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }
}
