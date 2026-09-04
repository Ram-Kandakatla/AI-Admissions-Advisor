// Structured logging.
//
// WHY THERE IS NO LOGGING LIBRARY HERE
//
// pino is the obvious reach, and it does not fit: its default transport is
// sonic-boom, which writes to a file descriptor. A Worker has no filesystem and
// no stdout to point one at. What Cloudflare gives you instead is that
// console.log/warn/error are captured automatically — by `wrangler tail` locally
// and by Workers Logs once deployed (enabled in wrangler.toml's [observability]
// block). So the entire job of a logger here is to make the *argument* to
// console a consistently shaped JSON string. That is small enough to own.
//
// WHY ONE LINE OF JSON RATHER THAN A READABLE MESSAGE
//
// Workers Logs indexes the fields of a JSON log line, so `status = 500` and
// `route = "/api/students/:id"` are queryable filters rather than substrings to
// grep for. A human-readable string is nicer to read in a terminal and useless
// in a dashboard six weeks later, which is the moment this exists for.
//
// WHAT IS DELIBERATELY NOT IN A LOG LINE
//
// Anything a student typed, and any id that identifies one. The request logger
// records the *route pattern* (`/api/students/:id`), never the concrete path,
// and no call site passes a request body, a query string, an email, or a
// password. That is a property of the call sites, not a redaction pass — there
// is no scrubber here to fail open. The one deliberate exception is `detail`
// and `stack` on an error, which are logged verbatim: a redacted stack trace
// cannot be debugged, and that is the trade this makes knowingly.

export type LogLevel = "debug" | "info" | "warn" | "error";

/** What LOG_LEVEL may be set to — the four levels, plus "off entirely". */
export type LogLevelSetting = LogLevel | "silent";

/**
 * Extra context on a log line.
 *
 * `level` and `msg` are reserved: the logger writes them itself, and a field
 * of either name would shadow it. `never` is what turns that from a silent
 * corruption into a compile error, and the typecheck runs in CI.
 */
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

// Each level goes to its matching console method rather than all of them to
// console.log. Workers Logs reads the method to set its own level field, so
// this is what makes "show me only errors" work in the dashboard without
// parsing our JSON first.
const WRITE: Record<LogLevel, (line: string) => void> = {
  debug: (line) => console.debug(line),
  info: (line) => console.log(line),
  warn: (line) => console.warn(line),
  error: (line) => console.error(line),
};

/**
 * Interpret the LOG_LEVEL binding.
 *
 * An unrecognised value falls back to the default rather than throwing or
 * disabling output. Logging is the thing you reach for when something else is
 * already wrong; a typo'd config value must not be able to take it away, and
 * "the level is a var in wrangler.toml" means nothing typechecks it.
 */
export function resolveLevel(raw: unknown): LogLevelSetting {
  if (typeof raw !== "string") return DEFAULT_LEVEL;
  const value = raw.trim().toLowerCase();
  return value in RANK ? (value as LogLevelSetting) : DEFAULT_LEVEL;
}

/**
 * Normalize a thrown value into log fields.
 *
 * Four call sites were spelling `err instanceof Error ? err.message :
 * String(err)` by hand, two of them also wanting the stack. `catch` binds
 * `unknown` — a throw is not obliged to be an Error — so the narrowing has to
 * happen somewhere, and once is better than six times.
 */
export function errorFields(err: unknown): LogFields {
  if (err instanceof Error) {
    return { detail: err.message, stack: err.stack };
  }
  return { detail: String(err) };
}

/**
 * Build a logger for one request.
 *
 * A factory over `env` for the same reason `createStore` and `createLlmService`
 * are: LOG_LEVEL arrives per request on the bindings object, and a Worker has
 * no process.env to read it from once at import time.
 *
 * Unlike those two this is NOT put on the Hono context. It is a closure over a
 * number — cheap enough to build per call site — and keeping it off the context
 * means it cannot be unset. That matters for exactly one call site: `onError`
 * runs for errors thrown *before* the wiring middleware, so a context-supplied
 * logger would be undefined in the one place logging is least optional.
 */
export function createLogger(env: { LOG_LEVEL?: string }): Logger {
  const threshold = RANK[resolveLevel(env.LOG_LEVEL)];

  function emit(level: LogLevel, msg: string, fields?: LogFields): void {
    if (RANK[level] < threshold) return;

    // No timestamp: Cloudflare stamps every log event on ingest, and
    // `wrangler tail` prints one. A second one can only agree or disagree.
    let line: string;
    try {
      line = JSON.stringify({ level, msg, ...fields });
    } catch {
      // A circular or otherwise unserializable field must not be able to throw
      // out of a logging call and take the request down with it. Losing the
      // context is bad; losing the response is worse.
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
