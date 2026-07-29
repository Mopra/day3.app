"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { OrganizationProfile } from "@clerk/nextjs";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { OrbitLoader } from "@/components/ui/orbit-loader";
import { useApi } from "@/lib/api";
import type { Account, AccountHealth } from "@/lib/types";

export default function SettingsPage() {
  const api = useApi();
  const [account, setAccount] = useState<Account | null>(null);
  const [address, setAddress] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api
      .get<{ account: Account; health: AccountHealth }>("/api/account")
      .then((res) => {
        setAccount(res.account);
        setAddress(res.account.companyAddress ?? "");
      })
      .catch((err) => toast.error(err.message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="space-y-10">
      <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>

      <section className="space-y-4">
        <h2 className="text-base font-medium">Sender identity</h2>
        <p className="text-sm text-muted-foreground">
          Shown in the footer of every email ({"{{company_address}}"}). A physical mailing
          address is required by anti-spam laws.
        </p>
        <div className="max-w-lg space-y-2">
          <Label htmlFor="address">Company / mailing address</Label>
          <Input
            id="address"
            placeholder="Acme Inc, 123 Main St, Copenhagen, DK"
            value={address}
            onChange={(e) => setAddress(e.target.value)}
          />
        </div>
        <Button
          disabled={saving || !account}
          onClick={async () => {
            setSaving(true);
            try {
              await api.patch("/api/account", { companyAddress: address });
              toast.success("Saved");
            } catch (err) {
              toast.error(err instanceof Error ? err.message : "Failed");
            } finally {
              setSaving(false);
            }
          }}
        >
          {saving && <OrbitLoader size={16} />}
          Save
        </Button>
      </section>

      {/* API keys moved to their own page — they come with the docs that make
          them usable, which is more than a settings section can carry. */}
      <section className="space-y-2">
        <h2 className="text-base font-medium">API keys</h2>
        <p className="text-sm text-muted-foreground">
          Keys for the public API now live on their own page, next to the setup guide and code
          examples. <Link href="/api-keys" className="underline underline-offset-4">Go to API keys</Link>.
        </p>
      </section>

      <section className="space-y-4">
        <h2 className="text-base font-medium">Organization</h2>
        <OrganizationProfile routing="hash" />
      </section>
    </div>
  );
}
