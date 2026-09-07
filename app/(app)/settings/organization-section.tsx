"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useClerk, useOrganization } from "@clerk/nextjs";
import { CreditCard, ImageUp, Settings2, Users } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { OrbitLoader } from "@/components/ui/orbit-loader";
import { Skeleton } from "@/components/ui/skeleton";
import { planLabel } from "@/lib/plans-catalog";
import type { Account } from "@/lib/types";

// The organization section is Day3's own UI over Clerk's organization, not an
// embedded <OrganizationProfile>. The embedded card brought its own palette,
// shadows and a nav-inside-a-page layout that read as a different product. What
// people touch most (name, logo) is a two-field form against the Clerk org
// object, so it is native. Everything with real edge cases (members, invitations,
// roles, verified domains, billing, leave/delete) stays in Clerk's component,
// opened as a modal: an overlay is a seam users accept, and it keeps the part
// that has to "just work" on Clerk's side.
//
// Modal start paths are Clerk's own OrganizationProfile routes.
const MEMBERS_PATH = "/organization-members";
const BILLING_PATH = "/organization-billing";

// Only admins may edit the profile; Clerk's system permission is what its own UI
// checks, so mirror it rather than inventing a role test.
const PROFILE_MANAGE = "org:sys_profile:manage";

export function OrganizationSection({ account }: { account: Account }) {
  const { isLoaded, organization, membership } = useOrganization();
  const clerk = useClerk();

  const canManage = membership?.permissions.includes(PROFILE_MANAGE) ?? false;

  const [name, setName] = useState(organization?.name ?? "");
  const [savingName, setSavingName] = useState(false);
  const [uploadingLogo, setUploadingLogo] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  // Clerk's name is the source of truth (Postgres follows it via webhook), so a
  // change made in the modal resyncs the field when the hook re-renders.
  const orgName = organization?.name;
  useEffect(() => {
    if (orgName !== undefined) setName(orgName);
  }, [orgName]);

  if (!isLoaded || !organization) {
    return (
      <section className="space-y-4">
        <h2 className="text-base font-medium">Organization</h2>
        <div className="flex items-center gap-4">
          <Skeleton className="size-14 rounded-lg" />
          <div className="space-y-2">
            <Skeleton className="h-4 w-40" />
            <Skeleton className="h-3 w-24" />
          </div>
        </div>
      </section>
    );
  }

  const members = organization.membersCount;
  const nameDirty = name.trim() !== organization.name && name.trim().length > 0;

  async function saveName() {
    if (!organization || !nameDirty) return;
    setSavingName(true);
    try {
      await organization.update({ name: name.trim() });
      toast.success("Organization name saved");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setSavingName(false);
    }
  }

  async function uploadLogo(file: File | undefined) {
    if (!organization || !file) return;
    setUploadingLogo(true);
    try {
      await organization.setLogo({ file });
      toast.success("Logo updated");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to upload logo");
    } finally {
      setUploadingLogo(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  return (
    <section className="space-y-5">
      <div className="space-y-1">
        <h2 className="text-base font-medium">Organization</h2>
        <p className="text-sm text-muted-foreground">
          The workspace your team shares. Everyone in it sees the same audiences, campaigns and
          sending domains.
        </p>
      </div>

      {/* Identity row: logo, name, the two facts people look for. */}
      <div className="flex items-start gap-4">
        <div className="relative shrink-0">
          {organization.hasImage ? (
            <img
              src={organization.imageUrl}
              alt=""
              className="size-14 rounded-lg border border-border object-cover"
            />
          ) : (
            <div
              aria-hidden
              className="flex size-14 items-center justify-center rounded-lg border border-border bg-muted font-display text-xl text-foreground"
            >
              {organization.name.trim().charAt(0).toUpperCase() || "?"}
            </div>
          )}
          {uploadingLogo && (
            <div className="absolute inset-0 flex items-center justify-center rounded-lg bg-background/70">
              <OrbitLoader size={18} />
            </div>
          )}
        </div>
        <div className="min-w-0 flex-1 space-y-1 pt-0.5">
          <div className="truncate text-base font-medium">{organization.name}</div>
          <div className="text-sm text-muted-foreground">
            {members === 1 ? "1 member" : `${members.toLocaleString()} members`}
            <span className="mx-1.5 opacity-50">·</span>
            <Link href="/billing" className="underline-offset-4 hover:underline">
              {planLabel(account.plan)} plan
            </Link>
          </div>
          {canManage && (
            <div className="pt-1">
              <input
                ref={fileRef}
                type="file"
                accept="image/png,image/jpeg,image/gif,image/webp"
                className="hidden"
                onChange={(e) => uploadLogo(e.target.files?.[0])}
              />
              <Button
                variant="outline"
                size="sm"
                disabled={uploadingLogo}
                onClick={() => fileRef.current?.click()}
              >
                <ImageUp data-icon="inline-start" />
                {organization.hasImage ? "Change logo" : "Add logo"}
              </Button>
            </div>
          )}
        </div>
      </div>

      {canManage && (
        <div className="max-w-lg space-y-2">
          <Label htmlFor="org-name">Organization name</Label>
          <div className="flex gap-2">
            <Input
              id="org-name"
              value={name}
              maxLength={256}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void saveName();
              }}
            />
            <Button disabled={!nameDirty || savingName} onClick={saveName}>
              {savingName && <OrbitLoader size={16} />}
              Save
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            Shown as the company name in email footers.
          </p>
        </div>
      )}

      {/* The Clerk-owned surfaces, opened as modals rather than embedded. */}
      <div className="flex flex-wrap gap-2">
        <Button
          variant="outline"
          onClick={() => clerk.openOrganizationProfile({ __experimental_startPath: MEMBERS_PATH })}
        >
          <Users data-icon="inline-start" />
          Members &amp; invitations
        </Button>
        {canManage && (
          <Button
            variant="outline"
            onClick={() => clerk.openOrganizationProfile({ __experimental_startPath: BILLING_PATH })}
          >
            <CreditCard data-icon="inline-start" />
            Payment &amp; invoices
          </Button>
        )}
        <Button variant="ghost" onClick={() => clerk.openOrganizationProfile()}>
          <Settings2 data-icon="inline-start" />
          More settings
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        Verified domains for auto-join, and leaving or deleting the organization, live under More
        settings.
      </p>
    </section>
  );
}
