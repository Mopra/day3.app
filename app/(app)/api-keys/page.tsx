"use client";

import { useState } from "react";
import { ApiKeysSection } from "@/components/api-keys-section";
import { ApiDocsSection } from "@/components/api-docs-section";
import { WebhooksSection } from "@/components/webhooks-section";

// A page of its own rather than a Settings section: this is a developer surface
// people arrive at with a task in hand ("import my list", "sync my users"), and
// the docs below the keys are most of what makes it useful.
//
// The freshly-minted key is held here, in memory only, so the quickstart can
// prefill the `export DAY3_API_KEY=…` line while the user is still on the page.
export default function ApiKeysPage() {
  const [freshKey, setFreshKey] = useState<string | null>(null);

  return (
    <div className="max-w-4xl space-y-10">
      <div className="space-y-1">
        <h1 className="font-display text-2xl sm:text-3xl">API keys</h1>
        <p className="text-sm text-muted-foreground">
          Day3&apos;s REST API lets your own code — or an AI assistant working in your codebase —
          manage audiences, contacts, custom fields, segments and topics, and write campaign
          emails. Connect an AI editor over MCP and it can draft them for you.
        </p>
      </div>

      <ApiKeysSection onKeyCreated={setFreshKey} />

      <WebhooksSection />

      <ApiDocsSection freshKey={freshKey} />
    </div>
  );
}
