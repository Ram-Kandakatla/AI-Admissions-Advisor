// One JSON line per event on console.*, which Workers Logs captures and
// indexes by field. No library: pino writes to a file descriptor a Worker
// doesn't have.
//
// Never log anything a student typed or an id that identifies one. That is
// kept by the call sites, not by a scrubber here; error messages and stacks
// are the one deliberate exception.

export type LogLevel = "debug" | "info" | "warn" | "error";

export type LogLevelSetting = LogLevel | "silent";

/** `level` and `msg` are reserved; `never` makes passing either a type error. */
export type LogFields = Record<string, unknown> & { level?: never; msg?: never };

export interface Logger {
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
}

const RANK: Record<LogLevelSetting, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 100,
};

const DEFAULT_LEVEL: LogLevelSetting = "info";

// Workers Logs sets its level from which console method was called.
const WRITE: Record<LogLevel, (line: string) => void> = {
  debug: (line) => console.debug(line),
  info: (line) => console.log(line),
  warn: (line) => console.warn(line),
  error: (line) => console.error(line),
};

/** A typo in LOG_LEVEL falls back to the default rather than silencing logs. */
export function resolveLevel(raw: unknown): LogLevelSetting {
  if (typeof raw !== "string") return DEFAULT_LEVEL;
  const value = raw.trim().toLowerCase();
  return value in RANK ? (value as LogLevelSetting) : DEFAULT_LEVEL;
}

export function errorFields(err: unknown): LogFields {
  if (err instanceof Error) {
    return { detail: err.message, stack: err.stack };
  }
  return { detail: String(err) };
}

/**
 * Deliberately not on the Hono context: `onError` also runs for errors thrown
 * before that middleware, where a context logger would be undefined.
 */
export function createLogger(env: { LOG_LEVEL?: string }): Logger {
  const threshold = RANK[resolveLevel(env.LOG_LEVEL)];

  function emit(level: LogLevel, msg: string, fields?: LogFields): void {
    if (RANK[level] < threshold) return;

    // No timestamp: Cloudflare adds one on ingest.
    let line: string;
    try {
      line = JSON.stringify({ level, msg, ...fields });
    } catch {
      // A circular field must not throw out of a log call and fail the request.
      line = JSON.stringify({ level, msg, detail: "log fields were not serializable" });
    }
    WRITE[level](line);
  }

  return {
    debug: (msg, fields) => emit("debug", msg, fields),
    info: (msg, fields) => emit("info", msg, fields),
    warn: (msg, fields) => emit("warn", msg, fields),
    error: (msg, fields) => emit("error", msg, fields),
  };
}
