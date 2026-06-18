// Client-side API helper. Unlike the old SPA (which sent a Clerk Bearer token),
// the Next app calls same-origin /api routes where the Clerk session cookie is
// sent automatically — clerkMiddleware + auth() read it server-side. So this is
// just a thin fetch wrapper. Kept as a `useApi()` hook so page code reads the
// same as the reference.
export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

export type Api = {
  get: <T = unknown>(path: string) => Promise<T>;
  post: <T = unknown>(path: string, body?: unknown) => Promise<T>;
  patch: <T = unknown>(path: string, body?: unknown) => Promise<T>;
  del: <T = unknown>(path: string) => Promise<T>;
  upload: <T = unknown>(path: string, form: FormData) => Promise<T>;
};

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body && typeof init.body === "string") {
    headers.set("Content-Type", "application/json");
  }
  const res = await fetch(path, { ...init, headers });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown> & T;
  if (!res.ok) {
    throw new ApiError(typeof data.error === "string" ? data.error : res.statusText, res.status);
  }
  return data;
}

export const api: Api = {
  get: (path) => request(path),
  post: (path, body) =>
    request(path, { method: "POST", body: body === undefined ? undefined : JSON.stringify(body) }),
  patch: (path, body) => request(path, { method: "PATCH", body: JSON.stringify(body) }),
  del: (path) => request(path, { method: "DELETE" }),
  upload: (path, form) => request(path, { method: "POST", body: form }),
};

export function useApi(): Api {
  return api;
}
