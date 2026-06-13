import { Link } from "react-router";
import { useAuth } from "@clerk/react";
import { Button } from "@/components/ui/button";

export function LandingPage() {
  const { isSignedIn } = useAuth();

  return (
    <main className="flex min-h-screen flex-col items-center justify-center px-4">
      <div className="max-w-2xl space-y-8 text-center">
        <div className="space-y-4">
          <h1 className="text-4xl font-bold tracking-tight sm:text-5xl">Day3</h1>
          <p className="mx-auto max-w-lg text-lg text-muted-foreground">
            Simple product update emails for small SaaS teams.
            <br />
            No marketing suite. No contact tax. No free tier.
          </p>
        </div>

        <div className="flex justify-center gap-4">
          {isSignedIn ? (
            <Link to="/dashboard">
              <Button size="lg">Open dashboard</Button>
            </Link>
          ) : (
            <>
              <Link to="/sign-up">
                <Button size="lg">Get started — $9/mo</Button>
              </Link>
              <Link to="/sign-in">
                <Button variant="outline" size="lg">
                  Sign in
                </Button>
              </Link>
            </>
          )}
        </div>
      </div>
    </main>
  );
}
