"use client";

import { useEffect, useState } from "react";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { Sender, SendingDomain } from "@/lib/types";
import { SharedDomainCard } from "@/components/shared-domain-card";
import { DomainsView } from "./domains-view";
import { SendersView } from "./senders-view";

type TabKey = "domains" | "senders";

// Domains | Senders under one "Sending" heading. The tab is reflected in ?tab=
// so a deep link (the composer's "set up a domain", the domain guide's "add a
// sender") lands on the right half, and the old /senders URL redirects here.
export function SendingView({
  initialDomains,
  initialSenders,
  sharedFromEmail,
}: {
  initialDomains: SendingDomain[];
  initialSenders: Sender[];
  // The Day3 test address, when the account has a usable one. Null turns the
  // card off entirely (feature unconfigured, or cut off by an operator).
  sharedFromEmail: string | null;
}) {
  const [tab, setTab] = useState<TabKey>("domains");
  // Opens the Add domain dialog. Onboarding links arrive with ?add=domain so
  // "Set up my domain" lands in the form rather than on a page with a button
  // for it; the param is dropped so a refresh doesn't reopen the dialog.
  const [addDomainRequest, setAddDomainRequest] = useState(0);
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("tab") === "senders") setTab("senders");
    if (params.get("add") === "domain") {
      setAddDomainRequest((n) => n + 1);
      const url = new URL(window.location.href);
      url.searchParams.delete("add");
      window.history.replaceState(null, "", url);
    }
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
      {tab === "domains" && sharedFromEmail && (
        <SharedDomainCard
          fromEmail={sharedFromEmail}
          disabled={false}
          onAddDomain={() => setAddDomainRequest((n) => n + 1)}
        />
      )}
      {tab === "domains" ? (
        <DomainsView initialDomains={initialDomains} tabs={tabs} addRequest={addDomainRequest} />
      ) : (
        <SendersView initialSenders={initialSenders} initialDomains={initialDomains} tabs={tabs} />
      )}
    </div>
  );
}
