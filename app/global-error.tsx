"use client";

// Last-resort boundary for errors thrown in the ROOT layout itself. It replaces
// the entire document, so it must render its own <html>/<body>, and the app's
// CSS isn't guaranteed to be applied here — hence the inline styling. Kept
// deliberately tiny and dependency-free so it can't fail for the same reason the
// app did.
import { useEffect } from "react";

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("Global error boundary:", error);
  }, [error]);

  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          minHeight: "100vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "#0b0b0c",
          color: "#fafafa",
          fontFamily:
            "system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif",
          padding: "1rem",
        }}
      >
        <div style={{ maxWidth: 420, textAlign: "center" }}>
          <h1 style={{ fontSize: "1.5rem", fontWeight: 600, margin: "0 0 0.5rem" }}>
            Something went wrong
          </h1>
          <p style={{ color: "#a1a1aa", margin: "0 0 1.5rem", lineHeight: 1.5 }}>
            The app hit an unexpected error. Reloading usually fixes it.
          </p>
          <button
            onClick={reset}
            style={{
              border: "none",
              borderRadius: 8,
              padding: "0.55rem 1.1rem",
              fontSize: "0.95rem",
              fontWeight: 500,
              background: "#fafafa",
              color: "#0b0b0c",
              cursor: "pointer",
            }}
          >
            Reload
          </button>
          {error.digest && (
            <p style={{ color: "#71717a", fontSize: "0.75rem", marginTop: "1rem" }}>
              Reference: {error.digest}
            </p>
          )}
        </div>
      </body>
    </html>
  );
}
