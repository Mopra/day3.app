import type { NextRequest } from "next/server";
import { sql, type SQL } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";
import { ApiError } from "./errors";

// Cursor pagination for every v1 list endpoint. Ordering is always
// (created_at DESC, id DESC); the cursor encodes both so pagination stays
// stable under concurrent inserts — which is exactly the migration case.

export type PageCursor = { createdAt: string; id: string };
export type PageQuery = { limit: number; after: PageCursor | null };

export function encodeCursor(c: PageCursor): string {
  return Buffer.from(JSON.stringify([c.createdAt, c.id]), "utf8").toString("base64url");
}

function decodeCursor(raw: string): PageCursor {
  try {
    const parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
    if (Array.isArray(parsed) && typeof parsed[0] === "string" && typeof parsed[1] === "string") {
      return { createdAt: parsed[0], id: parsed[1] };
    }
  } catch {
    // fall through
  }
  throw new ApiError(400, "invalid_request", "Invalid `after` cursor", { param: "after" });
}

export function parsePageQuery(req: NextRequest): PageQuery {
  const params = req.nextUrl.searchParams;
  const rawLimit = params.get("limit");
  let limit = 50;
  if (rawLimit !== null) {
    limit = Number(rawLimit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new ApiError(400, "invalid_request", "limit must be an integer between 1 and 100", {
        param: "limit",
      });
    }
  }
  const after = params.get("after");
  return { limit, after: after ? decodeCursor(after) : null };
}

// The keyset condition to AND onto a list query when a cursor is present.
export function cursorCondition(
  createdAt: PgColumn,
  id: PgColumn,
  after: PageCursor,
): SQL {
  return sql`(${createdAt}, ${id}) < (${after.createdAt}::timestamptz, ${after.id})`;
}

// Wrap `limit + 1` fetched rows into the documented list envelope. `rows` are
// the RAW db rows (needed for the cursor); `serialize` maps each to its public
// shape.
export function pageResponse<Row extends { createdAt: string; id: string }, Out>(
  rows: Row[],
  limit: number,
  serialize: (row: Row) => Out,
): { data: Out[]; has_more: boolean; next_cursor: string | null } {
  const page = rows.slice(0, limit);
  const hasMore = rows.length > limit;
  const last = page[page.length - 1];
  return {
    data: page.map(serialize),
    has_more: hasMore,
    next_cursor: hasMore && last ? encodeCursor({ createdAt: last.createdAt, id: last.id }) : null,
  };
}
