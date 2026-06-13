import { useEffect, useState } from "react";
import { useSearchParams } from "react-router";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

type State =
  | { phase: "loading" }
  | { phase: "confirm"; email: string; companyName: string }
  | { phase: "done" }
  | { phase: "error"; message: string };

export function UnsubscribePage() {
  const [params] = useSearchParams();
  const token = params.get("token") ?? "";
  const [state, setState] = useState<State>({ phase: "loading" });

  useEffect(() => {
    if (!token) {
      setState({ phase: "error", message: "Missing unsubscribe token." });
      return;
    }
    fetch(`/api/public/unsubscribe?token=${encodeURIComponent(token)}`)
      .then(async (res) => {
        const data = await res.json();
        if (!res.ok) throw new Error(data.error ?? "Invalid link");
        setState({ phase: "confirm", email: data.email, companyName: data.companyName });
      })
      .catch((err) => setState({ phase: "error", message: err.message }));
  }, [token]);

  async function confirm() {
    const res = await fetch("/api/public/unsubscribe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    });
    if (res.ok) setState({ phase: "done" });
    else {
      const data = await res.json().catch(() => ({}));
      setState({ phase: "error", message: data.error ?? "Something went wrong" });
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center px-4">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>
            {state.phase === "done" ? "You're unsubscribed" : "Unsubscribe"}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4 text-sm">
          {state.phase === "loading" && <p className="text-muted-foreground">Checking link…</p>}
          {state.phase === "error" && <p className="text-destructive">{state.message}</p>}
          {state.phase === "confirm" && (
            <>
              <p className="text-muted-foreground">
                Stop receiving emails from <strong>{state.companyName}</strong> at{" "}
                <strong>{state.email}</strong>?
              </p>
              <Button onClick={confirm} className="w-full">
                Unsubscribe
              </Button>
            </>
          )}
          {state.phase === "done" && (
            <p className="text-muted-foreground">
              You will no longer receive these emails. Closing this page is all you need to do.
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
