// Client-side deadlines.
//
// Why this exists: our two remote dependencies have very different guarantees.
// ioredis takes a `commandTimeout` and enforces it client-side. postgres.js has
// NO client-side query timeout — `connect_timeout` only bounds *establishing* a
// connection, and `statement_timeout` is a server-side parameter, so a query that
// never reaches the server can never trip it. On a half-open socket (the peer is
// gone but no FIN/RST was ever delivered — what a frozen-then-thawed serverless
// instance sees) a query hangs indefinitely: the request produces no response at
// all and the caller eventually times out, which reads as an intermittent,
// self-healing outage rather than an error.
//
// `withDeadline` puts a ceiling on any awaited work so a wedged dependency
// degrades into a fast, explicit failure instead of a hang.

export class DeadlineError extends Error {
  constructor(
    public readonly label: string,
    public readonly ms: number,
  ) {
    super(`${label} exceeded its ${ms}ms deadline`);
    this.name = "DeadlineError";
  }
}

/**
 * Rejects with `DeadlineError` if `work` hasn't settled within `ms`.
 *
 * The underlying promise cannot be cancelled, so it is abandoned — which matters
 * for a pooled resource: an abandoned postgres.js query keeps occupying its
 * connection, and the web pool is `max: 1`, so the caller MUST also discard the
 * pool (see `resetDb`) or every later request on that instance inherits the wedge.
 */
export function withDeadline<T>(work: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    work,
    new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new DeadlineError(label, ms)), ms);
    }),
  ]).finally(() => clearTimeout(timer)) as Promise<T>;
}

/** True when `err` came from `withDeadline` rather than the dependency itself. */
export function isDeadlineError(err: unknown): err is DeadlineError {
  return err instanceof DeadlineError;
}
