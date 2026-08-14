"use client";

// The "add your business address" dialog. A physical mailing address is legally
// required in every email footer, so a missing one blocks sending — and it's the
// one send gate a user can clear without leaving what they're doing. Shared by the
// composer's footer preview and the campaign page's "can't be sent yet" notice so
// both fix it in place, with the same wording, instead of sending people to
// Settings and back.
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { OrbitLoader } from "@/components/ui/orbit-loader";
import { Textarea } from "@/components/ui/textarea";
import { useApi } from "@/lib/api";

// One page can hold several views of the same account (the campaign page shows the
// send gates *and* mounts the composer, whose footer preview renders the address),
// so a save announces itself and every listener refreshes. Without this, adding the
// address from the notice would leave the footer below it still nagging.
export const ACCOUNT_UPDATED_EVENT = "day3:account-updated";

export type AccountUpdatedDetail = { companyAddress: string };

export function BusinessAddressDialog({
  open,
  onOpenChange,
  initialValue,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  // The address already on file, seeded into the field each time the dialog opens.
  initialValue?: string | null;
  // Called with the saved address, for callers that keep their own copy of the
  // account or need to re-check the send gates.
  onSaved?: (address: string) => void;
}) {
  const api = useApi();
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);

  // Reseed on each open so a cancelled edit doesn't linger into the next one.
  useEffect(() => {
    if (open) setDraft(initialValue?.trim() ?? "");
  }, [open, initialValue]);

  async function save() {
    const value = draft.trim();
    if (!value) {
      toast.error("Enter your business address");
      return;
    }
    setSaving(true);
    try {
      await api.patch("/api/account", { companyAddress: value });
      onOpenChange(false);
      window.dispatchEvent(
        new CustomEvent<AccountUpdatedDetail>(ACCOUNT_UPDATED_EVENT, {
          detail: { companyAddress: value },
        }),
      );
      onSaved?.(value);
      toast.success("Address saved");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't save address");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Your business address</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">
            Anti-spam laws (CAN-SPAM, GDPR) require a physical mailing address in every
            email. It&apos;s added to the footer of all your campaigns.
          </p>
          <div className="space-y-1.5">
            <Label htmlFor="companyAddress">Address</Label>
            <Textarea
              id="companyAddress"
              rows={3}
              placeholder="Acme Inc, 123 Main St, Copenhagen, DK"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
            />
          </div>
          <div className="flex justify-end gap-2 pt-1">
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="button" onClick={save} disabled={saving}>
              {saving && <OrbitLoader size={16} />}
              Save address
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
