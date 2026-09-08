"use client";

import { Card, CardContent } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { ListSkeleton } from "@/components/ui/data-list";
import { nodeTitle } from "@/lib/automation-graph";
import type { AutomationStats, GraphPayload } from "@/lib/automation-types";
import { KIND_META } from "./node-kinds";
import { cn } from "@/lib/utils";

function pct(part: number, whole: number): string {
  return whole > 0 ? `${Math.round((part / whole) * 100)}%` : "";
}

const REASON_LABELS: Record<string, string> = {
  suppressed: "suppressed",
  unsubscribed: "unsubscribed",
  not_subscribed: "not subscribed",
  topic_opt_out: "opted out of the topic",
  sandbox_not_member: "not an org member (sandbox)",
  quota: "monthly allowance reached",
  already_sent: "already received it",
};

function reasonLabel(reason: string): string {
  return REASON_LABELS[reason] ?? reason.replace(/_/g, " ");
}

// Per-step numbers for the Stats tab. Rows follow the graph (live version when
// there is one, since that is what people are running), and skips are broken
// out by reason under the step name because "why didn't this send?" is the
// question this table exists to answer.
export function StatsTable({
  stats,
  graph,
  loading,
}: {
  stats: AutomationStats | null;
  graph: GraphPayload;
  loading: boolean;
}) {
  if (loading && !stats) {
    return (
      <Card>
        <CardContent>
          <ListSkeleton rows={4} />
        </CardContent>
      </Card>
    );
  }

  const byKey = new Map((stats?.nodes ?? []).map((n) => [n.nodeKey, n]));
  const rows = graph.nodes.filter((n) => n.kind !== "trigger" && n.kind !== "end");
  const anySends = rows.some((n) => (byKey.get(n.key)?.sent ?? 0) > 0);

  return (
    <Card>
      <CardContent>
        {rows.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">
            Add steps to the canvas to see numbers here.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Step</TableHead>
                  <TableHead className="text-right">Waiting</TableHead>
                  <TableHead className="text-right">Sent</TableHead>
                  <TableHead className="text-right">Opened</TableHead>
                  <TableHead className="text-right">Clicked</TableHead>
                  <TableHead className="text-right">Unsubscribed</TableHead>
                  <TableHead className="text-right">Skipped</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((node) => {
                  const s = byKey.get(node.key);
                  const meta = KIND_META[node.kind];
                  const Icon = meta.icon;
                  const isSend = node.kind === "send";
                  const reasons = Object.entries(s?.skippedByReason ?? {}).filter(([, n]) => n > 0);
                  const failed = (s?.failed ?? 0) + (s?.bounced ?? 0) + (s?.complained ?? 0);
                  return (
                    <TableRow key={node.key}>
                      <TableCell>
                        <div className="flex items-center gap-2.5">
                          <span
                            className={cn(
                              "flex size-7 shrink-0 items-center justify-center rounded-md bg-muted",
                              meta.tone,
                            )}
                          >
                            <Icon className="size-3.5" />
                          </span>
                          <div className="min-w-0">
                            <div className="truncate font-medium">{nodeTitle(node)}</div>
                            {isSend && (reasons.length > 0 || failed > 0) && (
                              <div className="text-xs text-muted-foreground">
                                {[
                                  ...reasons.map(([r, n]) => `${n.toLocaleString()} ${reasonLabel(r)}`),
                                  ...(failed > 0 ? [`${failed.toLocaleString()} bounced or failed`] : []),
                                ].join(", ")}
                              </div>
                            )}
                          </div>
                        </div>
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {(s?.waiting ?? 0).toLocaleString()}
                      </TableCell>
                      {isSend ? (
                        <>
                          <TableCell className="text-right tabular-nums">
                            {(s?.sent ?? 0).toLocaleString()}
                          </TableCell>
                          <TableCell className="text-right tabular-nums">
                            {(s?.opened ?? 0).toLocaleString()}
                            <Rate value={pct(s?.opened ?? 0, s?.sent ?? 0)} />
                          </TableCell>
                          <TableCell className="text-right tabular-nums">
                            {(s?.clicked ?? 0).toLocaleString()}
                            <Rate value={pct(s?.clicked ?? 0, s?.sent ?? 0)} />
                          </TableCell>
                          <TableCell className="text-right tabular-nums">
                            {(s?.unsubscribed ?? 0).toLocaleString()}
                          </TableCell>
                          <TableCell className="text-right tabular-nums">
                            {(s?.skipped ?? 0).toLocaleString()}
                          </TableCell>
                        </>
                      ) : (
                        <TableCell colSpan={5} className="text-right text-muted-foreground" />
                      )}
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
            {!anySends && (
              <p className="pt-4 text-xs text-muted-foreground">
                Send numbers appear once the first email has gone out.
              </p>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function Rate({ value }: { value: string }) {
  if (!value) return null;
  return <span className="ml-1.5 text-xs text-muted-foreground">{value}</span>;
}
