"use client";

import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { OrbitLoader } from "@/components/ui/orbit-loader";

type TopicChoice = { id: string; name: string } | null;

type State =
  | { phase: "loading" }
  | { phase: "confirm"; email: string; companyName: string; topic: TopicChoice }
  | { phase: "done"; scope: "all" | "topic"; topicName?: string }
  | { phase: "error"; message: string };

function UnsubscribeInner() {
  const params = useSearchParams();
  const token = params.get("token") ?? "";
  const [state, setState] = useState<State>({ phase: "loading" });
  const [busy, setBusy] = useState<"all" | "topic" | null>(null);

  useEffect(() => {
    if (!token) {
      setState({ phase: "error", message: "Missing unsubscribe token." });
      return;
    }
    fetch(`/api/public/unsubscribe?token=${encodeURIComponent(token)}`)
      .then(async (res) => {
        const data = await res.json();
        if (!res.ok) throw new Error(data.error ?? "Invalid link");
        setState({
          phase: "confirm",
          email: data.email,
          companyName: data.companyName,
          topic: data.topic ?? null,
        });
      })
      .catch((err) => setState({ phase: "error", message: err.message }));
  }, [token]);

  async function confirm(scope: "all" | "topic") {
    setBusy(scope);
    const res = await fetch("/api/public/unsubscribe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token, scope }),
    });
    setBusy(null);
    if (res.ok) {
      const data = await res.json().catch(() => ({}));
      setState({ phase: "done", scope, topicName: data.topicName });
    } else {
      const data = await res.json().catch(() => ({}));
      setState({ phase: "error", message: data.error ?? "Something went wrong" });
    }
  }

  return (
    <div className="flex min-h-dvh items-center justify-center px-4">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>
            {state.phase === "done"
              ? state.scope === "topic"
                ? "Preference saved"
                : "You're unsubscribed"
              : "Unsubscribe"}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4 text-sm">
          {state.phase === "loading" && (
            <div className="flex items-center gap-3 text-muted-foreground">
              <OrbitLoader size={24} />
              <span>Checking link…</span>
            </div>
          )}
          {state.phase === "error" && <p className="text-destructive">{state.message}</p>}
          {state.phase === "confirm" && (
            <>
              <p className="text-muted-foreground">
                Stop receiving emails from <strong>{state.companyName}</strong> at{" "}
                <strong>{state.email}</strong>?
              </p>
              {state.topic ? (
                <div className="space-y-2">
                  <Button
                    onClick={() => confirm("topic")}
                    disabled={busy !== null}
                    className="w-full"
                  >
                    {busy === "topic" && <OrbitLoader size={16} />}
                    Only stop “{state.topic.name}” emails
                  </Button>
                  <Button
                    onClick={() => confirm("all")}
                    disabled={busy !== null}
                    variant="outline"
                    className="w-full"
                  >
                    {busy === "all" && <OrbitLoader size={16} />}
                    Unsubscribe from all emails
                  </Button>
                  <p className="text-xs text-muted-foreground">
                    This email was sent under the “{state.topic.name}” topic. You can leave just
                    that topic and keep receiving everything else.
                  </p>
                </div>
              ) : (
                <Button onClick={() => confirm("all")} disabled={busy !== null} className="w-full">
                  {busy === "all" && <OrbitLoader size={16} />}
                  Unsubscribe
                </Button>
              )}
            </>
          )}
          {state.phase === "done" && (
            <p className="text-muted-foreground">
              {state.scope === "topic" ? (
                <>
                  You won&apos;t receive “{state.topicName}” emails anymore — other emails are
                  unaffected. Closing this page is all you need to do.
                </>
              ) : (
                <>You will no longer receive these emails. Closing this page is all you need to do.</>
              )}
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

export default function UnsubscribePage() {
  return (
    <Suspense>
      <UnsubscribeInner />
    </Suspense>
  );
}
