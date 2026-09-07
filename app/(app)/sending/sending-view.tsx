"use client";

import { useEffect, useState } from "react";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { Sender, SendingDomain } from "@/lib/types";
import { DomainsView } from "./domains-view";
import { SendersView } from "./senders-view";

type TabKey = "domains" | "senders";

// Domains | Senders under one "Sending" heading. The tab is reflected in ?tab=
// so a deep link (the composer's "set up a domain", the domain guide's "add a
// sender") lands on the right half, and the old /senders URL redirects here.
export function SendingView({
  initialDomains,
  initialSenders,
}: {
  initialDomains: SendingDomain[];
  initialSenders: Sender[];
}) {
  const [tab, setTab] = useState<TabKey>("domains");
  useEffect(() => {
    if (new URLSearchParams(window.location.search).get("tab") === "senders") setTab("senders");
  }, []);
  function changeTab(next: TabKey) {
    setTab(next);
    const url = new URL(window.location.href);
    if (next === "domains") url.searchParams.delete("tab");
    else url.searchParams.set("tab", next);
    window.history.replaceState(null, "", url);
  }

  const tabs = (
    <Tabs value={tab} onValueChange={(v) => changeTab(v as TabKey)}>
      <TabsList>
        <TabsTrigger value="domains">Domains</TabsTrigger>
        <TabsTrigger value="senders">Senders</TabsTrigger>
      </TabsList>
    </Tabs>
  );

  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-display text-2xl sm:text-3xl">Sending</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          The domains you send from and the From identities your emails go out as.
        </p>
      </div>
      {tab === "domains" ? (
        <DomainsView initialDomains={initialDomains} tabs={tabs} />
      ) : (
        <SendersView initialSenders={initialSenders} initialDomains={initialDomains} tabs={tabs} />
      )}
    </div>
  );
}
