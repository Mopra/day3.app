"use client";

import Link from "next/link";
import { FlaskConical } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";

// The Day3 test address, shown above the customer's own domains.
//
// It is deliberately not a row in the domains list. Listing it there would say
// "you have a verified domain", which is both false in the sense the user cares
// about (they cannot reach their subscribers from it) and quietly destructive:
// the domain step is the one piece of setup standing between them and real
// sending, and a green tick beside our domain would retire it.
//
// So it gets its own card that says exactly what it is and what it is not.
export function SharedDomainCard({
  fromEmail,
  disabled,
}: {
  fromEmail: string;
  // True when an operator has cut this account off the shared identity.
  disabled: boolean;
}) {
  return (
    <Card className="border-dashed">
      <CardContent className="flex flex-col gap-3 sm:flex-row sm:items-start">
        <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted">
          <FlaskConical className="size-4 text-muted-foreground" aria-hidden />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="font-medium">Your Day3 test address</h3>
            {disabled ? (
              <Badge variant="destructive">Disabled</Badge>
            ) : (
              <Badge variant="secondary">Ready</Badge>
            )}
          </div>
          <p className="mt-1 break-all font-mono text-xs text-muted-foreground">{fromEmail}</p>
          <p className="mt-2 text-sm text-muted-foreground">
            {disabled ? (
              <>
                This address is no longer available on your account. Verify your own domain below to
                keep sending.
              </>
            ) : (
              <>
                Works right now, with nothing to set up, but it only reaches people on your own
                team. To email your subscribers, verify a domain of your own below. It also makes
                your mail arrive from your name instead of ours, which is most of what stops email
                landing in spam.
              </>
            )}
          </p>
        </div>
        <Link
          href="#add-domain"
          className="shrink-0 text-sm font-medium text-primary underline-offset-4 hover:underline"
        >
          Add my domain
        </Link>
      </CardContent>
    </Card>
  );
}
