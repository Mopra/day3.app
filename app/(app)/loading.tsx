import { Skeleton } from "@/components/ui/skeleton";

/**
 * Navigation placeholder for every page in the app shell.
 *
 * The pages read their data on the server, which means the RSC response for a
 * navigation only arrives once the queries have. Without a loading boundary the
 * router has nothing to show in the meantime and leaves the PREVIOUS page on
 * screen — the click appears to do nothing, which reads as slower than it is even
 * when the response is quick.
 *
 * This also gives `<Link>` prefetch something to work with: a dynamic route has no
 * prefetchable payload of its own, but Next can prefetch the loading boundary, so
 * the shell swaps in immediately on click.
 *
 * Deliberately generic — a title bar and a slab. It is on screen for a few hundred
 * milliseconds, so it should suggest the shape of what's coming without pretending
 * to be any particular page (a skeleton that guesses wrong is worse than one that
 * doesn't guess).
 */
export default function AppLoading() {
  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <Skeleton className="h-9 w-48" />
        <Skeleton className="h-9 w-32" />
      </div>
      <Skeleton className="h-64 w-full rounded-xl" />
    </div>
  );
}
