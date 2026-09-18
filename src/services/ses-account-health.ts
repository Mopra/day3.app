import {
  BatchGetMetricDataCommand,
  GetAccountCommand,
  SESv2Client,
  type BatchGetMetricDataCommandOutput,
  type GetAccountCommandOutput,
} from "@aws-sdk/client-sesv2";

// The AWS-side view of our sending reputation, for the admin overview.
//
// services/health.ts judges each tenant from our own ledger. This is the other
// half: what Amazon itself sees for the whole SES account, which is the number
// that actually gets Day3 put on probation or shut off. The two disagree by
// design (AWS counts every message from every tenant, including transient
// bounces we never store), so this is shown to staff only and never fed back
// into per-account enforcement.
//
// Read-only and best-effort: when the provider is mock, credentials are missing
// or AWS is unreachable, the caller gets `{ available: false, reason }` rather
// than an error, so the rest of the admin page still renders.

// Amazon's published bars (SES "Sending review process" docs): a review opens at
// 5% bounces / 0.1% complaints, sending is paused at 10% / 0.5%. Kept separate
// from the stricter per-tenant thresholds in services/health.ts on purpose.
export const SES_BOUNCE_REVIEW = 0.05;
export const SES_BOUNCE_PAUSE = 0.1;
export const SES_COMPLAINT_REVIEW = 0.001;
export const SES_COMPLAINT_PAUSE = 0.005;

export const SES_METRICS_WINDOW_DAYS = 14;

export type SesAccountHealth = {
  region: string;
  fetchedAt: string;
  productionAccess: boolean;
  sendingEnabled: boolean;
  // HEALTHY | PROBATION | SHUTDOWN as AWS reports it; "UNKNOWN" if absent.
  enforcementStatus: string;
  quota: { max24Hour: number; sentLast24Hours: number; maxSendRate: number } | null;
  // Virtual Deliverability Manager daily aggregates over the trailing window
  // (whole UTC days, ending yesterday). null when VDM is off or the read failed.
  metrics: {
    windowDays: number;
    sent: number;
    delivered: number;
    bounced: number;
    complained: number;
    bounceRate: number;
    complaintRate: number;
  } | null;
  metricsError: string | null;
  thresholds: {
    bounceReview: number;
    bouncePause: number;
    complaintReview: number;
    complaintPause: number;
  };
};

export type SesAccountHealthResult =
  | { available: true; health: SesAccountHealth }
  | { available: false; reason: string };

// Structural subsets of the SDK responses, so the summariser is testable with
// plain objects and not coupled to the exact SDK output type.
type AccountResponse = Pick<
  GetAccountCommandOutput,
  "ProductionAccessEnabled" | "SendingEnabled" | "EnforcementStatus" | "SendQuota"
>;
type MetricsResponse = Pick<BatchGetMetricDataCommandOutput, "Results" | "Errors">;

const METRIC_IDS = {
  send: "SEND",
  delivery: "DELIVERY",
  bounce: "PERMANENT_BOUNCE",
  complaint: "COMPLAINT",
} as const;

export function summarizeSesAccount(
  region: string,
  account: AccountResponse,
  metrics: MetricsResponse | null,
  metricsError: string | null,
  now = new Date(),
): SesAccountHealth {
  const q = account.SendQuota;
  const quota =
    q && typeof q.Max24HourSend === "number"
      ? {
          max24Hour: q.Max24HourSend,
          sentLast24Hours: q.SentLast24Hours ?? 0,
          maxSendRate: q.MaxSendRate ?? 0,
        }
      : null;

  let summary: SesAccountHealth["metrics"] = null;
  if (metrics) {
    const sum = (id: string) =>
      (metrics.Results?.find((r) => r.Id === id)?.Values ?? []).reduce((a, b) => a + b, 0);
    const sent = sum("send");
    const bounced = sum("bounce");
    const complained = sum("complaint");
    summary = {
      windowDays: SES_METRICS_WINDOW_DAYS,
      sent,
      delivered: sum("delivery"),
      bounced,
      complained,
      bounceRate: sent > 0 ? bounced / sent : 0,
      complaintRate: sent > 0 ? complained / sent : 0,
    };
    const errs = metrics.Errors?.filter((e) => e.Message).map((e) => `${e.Id}: ${e.Message}`);
    if (errs && errs.length > 0 && !metricsError) metricsError = errs.join("; ");
  }

  return {
    region,
    fetchedAt: now.toISOString(),
    productionAccess: account.ProductionAccessEnabled === true,
    sendingEnabled: account.SendingEnabled === true,
    enforcementStatus: account.EnforcementStatus ?? "UNKNOWN",
    quota,
    metrics: summary,
    metricsError,
    thresholds: {
      bounceReview: SES_BOUNCE_REVIEW,
      bouncePause: SES_BOUNCE_PAUSE,
      complaintReview: SES_COMPLAINT_REVIEW,
      complaintPause: SES_COMPLAINT_PAUSE,
    },
  };
}

// VDM daily aggregates only accept whole UTC days, so the window is
// [midnight N days ago, midnight today): yesterday is the last full day.
export function metricsWindow(
  now: Date,
  days = SES_METRICS_WINDOW_DAYS,
): { start: Date; end: Date } {
  const end = new Date(now);
  end.setUTCHours(0, 0, 0, 0);
  return { start: new Date(end.getTime() - days * 86_400_000), end };
}

export async function fetchSesAccountHealth(
  env: NodeJS.ProcessEnv = process.env,
): Promise<SesAccountHealthResult> {
  if (env.EMAIL_PROVIDER !== "ses") {
    return {
      available: false,
      reason: `Email provider is "${env.EMAIL_PROVIDER ?? "mock"}", not SES`,
    };
  }
  const region = env.AWS_REGION;
  if (!region) return { available: false, reason: "AWS_REGION is not set" };

  const client = new SESv2Client({
    region,
    // Reads are safe to retry, but the admin page should not wait on AWS for
    // long: a wedged socket degrades into "unavailable", not a hung page.
    maxAttempts: 2,
    requestHandler: { connectionTimeout: 3000, requestTimeout: 8000 },
  });

  let account: GetAccountCommandOutput;
  try {
    account = await client.send(new GetAccountCommand({}));
  } catch (err) {
    const e = err as { name?: string; message?: string };
    return {
      available: false,
      reason: `${e.name ?? "Error"}: ${e.message ?? "SES GetAccount failed"}`,
    };
  }

  let metrics: MetricsResponse | null = null;
  let metricsError: string | null = null;
  if (account.VdmAttributes?.VdmEnabled === "ENABLED") {
    const { start, end } = metricsWindow(new Date());
    try {
      metrics = await client.send(
        new BatchGetMetricDataCommand({
          Queries: Object.entries(METRIC_IDS).map(([Id, Metric]) => ({
            Id,
            Namespace: "VDM",
            Metric,
            StartDate: start,
            EndDate: end,
          })),
        }),
      );
    } catch (err) {
      const e = err as { name?: string; message?: string };
      metricsError = `${e.name ?? "Error"}: ${e.message ?? "SES metrics read failed"}`;
    }
  } else {
    metricsError = "Virtual Deliverability Manager is not enabled on this SES account";
  }

  return {
    available: true,
    health: summarizeSesAccount(region, account, metrics, metricsError),
  };
}
