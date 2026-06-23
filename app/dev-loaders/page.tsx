"use client";

// SCRATCH PREVIEW — delete before shipping. Renders every Day3 loader and each
// campaign send state so they can be eyeballed at http://localhost:3000/dev-loaders
// without auth or a real campaign. Toggle dark mode with the button.

import { useState } from "react";
import { OrbitLoader, OrbitLoaderScreen } from "@/components/ui/orbit-loader";
import { LaunchStream, SendDots } from "@/components/ui/send-loader";
import { Button } from "@/components/ui/button";

const SEND_STATES: { status: string; title: string; subtitle: string }[] = [
  { status: "pending_review", title: "Reviewing your campaign", subtitle: "Running a quick safety check before it goes out." },
  { status: "approved", title: "Approved — preparing to send", subtitle: "Getting everything ready." },
  { status: "generating_recipients", title: "Building your send list", subtitle: "Gathering the subscribers for this campaign." },
  { status: "sending", title: "Sending your campaign", subtitle: "842 of 1,248 sent · going out now" },
];

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-3">
      <h2 className="text-sm font-medium text-muted-foreground">{title}</h2>
      {children}
    </section>
  );
}

export default function DevLoadersPage() {
  const [dark, setDark] = useState(false);

  return (
    <div className={dark ? "dark" : ""}>
      <div className="min-h-screen bg-background p-8 text-foreground">
        <div className="mx-auto max-w-3xl space-y-10">
          <div className="flex items-center justify-between">
            <h1 className="text-2xl font-semibold tracking-tight">Loader preview</h1>
            <Button variant="outline" onClick={() => setDark((d) => !d)}>
              {dark ? "Light" : "Dark"} mode
            </Button>
          </div>

          <Section title="OrbitLoader — sizes used across the app">
            <div className="flex flex-wrap items-center gap-8 rounded-xl border p-6">
              <OrbitLoader size={14} />
              <OrbitLoader size={16} />
              <OrbitLoader size={32} />
              <OrbitLoader size={64} />
              <OrbitLoader size={120} />
            </div>
          </Section>

          <Section title="OrbitLoaderScreen — full-page gate (campaign/admin detail)">
            <div className="rounded-xl border">
              <OrbitLoaderScreen />
            </div>
          </Section>

          <Section title="SendDots — inside the Submit & send button">
            <div className="flex flex-wrap items-center gap-4 rounded-xl border p-6">
              <Button>
                <SendDots />
                Sending…
              </Button>
              <Button variant="outline">
                <SendDots />
                Sending…
              </Button>
            </div>
          </Section>

          <Section title="LaunchStream — standalone">
            <div className="space-y-4 rounded-xl border p-6">
              <LaunchStream />
              <LaunchStream scale={0.8} />
              <LaunchStream scale={0.6} />
            </div>
          </Section>

          <Section title="Sending banner — every in-flight campaign state">
            <div className="space-y-3">
              {SEND_STATES.map((s) => (
                <div
                  key={s.status}
                  className="flex flex-col gap-4 rounded-xl border border-primary/20 bg-primary/5 p-5 sm:flex-row sm:items-center"
                >
                  <LaunchStream scale={0.8} />
                  <div className="min-w-0">
                    <p className="text-xs text-muted-foreground">{s.status}</p>
                    <h2 className="font-medium">{s.title}</h2>
                    <p className="text-sm text-muted-foreground">{s.subtitle}</p>
                  </div>
                </div>
              ))}
            </div>
          </Section>
        </div>
      </div>
    </div>
  );
}
