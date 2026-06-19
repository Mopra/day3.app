// Next.js runs register() once, on the server, before the app handles any
// request (see nextjs.org/docs/app/building-your-application/optimizing/instrumentation).
// We use it to fail fast on a missing/weak required secret at startup rather
// than discovering the empty-key HMAC signer at the first unsubscribe request.
export async function register() {
  // Edge runtime has no Node env / our secrets; only validate on the Node server.
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { validateEnv } = await import("./src/lib/env");
    validateEnv();
  }
}
