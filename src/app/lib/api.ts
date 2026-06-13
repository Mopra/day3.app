import { useCallback } from "react";
import { useAuth } from "@clerk/react";

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

export function useApi(): Api {
  const { getToken } = useAuth();

  const request = useCallback(
    async <T>(path: string, init: RequestInit = {}): Promise<T> => {
      const token = await getToken();
      const headers = new Headers(init.headers);
      headers.set("Authorization", `Bearer ${token}`);
      if (init.body && typeof init.body === "string") {
        headers.set("Content-Type", "application/json");
      }
      const res = await fetch(path, { ...init, headers });
      const data = (await res.json().catch(() => ({}))) as Record<string, unknown> & T;
      if (!res.ok) {
        throw new ApiError(
          typeof data.error === "string" ? data.error : res.statusText,
          res.status,
        );
      }
      return data;
    },
    [getToken],
  );

  return {
    get: (path) => request(path),
    post: (path, body) =>
      request(path, { method: "POST", body: body === undefined ? undefined : JSON.stringify(body) }),
    patch: (path, body) => request(path, { method: "PATCH", body: JSON.stringify(body) }),
    del: (path) => request(path, { method: "DELETE" }),
    upload: (path, form) => request(path, { method: "POST", body: form }),
  };
}
