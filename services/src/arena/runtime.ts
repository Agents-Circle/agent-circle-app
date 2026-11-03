import { ArenaEngine, type EngineOptions, type InputEvent, type OutputEvent } from "./engine.ts";
import { fileSink, readLog, repairTornTail, Sequencer, type Sink } from "./inputlog.ts";
import type { Order } from "./risk.ts";

/**
 * One live season: the engine, the input log in front of it, and whoever is listening.
 *
 * Start-up is always a replay. `open` trims a torn final line, feeds the whole log back
 * through the engine, and only then accepts live input, stamped no earlier than the last
 * logged event. A restart therefore resumes the season exactly where the log says it
 * was, and the replay is the same code path an independent scorer runs.
 */
export class ArenaRuntime {
  readonly engine: ArenaEngine;
  readonly #sequencer: Sequencer<OutputEvent[]>;
  readonly #listeners = new Set<(event: OutputEvent) => void>();
  #capture: OutputEvent[] | null = null;

  /** Use `open`. Exposed for tests that replay nothing. */
  constructor(options: Omit<EngineOptions, "emit"> & { sink: Sink; now?: () => number; resumeAfterMs?: number; prior?: InputEvent[] }) {
    this.engine = new ArenaEngine({
      rules: options.rules,
      instruments: options.instruments,
      startMs: options.startMs,
      ...(options.endMs === undefined ? {} : { endMs: options.endMs }),
      emit: (event) => {
        this.#capture?.push(event);
        for (const listener of this.#listeners) listener(event);
      },
    });
    for (const event of options.prior ?? []) this.engine.handle(event);

    this.#sequencer = new Sequencer<OutputEvent[]>({
      sink: options.sink,
      ...(options.now === undefined ? {} : { now: options.now }),
      ...(options.resumeAfterMs === undefined ? {} : { resumeAfterMs: options.resumeAfterMs }),
      apply: (event) => {
        this.#capture = [];
        try {
          this.engine.handle(event);
          return this.#capture;
        } finally {
          this.#capture = null;
        }
      },
    });
  }

  static async open(
    options: Omit<EngineOptions, "emit"> & { logPath: string; now?: () => number }
  ): Promise<{ runtime: ArenaRuntime; replayed: number; repaired: boolean }> {
    const repaired = await repairTornTail(options.logPath);
    const prior: InputEvent[] = [];
    for await (const event of readLog(options.logPath)) prior.push(event);
    const last = prior[prior.length - 1];
    const runtime = new ArenaRuntime({
      ...options,
      sink: fileSink(options.logPath),
      prior,
      ...(last === undefined ? {} : { resumeAfterMs: last.atMs }),
    });
    return { runtime, replayed: prior.length, repaired };
  }

  /** Engine output from here on. Replayed history is not re-emitted. */
  onOutput(listener: (event: OutputEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** Market data from the feed. */
  market(build: (atMs: number) => Extract<InputEvent, { kind: "book" | "trade" | "ctx" }>): Promise<unknown> {
    return this.#sequencer.accept(build);
  }

  clock(): Promise<unknown> {
    return this.#sequencer.accept((atMs) => ({ kind: "clock", atMs }));
  }

  /** Idempotent: an entry already in the season is not registered twice. */
  async register(entryId: string): Promise<boolean> {
    if (this.engine.hasEntry(entryId)) return false;
    await this.#sequencer.accept((atMs) => ({ kind: "register", atMs, entryId }));
    return true;
  }

  /** The engine's immediate answer to this order: `accepted` or `rejected`, plus any fill. */
  async submit(entryId: string, order: Order): Promise<OutputEvent[]> {
    const { result } = await this.#sequencer.accept((atMs) => ({ kind: "submit", atMs, entryId, order }));
    return result;
  }

  async cancel(entryId: string, cloid: bigint): Promise<OutputEvent[]> {
    const { result } = await this.#sequencer.accept((atMs) => ({ kind: "cancel", atMs, entryId, cloid }));
    return result;
  }
}
