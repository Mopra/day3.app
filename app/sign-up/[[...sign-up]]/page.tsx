import Image from "next/image";
import { SignUp } from "@clerk/nextjs";
import { Check } from "lucide-react";

// The first screen a new customer sees after clicking "Get started". It used to
// be a bare Clerk box on an empty page: no logo, nothing saying what happens
// next. The three lines below are the promise the first minute keeps (a real
// email in your own inbox before any setup), so the form reads as the start of
// something rather than a gate.
const PROMISES = [
  "Send yourself a real email in about a minute",
  "No DNS, no imports and no card to get started",
  "Free to set up. Pay only to reach your list",
];

export default function SignUpPage() {
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center gap-8 px-4 py-12">
      <div className="max-w-sm space-y-5 text-center">
        <div className="flex justify-center">
          <Image src="/day3-lockup-light.svg" alt="Day3" width={157} height={40} priority />
        </div>
        <ul className="space-y-2 text-left text-sm text-muted-foreground">
          {PROMISES.map((line) => (
            <li key={line} className="flex items-start gap-2">
              <Check className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden />
              <span>{line}</span>
            </li>
          ))}
        </ul>
      </div>
      <SignUp signInUrl="/sign-in" fallbackRedirectUrl="/dashboard" />
    </div>
  );
}
