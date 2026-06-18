"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useApi } from "@/lib/api";
import { formatDate, statusLabel, statusVariant } from "@/lib/format";
import type { CampaignListItem } from "@/lib/types";

export default function CampaignsPage() {
  const api = useApi();
  const [campaigns, setCampaigns] = useState<CampaignListItem[] | null>(null);

  useEffect(() => {
    api
      .get<{ campaigns: CampaignListItem[] }>("/api/campaigns")
      .then((res) => setCampaigns(res.campaigns))
      .catch((err) => toast.error(err.message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold tracking-tight">Campaigns</h1>
        <Link href="/campaigns/new">
          <Button>New campaign</Button>
        </Link>
      </div>

      <Card>
        <CardContent>
          {campaigns === null ? (
            <Skeleton className="h-24 w-full" />
          ) : campaigns.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">
              No campaigns yet. Write your first product update.
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Subject</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Audience</TableHead>
                  <TableHead>Sent</TableHead>
                  <TableHead>Created</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {campaigns.map((c) => (
                  <TableRow key={c.id}>
                    <TableCell>
                      <Link href={`/campaigns/${c.id}`} className="font-medium hover:underline">
                        {c.name}
                      </Link>
                    </TableCell>
                    <TableCell className="max-w-56 truncate text-muted-foreground">
                      {c.subject}
                    </TableCell>
                    <TableCell>
                      <Badge variant={statusVariant(c.status)}>{statusLabel(c.status)}</Badge>
                    </TableCell>
                    <TableCell className="text-muted-foreground">{c.audienceName ?? "—"}</TableCell>
                    <TableCell>{c.sentCount}</TableCell>
                    <TableCell>{formatDate(c.createdAt)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
