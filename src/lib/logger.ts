// Thin structured logger + error-reporting hook shared by both tiers (the Next
// web tier and the BullMQ worker). The goal is operability: every line is a
// single JSON object ({ level, msg, ...context }) so logs are greppable and
// machine-parseable, and every request / job carries a correlation id so a
// stuck campaign, a failing webhook, or a tenant-specific error can be traced
// across log lines.
//
// Two design constraints:
//   1. Logs must never leak secrets. Context is recursively redacted by key
//      name (anything that looks like a secret/token/password/key) so an
//      accidental `{ env: process.env }` or `{ headers }` can't print a signing
//      key. A test pins this behaviour for the known secret env names.
//   2. Reporting is best-effort and dependency-free. ERROR_REPORTING_DSN (or
//      SENTRY_DSN) configures a sink; unset → a no-op. We never let a logging or
//      reporting failure break the request or job it is observing.

export type LogLevel = "debug" | "info" | "warn" | "error";

export type LogContext = Record<string, unknown>;

// Key fragments that mark a value as sensitive. Matched case-insensitively as a
// substring of the context key, so e.g. `unsubscribeSecret`, `DNS_TOKEN_ENC_KEY`,
// `authorization`, `clerk_webhook_signing_secret` are all caught.
const SECRET_KEY_FRAGMENTS = [
  "secret",
  "token",
  "password",
  "passwd",
  "apikey",
  "api_key",
  "authorization",
  "auth",
  "cookie",
  "signature",
  "credential",
  "private",
  "enc_key",
  "dsn",
  "database_url",
];

const REDACTED = "[REDACTED]";
const MAX_REDACT_DEPTH = 6;

function isSecretKey(key: string): boolean {
  const k = key.toLowerCase();
  return SECRET_KEY_FRAGMENTS.some((frag) => k.includes(frag));
}

// Recursively replaces the value of any secret-named key with [REDACTED]. Arrays
// and nested objects are walked; depth is bounded so a cyclic / huge object
// can't hang the logger. Non-plain values (Error, etc.) are normalised by the
// caller before they reach here.
export function redact(value: unknown, depth = 0): unknown {
  if (depth > MAX_REDACT_DEPTH) return "[truncated]";
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = isSecretKey(k) ? REDACTED : redact(v, depth + 1);
    }
    return out;
  }
  return value;
}

// Normalises an unknown thrown value into a safe, serialisable shape: the
// message + stack for an Error, the string form otherwise. Stacks are kept (they
// don't contain secrets) so a 500 / failed job is diagnosable.
export function serializeError(err: unknown): { name: string; message: string; stack?: string } {
  if (err instanceof Error) {
    return { name: err.name, message: err.message, stack: err.stack };
  }
  return { name: "NonError", message: typeof err === "string" ? err : JSON.stringify(err) };
}

// A short correlation id for a single request or job. Not security-sensitive —
// just unique enough to stitch log lines together.
export function newCorrelationId(prefix = "cid"): string {
  return `${prefix}_${crypto.randomUUID()}`;
}

// --- error sink -----------------------------------------------------------

type ErrorReport = {
  message: string;
  error: { name: string; message: string; stack?: string };
  context: LogContext;
};

// The configured error sink. ERROR_REPORTING_DSN (or SENTRY_DSN) turns it on;
// unset → no-op. We don't pull in an SDK: reports are POSTed as JSON, fire and
// forget, so the sink can be any HTTP collector and a reporting outage never
// blocks a request or job. The body is already redacted by the caller.
async function postToSink(dsn: string, report: ErrorReport): Promise<void> {
  await fetch(dsn, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(report),
  });
}

function errorDsn(): string | undefined {
  return process.env.ERROR_REPORTING_DSN || process.env.SENTRY_DSN || undefined;
}

// --- logger ---------------------------------------------------------------

export interface Logger {
  /** Returns a child logger that merges `context` into every line it emits. */
  child(context: LogContext): Logger;
  debug(msg: string, context?: LogContext): void;
  info(msg: string, context?: LogContext): void;
  warn(msg: string, context?: LogContext): void;
  error(msg: string, context?: LogContext): void;
  /**
   * Logs at error level AND ships the error to the configured sink (with a safe,
   * redacted context + stack). Best-effort: a sink failure is swallowed (it's
   * still logged locally). Returns the promise so a caller that wants to await
   * delivery (e.g. before a serverless function freezes) can.
   */
  reportError(msg: string, err: unknown, context?: LogContext): Promise<void>;
}

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

function minLevel(): number {
  const configured = (process.env.LOG_LEVEL ?? "info").toLowerCase() as LogLevel;
  return LEVELS[configured] ?? LEVELS.info;
}

function emit(level: LogLevel, msg: string, base: LogContext, extra?: LogContext): void {
  if (LEVELS[level] < minLevel()) return;
  const context = redact({ ...base, ...extra }) as LogContext;
  const line = JSON.stringify({ level, msg, time: new Date().toISOString(), ...context });
  // error/warn → stderr, everything else → stdout (the conventional split so
  // log shippers can route by stream).
  if (level === "error" || level === "warn") console.error(line);
  else console.log(line);
}

function make(base: LogContext): Logger {
  return {
    child: (context) => make({ ...base, ...context }),
    debug: (msg, context) => emit("debug", msg, base, context),
    info: (msg, context) => emit("info", msg, base, context),
    warn: (msg, context) => emit("warn", msg, base, context),
    error: (msg, context) => emit("error", msg, base, context),
    async reportError(msg, err, context) {
      const error = serializeError(err);
      emit("error", msg, base, { ...context, error });
      const dsn = errorDsn();
      if (!dsn) return;
      // Redact the merged context before it leaves the process. Best-effort:
      // never let a reporting failure surface to the caller.
      const report: ErrorReport = {
        message: msg,
        error,
        context: redact({ ...base, ...context }) as LogContext,
      };
      try {
        await postToSink(dsn, report);
      } catch (sinkErr) {
        emit("warn", "error-sink delivery failed", base, {
          error: serializeError(sinkErr),
        });
      }
    },
  };
}

/** The root logger. Use `.child({...})` to bind a correlation id + context. */
export const logger: Logger = make({});
