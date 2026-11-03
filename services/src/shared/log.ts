/**
 * JSON-line logging.
 *
 * One JSON object per line because these run unattended and the only reader that matters
 * is a log aggregator. A keeper that decided not to send a transaction has to be able to
 * say why, in a form something can query: `reason` and `vault` as fields, not prose.
 */

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;

export type Level = keyof typeof LEVELS;

const threshold = LEVELS[(process.env.LOG_LEVEL as Level) ?? "info"] ?? LEVELS.info;

export type Fields = Record<string, unknown>;

function emit(level: Level, service: string, msg: string, fields?: Fields) {
  if (LEVELS[level] < threshold) return;

  // `bigint` is everywhere in this codebase and `JSON.stringify` throws on it rather than
  // guessing. Strings, so no precision is lost on the way out.
  const line = JSON.stringify(
    { t: new Date().toISOString(), level, service, msg, ...fields },
    (_key, value) => (typeof value === "bigint" ? value.toString() : value)
  );

  if (level === "error" || level === "warn") process.stderr.write(`${line}\n`);
  else process.stdout.write(`${line}\n`);
}

export type Logger = {
  debug(msg: string, fields?: Fields): void;
  info(msg: string, fields?: Fields): void;
  warn(msg: string, fields?: Fields): void;
  error(msg: string, fields?: Fields): void;
};

export function logger(service: string): Logger {
  return {
    debug: (msg, fields) => emit("debug", service, msg, fields),
    info: (msg, fields) => emit("info", service, msg, fields),
    warn: (msg, fields) => emit("warn", service, msg, fields),
    error: (msg, fields) => emit("error", service, msg, fields),
  };
}

/**
 * Fail with a readable message rather than a stack trace.
 *
 * Almost everything that stops these processes at start-up is a missing or malformed
 * environment variable, and the person reading the output is deploying rather than
 * debugging. The stack is kept as a field for the case where it is a real bug.
 */
export function fatal(log: Logger, error: unknown): never {
  if (error instanceof Error) {
    // The stack goes in at debug level only. A missing variable does not need eight
    // frames of Node internals in front of the one line that says which variable.
    log.error(error.message);
    log.debug("stack", { stack: error.stack });
  } else {
    log.error(String(error));
  }
  process.exit(1);
}
