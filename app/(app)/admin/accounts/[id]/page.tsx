"use client";

import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { ChevronDown, Globe, Mail } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { OrbitLoaderScreen } from "@/components/ui/orbit-loader";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  ListClear,
  ListCount,
  ListEmpty,
  ListFilter,
  ListNoResults,
  ListSearch,
  ListSkeleton,
  ListToolbar,
  SortableHead,
  buildFilterOptions,
  useListController,
} from "@/components/ui/data-list";
import { EmailPreview } from "@/components/email-preview";
import { useApi } from "@/lib/api";
import { formatDate, statusLabel, statusVariant } from "@/lib/format";
import { planLabel } from "@/lib/plans-catalog";
import type { Account, AccountHealth, Campaign, SendingDomain } from "@/lib/types";
// Type-only: the service module reaches the database, so the client never
// imports its values. The thresholds arrive in the payload instead.
import type { ReviewTrust, ReviewTrustTier } from "@/services/review-trust";

type BlockedContent = {
  id: string;
  riskLevel: string;
  riskScore: number;
  summary: string;
  subject: string;
  fromEmail: string;
  fromName: string | null;
  blockedCount: number;
  aiReview: string;
  trustTier: string | null;
  createdAt: string;
};

const TRUST_TIER_LABEL: Record<ReviewTrustTier, string> = {
  trusted: "Trusted",
  watch: "Watch",
  new: "New",
};

const TRUST_TIER_VARIANT: Record<ReviewTrustTier, "default" | "destructive" | "outline"> = {
  trusted: "default",
  watch: "destructive",
  new: "outline",
};

// Whether the AI looked at a stored verdict. `reviewed` is the normal case and
// says nothing, so the label only appears when the verdict is rules-only.
const AI_REVIEW_NOTE: Record<string, string> = {
  sampled_out: "AI skipped, trusted sender",
  failed: "AI failed",
  off: "No AI",
};

type AdminApiKey = {
  id: string;
  name: string;
  keyPrefix: string;
  scopes: string | null;
  lastUsedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
};

type Detail = {
  account: Account;
  health: AccountHealth;
  reviewTrust: ReviewTrust;
  reviewTrustTargets: { delivered: number; aiClean: number; lookbackDays: number };
  campaigns: Campaign[];
  subscriberCount: number;
  blockedContent: BlockedContent[];
  apiKeys: AdminApiKey[];
};

export default function AdminAccountPage() {
  const { id } = useParams<{ id: string }>();
  const api = useApi();
  const [detail, setDetail] = useState<Detail | null>(null);
  const [domains, setDomains] = useState<SendingDomain[] | null>(null);
  const [busy, setBusy] = useState(false);
  // Which campaign's content is open. One at a time: an operator is reading one
  // email, and the previews are iframes.
  const [openCampaignId, setOpenCampaignId] = useState<string | null>(null);

  const load = useCallback(() => {
    api
      .get<Detail>(`/api/admin/accounts/${id}`)
      .then(setDetail)
      .catch((err) => toast.error(err.message));
    api
      .get<{ domains: SendingDomain[] }>(`/api/admin/accounts/${id}/domains`)
      .then((res) => setDomains(res.domains))
      .catch(() => setDomains([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  useEffect(load, [load]);

  // Hooks must run before the loading early-return, so the controller takes the
  // campaigns once `detail` resolves.
  const campaignList = useListController(detail?.campaigns ?? null, {
    searchText: (c) => `${c.name} ${c.subject}`,
    filters: { status: "all" },
    predicate: (c, f) => f.status === "all" || c.status === f.status,
    sortAccessors: {
      name: (c) => c.name,
      status: (c) => c.status,
      risk: (c) => c.riskLevel,
      createdAt: (c) => c.createdAt,
    },
    initialSort: { key: "createdAt", dir: "desc" },
    // One key for every account: an operator scanning for, say, failed campaigns
    // is doing the same job on whichever account they open next.
    persist: { key: "admin.account-campaigns" },
  });

  const campaignStatusOptions = useMemo(
    () =>
      buildFilterOptions({
        all: "All statuses",
        values: (detail?.campaigns ?? []).map((c) => c.status),
        active: campaignList.filters.status,
        label: (s) => statusLabel(s),
      }),
    [detail, campaignList.filters.status],
  );

  async function act(path: string, body?: unknown) {
    setBusy(true);
    try {
      await api.post(path, body ?? {});
      toast.success("Done");
      load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed");
    } finally {
      setBusy(false);
    }
  }

  async function del(path: string) {
    setBusy(true);
    try {
      await api.del(path);
      toast.success("Done");
      load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed");
    } finally {
      setBusy(false);
    }
  }

  if (!detail) return <OrbitLoaderScreen />;
  const { account, health, subscriberCount, blockedContent, apiKeys, reviewTrust, reviewTrustTargets } =
    detail;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <h1 className="font-display text-2xl sm:text-3xl">{account.name}</h1>
          <Badge variant={account.riskStatus === "normal" ? "outline" : "destructive"}>
            {account.riskStatus}
          </Badge>
        </div>
        <div className="flex gap-2">
          <Button
            variant="outline"
            disabled={busy}
            onClick={() =>
              act(`/api/admin/accounts/${account.id}/ramp`, {
                lifted: !account.rampLiftedAt,
              })
            }
          >
            {account.rampLiftedAt ? "Restore send ramp" : "Lift send ramp"}
          </Button>
          {/* Bans every non-shared domain on this account platform-wide, so a
              paused abuser cannot release a domain and re-verify it on a fresh
              org. Separate from Pause on purpose: an honest account paused for a
              stale list must not lose its domain. */}
          <Button
            variant="outline"
            disabled={busy}
            onClick={() => {
              const reason = window.prompt(
                "Ban every sending domain on this account platform-wide? Give a reason:",
              );
              if (reason) act("/api/admin/accounts/" + account.id + "/block-domains", { reason });
            }}
          >
            Ban domains
          </Button>
          {account.riskStatus === "paused" ? (
            <Button
              disabled={busy}
              onClick={() => act(`/api/admin/accounts/${account.id}/resume`)}
            >
              Resume account
            </Button>
          ) : (
            <Button
              variant="destructive"
              disabled={busy}
              onClick={() => {
                const reason = window.prompt("Reason for pausing this account?");
                if (reason) act(`/api/admin/accounts/${account.id}/pause`, { reason });
              }}
            >
              Pause account
            </Button>
          )}
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-4">
        <Card>
          <CardHeader>
            <CardTitle className="text-sm text-muted-foreground">Plan</CardTitle>
          </CardHeader>
          <CardContent>
            <span className="text-xl font-semibold">{planLabel(account.plan)}</span>{" "}
            <Badge variant={account.subscriptionStatus === "active" ? "default" : "outline"}>
              {account.subscriptionStatus}
            </Badge>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-sm text-muted-foreground">Usage</CardTitle>
          </CardHeader>
          <CardContent>
            <span className="text-xl font-semibold tabular-nums">
              {account.monthlyEmailSentCount.toLocaleString()}/
              {account.monthlyEmailLimit.toLocaleString()}
            </span>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-sm text-muted-foreground">Bounce rate</CardTitle>
          </CardHeader>
          <CardContent>
            <span className="text-xl font-semibold">{(health.bounceRate * 100).toFixed(2)}%</span>
            <span className="text-xs text-muted-foreground"> of {health.attempted}</span>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-sm text-muted-foreground">Complaint rate</CardTitle>
          </CardHeader>
          <CardContent>
            <span className="text-xl font-semibold">
              {(health.complaintRate * 100).toFixed(3)}%
            </span>
          </CardContent>
        </Card>
      </div>

      {/* The receivers' own verdict. Broken out from the bounce rate because it
          is the number that moves first when a sender turns abusive: mailbox
          providers refuse the content long before the addresses go bad. */}
      <div className="grid gap-4 md:grid-cols-4">
        <Card>
          <CardHeader>
            <CardTitle className="text-sm text-muted-foreground">Rejected as spam</CardTitle>
          </CardHeader>
          <CardContent>
            <span
              className={
                health.spamRejectRate >= 0.05
                  ? "text-xl font-semibold text-destructive"
                  : "text-xl font-semibold"
              }
            >
              {(health.spamRejectRate * 100).toFixed(2)}%
            </span>
            <span className="text-xs text-muted-foreground"> ({health.spamRejected})</span>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-sm text-muted-foreground">Today</CardTitle>
          </CardHeader>
          <CardContent>
            <span className="text-xl font-semibold tabular-nums">
              {account.dailySentCount.toLocaleString()}
            </span>
            <span className="text-xs text-muted-foreground">
              {account.rampLiftedAt ? " · ramp lifted" : " · ramped"}
            </span>
          </CardContent>
        </Card>
      </div>

      {account.pausedReason && (
        <p className="text-sm text-destructive">Paused: {account.pausedReason}</p>
      )}

      {/* How much of this account's transactional mail the AI reads. The rules
          check every send whatever the tier; this only moves the AI pass. */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-3 text-base">
            AI content review
            <Badge variant={TRUST_TIER_VARIANT[reviewTrust.tier]}>
              {TRUST_TIER_LABEL[reviewTrust.tier]}
            </Badge>
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4 text-sm">
          <p className="text-muted-foreground">
            {reviewTrust.sampleEvery <= 1
              ? "Every new email shape gets an AI review."
              : `1 in ${reviewTrust.sampleEvery} new email shapes gets an AI review.`}{" "}
            Campaigns are always reviewed in full, and the rule checks run on every send.
          </p>
          {reviewTrust.reasons.length > 0 && (
            <ul className="grid list-disc gap-1 pl-5 text-muted-foreground">
              {reviewTrust.reasons.map((reason) => (
                <li key={reason}>{reason}</li>
              ))}
            </ul>
          )}
          <dl className="grid gap-4 sm:grid-cols-3">
            <div className="grid gap-1">
              <dt className="text-muted-foreground">Delivered</dt>
              <dd>
                <span className="text-xl font-semibold tabular-nums">
                  {reviewTrust.stats.deliveredCapped.toLocaleString()}
                </span>
                <span className="text-xs text-muted-foreground">
                  {" "}
                  of {reviewTrustTargets.delivered.toLocaleString()} needed
                </span>
              </dd>
            </div>
            <div className="grid gap-1">
              <dt className="text-muted-foreground">Clean AI reviews</dt>
              <dd>
                <span className="text-xl font-semibold tabular-nums">
                  {reviewTrust.stats.aiClean.toLocaleString()}
                </span>
                <span className="text-xs text-muted-foreground">
                  {" "}
                  of {reviewTrustTargets.aiClean.toLocaleString()} needed
                </span>
              </dd>
            </div>
            <div className="grid gap-1">
              <dt className="text-muted-foreground">Last flagged</dt>
              <dd>
                {reviewTrust.stats.lastFlaggedAt ? (
                  <span className="text-xl font-semibold">
                    {formatDate(reviewTrust.stats.lastFlaggedAt)}
                  </span>
                ) : (
                  <>
                    <span className="text-xl font-semibold">Never</span>
                    <span className="text-xs text-muted-foreground">
                      {" "}
                      in the last {reviewTrustTargets.lookbackDays} days
                    </span>
                  </>
                )}
              </dd>
            </div>
          </dl>
        </CardContent>
      </Card>

      {blockedContent.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">
              Content refused by the pre-send review ({blockedContent.length})
            </CardTitle>
          </CardHeader>
          <CardContent>
            {/* For API traffic this is the only record of what an account tried
                to send: a transactional email leaves no draft behind, and its
                body is pruned after the retention window. Sorted by how many
                sends each verdict has refused, because that number is the
                difference between one customer mistake and an attack. */}
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Subject</TableHead>
                  <TableHead>From</TableHead>
                  <TableHead>Verdict</TableHead>
                  <TableHead className="text-right">Refused</TableHead>
                  <TableHead>First seen</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {blockedContent.map((row) => (
                  <TableRow key={row.id}>
                    <TableCell className="max-w-[24rem]">
                      <div className="truncate font-medium">{row.subject}</div>
                      <div className="truncate text-xs text-muted-foreground">{row.summary}</div>
                    </TableCell>
                    <TableCell className="text-sm">
                      {row.fromName ? `${row.fromName} <${row.fromEmail}>` : row.fromEmail}
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-2 whitespace-nowrap">
                        <Badge variant={row.riskLevel === "blocked" ? "destructive" : "outline"}>
                          {row.riskLevel}
                        </Badge>
                        {AI_REVIEW_NOTE[row.aiReview] && (
                          <span className="text-xs text-muted-foreground">
                            {AI_REVIEW_NOTE[row.aiReview]}
                          </span>
                        )}
                      </div>
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{row.blockedCount}</TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {formatDate(row.createdAt)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      {apiKeys.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">API keys</CardTitle>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Prefix</TableHead>
                  <TableHead>Scopes</TableHead>
                  <TableHead>Last used</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {apiKeys.map((key) => (
                  <TableRow key={key.id}>
                    <TableCell className="font-medium">{key.name}</TableCell>
                    <TableCell className="font-mono text-xs">{key.keyPrefix}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {key.scopes ?? "base"}
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {key.lastUsedAt ? formatDate(key.lastUsedAt) : "never"}
                    </TableCell>
                    <TableCell className="text-right">
                      {key.revokedAt ? (
                        <Badge variant="outline">revoked</Badge>
                      ) : (
                        <Button
                          size="sm"
                          variant="destructive"
                          disabled={busy}
                          onClick={() =>
                            del(`/api/admin/accounts/${account.id}/api-keys/${key.id}`)
                          }
                        >
                          Revoke
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Sending domains</CardTitle>
        </CardHeader>
        <CardContent>
          {domains === null ? (
            <ListSkeleton rows={2} />
          ) : domains.length === 0 ? (
            <ListEmpty icon={Globe} title="No domains" description="This account hasn't added a sending domain yet." />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Domain</TableHead>
                  <TableHead>Verification</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {domains.map((d) => (
                  <TableRow key={d.id}>
                    <TableCell className="font-medium">
                      {d.domain}
                      {d.shared && (
                        <span className="ml-2 text-xs text-muted-foreground">Day3 test address</span>
                      )}
                    </TableCell>
                    <TableCell>
                      {d.shared ? (
                        <Badge variant={d.sharedDisabledAt ? "destructive" : "secondary"}>
                          {d.sharedDisabledAt ? "cut off" : "shared"}
                        </Badge>
                      ) : d.adminOverrideVerified ? (
                        <Badge>verified (override)</Badge>
                      ) : (
                        <Badge
                          variant={d.verificationStatus === "verified" ? "default" : "secondary"}
                        >
                          {d.verificationStatus}
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell className="text-right">
                      {/* The shared identity's reputation is every tenant's, so an
                          operator needs a lever narrower than pausing the whole
                          account. Override-verify is meaningless here (the row is
                          verified by construction), so the shared row gets this
                          instead. */}
                      {d.shared ? (
                        <Button
                          size="xs"
                          variant={d.sharedDisabledAt ? "outline" : "destructive"}
                          disabled={busy}
                          onClick={() =>
                            act(`/api/admin/accounts/${id}/shared-domain`, {
                              disabled: !d.sharedDisabledAt,
                            })
                          }
                        >
                          {d.sharedDisabledAt ? "Restore access" : "Cut off"}
                        </Button>
                      ) : (
                        !d.adminOverrideVerified &&
                        d.verificationStatus !== "verified" && (
                          <Button
                            size="xs"
                            variant="outline"
                            disabled={busy}
                            onClick={() => act(`/api/admin/domains/${d.id}/override-verify`)}
                          >
                            Override verify
                          </Button>
                        )
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            Campaigns{" "}
            <span className="text-muted-foreground">
              ({subscriberCount.toLocaleString()} subscribers)
            </span>
          </CardTitle>
        </CardHeader>
        <CardContent>
          {detail.campaigns.length === 0 ? (
            <ListEmpty icon={Mail} title="No campaigns" description="This account hasn't created a campaign yet." />
          ) : (
            <>
              <ListToolbar className="mb-4">
                <ListSearch
                  value={campaignList.search}
                  onChange={campaignList.setSearch}
                  placeholder="Search campaigns…"
                />
                <ListFilter
                  value={campaignList.filters.status}
                  onChange={(v) => campaignList.setFilter("status", v)}
                  options={campaignStatusOptions}
                  ariaLabel="Filter by status"
                />
                <ListClear show={campaignList.isFiltered} onClear={campaignList.clearFilters} />
                <ListCount
                  shown={campaignList.shown}
                  total={campaignList.total}
                  noun="campaign"
                  className="ml-auto"
                />
              </ListToolbar>
              {campaignList.isFilteredEmpty ? (
                <ListNoResults onClear={campaignList.clearFilters} />
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <SortableHead label="Name" sortKey="name" sort={campaignList.sort} onSort={campaignList.toggleSort} />
                      <SortableHead label="Status" sortKey="status" sort={campaignList.sort} onSort={campaignList.toggleSort} />
                      <SortableHead label="Risk" sortKey="risk" sort={campaignList.sort} onSort={campaignList.toggleSort} />
                      <SortableHead label="Created" sortKey="createdAt" sort={campaignList.sort} onSort={campaignList.toggleSort} />
                      <TableHead />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {campaignList.view!.map((cmp) => {
                      const open = openCampaignId === cmp.id;
                      const toggle = () => setOpenCampaignId(open ? null : cmp.id);
                      return (
                        <Fragment key={cmp.id}>
                          {/* The row click is a mouse convenience; the button in
                              the last cell is the real focusable control. */}
                          <TableRow className="group cursor-pointer" onClick={toggle}>
                            <TableCell className="font-medium">{cmp.name}</TableCell>
                            <TableCell>
                              <Badge variant={statusVariant(cmp.status)}>{statusLabel(cmp.status)}</Badge>
                            </TableCell>
                            <TableCell>{cmp.riskLevel ?? "—"}</TableCell>
                            <TableCell className="text-muted-foreground">{formatDate(cmp.createdAt)}</TableCell>
                            <TableCell className="text-right">
                              <Button
                                variant="ghost"
                                size="sm"
                                className="text-muted-foreground"
                                aria-expanded={open}
                                aria-controls={`campaign-content-${cmp.id}`}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  toggle();
                                }}
                              >
                                {open ? "Hide" : "View email"}
                                <ChevronDown
                                  className={`size-4 transition-transform ${open ? "rotate-180" : ""}`}
                                />
                              </Button>
                            </TableCell>
                          </TableRow>
                          {open && (
                            <TableRow className="hover:bg-transparent">
                              <TableCell colSpan={5} className="bg-muted/30">
                                <div id={`campaign-content-${cmp.id}`} className="space-y-3 py-1">
                                  <div className="grid gap-1 text-sm text-muted-foreground">
                                    <span>Subject: {cmp.subject}</span>
                                    <span>
                                      From: {cmp.fromName} &lt;{cmp.fromEmail}&gt;
                                    </span>
                                    {cmp.riskSummary && <span>Risk: {cmp.riskSummary}</span>}
                                    {cmp.pausedReason && <span>Paused: {cmp.pausedReason}</span>}
                                  </div>
                                  <EmailPreview
                                    htmlBody={cmp.htmlBody}
                                    theme={cmp.theme}
                                    className="max-h-96"
                                    frameClassName="h-80"
                                  />
                                  <p className="text-xs text-muted-foreground">
                                    The email as it was sent. Merge tags appear as-is, and the
                                    mailing address and unsubscribe link are added per recipient.
                                  </p>
                                </div>
                              </TableCell>
                            </TableRow>
                          )}
                        </Fragment>
                      );
                    })}
                  </TableBody>
                </Table>
              )}
            </>
          )}
        </CardContent>
      </Card>

      <Link href="/admin" className="text-sm text-primary underline-offset-4 hover:underline">
        ← Back to admin
      </Link>
    </div>
  );
}
