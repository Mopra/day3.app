import Link from "next/link";
import { Button } from "@/components/ui/button";

export default function LandingPage() {
  return (
    <main className="flex flex-col items-center justify-center min-h-screen px-4">
      <div className="max-w-2xl text-center space-y-8">
        <div className="space-y-4">
          <h1 className="text-4xl sm:text-5xl font-bold tracking-tight">
            Day3
          </h1>
          <p className="text-lg text-muted-foreground max-w-lg mx-auto">
            Build. Ship. Distribute.
          </p>
        </div>

        <div className="flex gap-4 justify-center">
          <Link href="/sign-up">
            <Button size="lg">Get started</Button>
          </Link>
          <Link href="/sign-in">
            <Button variant="outline" size="lg">Sign in</Button>
          </Link>
        </div>
      </div>
    </main>
  );
}
