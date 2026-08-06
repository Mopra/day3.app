// Branded 404 shown for unmatched routes and explicit notFound() calls. Renders
// inside the root layout, so the theme + fonts apply.
import Image from "next/image";
import Link from "next/link";
import { Button } from "@/components/ui/button";

export default function NotFound() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center px-4">
      <div className="max-w-md space-y-6 text-center">
        <Image
          src="/day3-lockup-light.svg"
          alt="Day3"
          width={160}
          height={41}
          className="mx-auto opacity-90"
          priority
        />
        <div className="space-y-2">
          <p className="text-sm font-medium text-muted-foreground">404</p>
          <h1 className="font-display text-3xl">Page not found</h1>
          <p className="text-muted-foreground">
            The page you&apos;re looking for doesn&apos;t exist or may have moved.
          </p>
        </div>
        <div className="flex justify-center gap-3">
          <Link href="/dashboard">
            <Button>Back to dashboard</Button>
          </Link>
          <Link href="/">
            <Button variant="outline">Go home</Button>
          </Link>
        </div>
      </div>
    </main>
  );
}
