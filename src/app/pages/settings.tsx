import { useEffect, useState } from "react";
import { OrganizationProfile } from "@clerk/react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useApi } from "../lib/api";
import type { Account, AccountHealth } from "../lib/types";

export function SettingsPage() {
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
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Sender identity</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
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
            Save
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Organization</CardTitle>
        </CardHeader>
        <CardContent>
          <OrganizationProfile routing="hash" />
        </CardContent>
      </Card>
    </div>
  );
}
