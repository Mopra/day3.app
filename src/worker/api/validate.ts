import type { Context } from "hono";
import type { ZodType } from "zod";

export async function parseJson<T>(
  c: Context,
  schema: ZodType<T>,
): Promise<{ ok: true; data: T } | { ok: false; response: Response }> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    return { ok: false, response: c.json({ error: "Invalid JSON body" }, 400) };
  }
  const result = schema.safeParse(raw);
  if (!result.success) {
    const issue = result.error.issues[0];
    const path = issue.path.join(".");
    return {
      ok: false,
      response: c.json({ error: `${path ? `${path}: ` : ""}${issue.message}` }, 400),
    };
  }
  return { ok: true, data: result.data };
}
