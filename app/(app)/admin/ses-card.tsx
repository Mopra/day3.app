"use client";

import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Bar, StatusPill, type Tone } from "@/components/ui/rate-bar";
import { useApi } from "@/lib/api";
import type { SesAccountHealthResult } from "@/services/ses-account-health";

const pct = (v: number, digits = 1): string => `${(v * 100).toFixed(digits)}%`;
const n = (v: number): string => v.toLocaleString();

// Rate tone against Amazon's own bars: review opens at the first, sending is
// paused at the second. No count floor here, unlike the per-tenant card: AWS
// applies its thresholds to the whole account and this is the whole account.
function rateTone(rate: number, sent: number, review: number, pause: number): Tone {
  if (sent === 0) return "neutral";
  if (rate >= pause) return "bad";
  if (rate >= review) return "warn";
  return "good";
}

// The whole SES account as Amazon judges it: enforcement status, the 24-hour
// quota, and bounce/complaint rates from Virtual Deliverability Manager. This
// is the number that pauses Day3 itself, so it sits next to the per-tenant
// figures rather than being derived from them.
export function SesAccountCard() {
  const api = useApi();
  const [result, setResult] = useState<SesAccountHealthResult | null>(null);

  useEffect(() => {
    api
      .get<SesAccountHealthResult>("/api/admin/ses")
      .then(setResult)
      .catch((err: Error) => setResult({ available: false, reason: err.message }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const health = result?.available ? result.health : null;

  const pill: { tone: Tone; label: string } | null = health
    ? !health.sendingEnabled
      ? { tone: "bad", label: "Sending disabled by AWS" }
      : health.enforcementStatus === "SHUTDOWN"
        ? { tone: "bad", label: "Shut off" }
        : health.enforcementStatus === "PROBATION"
          ? { tone: "warn", label: "On probation" }
          : !health.productionAccess
            ? { tone: "warn", label: "Sandbox only" }
            : health.enforcementStatus === "HEALTHY"
              ? { tone: "good", label: "Healthy" }
              : { tone: "neutral", label: health.enforcementStatus }
    : null;

  const m = health?.metrics ?? null;
  const t = health?.thresholds;

  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2">
        <div>
          <CardTitle className="text-base">Amazon SES</CardTitle>
          <p className="mt-0.5 text-xs text-muted-foreground">
            The whole account, as AWS sees it
            {health ? ` · ${health.region}` : ""}
            {m ? ` · last ${m.windowDays} full days` : ""}
          </p>
        </div>
        {pill ? <StatusPill tone={pill.tone} label={pill.label} /> : null}
      </CardHeader>
      <CardContent className="space-y-4">
        {result === null ? (
          <>
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-8 w-full" />
          </>
        ) : !result.available ? (
          <p className="text-sm text-muted-foreground">Not connected: {result.reason}</p>
        ) : (
          <>
            {m && t ? (
              <>
                <Bar
                  label={
                    <>
                      Bounce rate{" "}
                      <span className="text-muted-foreground/60">
                        · review at {pct(t.bounceReview, 0)} · pauses at {pct(t.bouncePause, 0)}
                      </span>
                    </>
                  }
                  width={Math.min(1, m.bounceRate / t.bouncePause)}
                  tone={rateTone(m.bounceRate, m.sent, t.bounceReview, t.bouncePause)}
                  right={`${pct(m.bounceRate, 2)} · ${n(m.bounced)} of ${n(m.sent)}`}
                />
                <Bar
                  label={
                    <>
                      Complaint rate{" "}
                      <span className="text-muted-foreground/60">
                        · review at {pct(t.complaintReview, 1)} · pauses at{" "}
                        {pct(t.complaintPause, 1)}
                      </span>
                    </>
                  }
                  width={Math.min(1, m.complaintRate / t.complaintPause)}
                  tone={rateTone(m.complaintRate, m.sent, t.complaintReview, t.complaintPause)}
                  right={`${pct(m.complaintRate, 3)} · ${n(m.complained)} of ${n(m.sent)}`}
                />
              </>
            ) : (
              <p className="text-sm text-muted-foreground">
                Bounce and complaint rates unavailable
                {health?.metricsError ? `: ${health.metricsError}` : "."}
              </p>
            )}
            {health?.quota ? (
              <Bar
                label={
                  <>
                    24-hour quota{" "}
                    <span className="text-muted-foreground/60">
                      · max {n(health.quota.maxSendRate)}/s
                    </span>
                  </>
                }
                width={
                  health.quota.max24Hour > 0
                    ? health.quota.sentLast24Hours / health.quota.max24Hour
                    : 0
                }
                tone="neutral"
                right={`${n(health.quota.sentLast24Hours)} of ${n(health.quota.max24Hour)}`}
              />
            ) : null}
            {m && health?.metricsError ? (
              <p className="text-xs text-muted-foreground">{health.metricsError}</p>
            ) : null}
          </>
        )}
      </CardContent>
    </Card>
  );
}
