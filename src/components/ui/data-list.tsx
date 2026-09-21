"use client";

/**
 * Shared list primitives — the single source of truth for how every list in the
 * app looks and behaves. Each list page is expected to use these so the product
 * has one consistent set of principles:
 *
 *   • A toolbar (search + filters + count) sits ABOVE the list.
 *   • Rows that lead somewhere are click-to-navigate AND carry a visible "Open"
 *     button — a clickable name alone is never enough.
 *   • Empty, no-match, and loading states are consistent everywhere.
 *   • Columns are sortable from the header.
 *
 * Destructive actions follow one app-wide convention so the product never offers
 * two ways to do the same thing:
 *   • The verb is always "Delete" (never "Remove"), on the menu item, the
 *     confirm button ("Delete <noun>"), and the success toast ("<Noun> deleted").
 *   • The trigger lives in a <RowActions/> kebab — in list rows AND in detail-page
 *     headers — never as a bare inline icon or a text button.
 *   • Confirmation always goes through <ConfirmDialog/> (never window.confirm or a
 *     hand-rolled <Dialog/>).
 * "Unsubscribe" is a separate, non-destructive action and keeps its own verb.
 */

import * as React from "react";
import Link from "next/link";
import type { LucideIcon } from "lucide-react";
import { AlertTriangle, ArrowDown, ArrowUp, ChevronRight, ChevronsUpDown, MoreHorizontal, RefreshCw, Search, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Menu, MenuContent, MenuTrigger } from "@/components/ui/menu";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { TableHead } from "@/components/ui/table";
import { cn } from "@/lib/utils";

/* ────────────────────────────── helpers ────────────────────────────── */

export function pluralize(n: number, one: string, many = `${one}s`): string {
  return n === 1 ? one : many;
}

/* ────────────────────────────── toolbar ────────────────────────────── */

/**
 * The filter/options row that sits directly above a list. Stacks on mobile,
 * lays out in a row on desktop. Put search + filter controls inside; a trailing
 * element with `className="ml-auto"` (e.g. <ListCount/>) aligns to the right.
 */
export function ListToolbar({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-col gap-2 sm:flex-row sm:items-center", className)}>
      {children}
    </div>
  );
}

/** Debounce-free controlled search box with a leading icon and a clear button. */
export function ListSearch({
  value,
  onChange,
  placeholder = "Search…",
  className,
  autoFocus,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  className?: string;
  autoFocus?: boolean;
}) {
  return (
    <div className={cn("relative w-full sm:max-w-xs", className)}>
      <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
      <Input
        type="search"
        value={value}
        autoFocus={autoFocus}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="px-8 [&::-webkit-search-cancel-button]:hidden"
      />
      {value && (
        <button
          type="button"
          aria-label="Clear search"
          onClick={() => onChange("")}
          className="absolute top-1/2 right-2 -translate-y-1/2 rounded text-muted-foreground transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
        >
          <X className="size-4" />
        </button>
      )}
    </div>
  );
}

export type FilterOption = { value: string; label: string };

/** A compact filter dropdown for the toolbar (status, plan, risk, …). */
export function ListFilter({
  value,
  onChange,
  options,
  placeholder,
  ariaLabel,
  className,
}: {
  value: string;
  onChange: (value: string) => void;
  options: FilterOption[];
  placeholder?: string;
  ariaLabel?: string;
  className?: string;
}) {
  return (
    <Select
      items={options}
      value={value}
      onValueChange={(v) => onChange((v as string) ?? "")}
    >
      <SelectTrigger aria-label={ariaLabel} className={cn("w-full sm:w-44", className)}>
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent>
        {options.map((o) => (
          <SelectItem key={o.value} value={o.value}>
            {o.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * Builds the options for a <ListFilter/> from the values actually present in the
 * data, with an "all" option in front.
 *
 * `active` is kept in the list even when no row currently carries it. A filter
 * that survives a page visit (see `ListPersistence`) can outlive the rows that
 * justified it — "paused" is a real choice today and an absent value tomorrow —
 * and dropping it would leave a select showing a blank label over an empty
 * table, with nothing on screen explaining why.
 */
export function buildFilterOptions({
  all,
  values,
  active,
  label = capitalize,
}: {
  /** Label for the leading "no filter" option, whose value is always "all". */
  all: string;
  values: Iterable<string>;
  active: string;
  label?: (value: string) => string;
}): FilterOption[] {
  const present = new Set(values);
  if (active && active !== "all") present.add(active);
  return [
    { value: "all", label: all },
    ...Array.from(present)
      .sort()
      .map((v) => ({ value: v, label: label(v) })),
  ];
}

/**
 * Clears a list's search and filters. Rendered only while something is actually
 * narrowing the list — which is the point: a filter restored from a previous
 * visit has to announce itself, or a short list reads as missing data.
 */
export function ListClear({
  show,
  onClear,
  className,
}: {
  show: boolean;
  onClear: () => void;
  className?: string;
}) {
  if (!show) return null;
  return (
    <Button
      variant="ghost"
      size="sm"
      onClick={onClear}
      className={cn("text-muted-foreground", className)}
    >
      <X className="size-4" />
      Clear
    </Button>
  );
}

export type ChipOption = { value: string; label: string; count: number; tone?: "default" | "alert" };

/**
 * A row of count chips that double as the filter. Use instead of <ListFilter/>
 * when the counts themselves are information the reader came for ("is anyone
 * stuck?"): a dropdown hides them behind a click, and the number is half the
 * answer. `tone: "alert"` marks the chip that means something needs attention,
 * so it reads as a warning when it is non-zero and as an ordinary chip at zero.
 * A chip with no rows behind it still renders: "0 held" is a useful answer.
 */
export function ListChips({
  value,
  onChange,
  options,
  ariaLabel,
  className,
}: {
  value: string;
  onChange: (value: string) => void;
  options: ChipOption[];
  ariaLabel?: string;
  className?: string;
}) {
  return (
    <div role="group" aria-label={ariaLabel} className={cn("flex flex-wrap items-center gap-1.5", className)}>
      {options.map((o) => {
        const selected = o.value === value;
        const alert = o.tone === "alert" && o.count > 0;
        return (
          <button
            key={o.value}
            type="button"
            aria-pressed={selected}
            onClick={() => onChange(selected ? "" : o.value)}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition-colors focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none",
              selected
                ? "border-transparent bg-secondary text-secondary-foreground"
                : "border-border text-muted-foreground hover:bg-muted hover:text-foreground",
              alert && !selected && "border-caramel/40 text-caramel hover:text-caramel",
            )}
          >
            {o.label}
            <span className={cn("tabular-nums", selected ? "" : "text-foreground/70")}>
              {o.count.toLocaleString()}
            </span>
          </button>
        );
      })}
    </div>
  );
}

/** "12 campaigns" or "12 of 40 campaigns" when a filter is narrowing the list. */
export function ListCount({
  shown,
  total,
  noun,
  many,
  className,
}: {
  shown: number;
  total: number;
  noun: string;
  // For nouns English does not pluralize with an "s" ("person" → "people").
  many?: string;
  className?: string;
}) {
  const label =
    shown === total
      ? `${total.toLocaleString()} ${pluralize(total, noun, many)}`
      : `${shown.toLocaleString()} of ${total.toLocaleString()} ${pluralize(total, noun, many)}`;
  return (
    <span className={cn("text-sm text-muted-foreground tabular-nums", className)}>{label}</span>
  );
}

/* ──────────────────────────── sortable head ─────────────────────────── */

export type SortDir = "asc" | "desc";
export type SortState = { key: string; dir: SortDir } | null;

/** A sortable column header. Clicking cycles asc → desc; the arrow shows state. */
export function SortableHead({
  label,
  sortKey,
  sort,
  onSort,
  align = "left",
  className,
}: {
  label: React.ReactNode;
  sortKey: string;
  sort: SortState;
  onSort: (key: string) => void;
  align?: "left" | "right";
  className?: string;
}) {
  const active = sort?.key === sortKey;
  const Icon = !active ? ChevronsUpDown : sort.dir === "asc" ? ArrowUp : ArrowDown;
  return (
    <TableHead className={cn(align === "right" && "text-right", className)}>
      <button
        type="button"
        onClick={() => onSort(sortKey)}
        className={cn(
          "group/sort -mx-1 inline-flex items-center gap-1 rounded px-1 py-0.5 font-medium transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none",
          align === "right" && "flex-row-reverse",
          active ? "text-foreground" : "text-muted-foreground",
        )}
      >
        {label}
        <Icon
          className={cn(
            "size-3.5 transition-opacity",
            active ? "opacity-100" : "opacity-40 group-hover/sort:opacity-70",
          )}
        />
      </button>
    </TableHead>
  );
}

/* ─────────────────────────── navigable rows ─────────────────────────── */

/**
 * Spread onto a <TableRow> to make the whole row click-to-navigate. Pair it with
 * a <RowOpen/> in the final cell so keyboard and assistive-tech users get a real,
 * focusable control (the row click is a mouse convenience on top of that).
 */
export function rowLinkProps(onNavigate: () => void) {
  return {
    onClick: onNavigate,
    className: "group cursor-pointer",
  } as const;
}

/**
 * The visible "Open" affordance every navigable row must carry. Renders as a real
 * link so it's focusable, right-clickable, and openable in a new tab; stops row
 * propagation so we navigate exactly once.
 */
export function RowOpen({
  href,
  label = "Open",
  className,
}: {
  href: string;
  label?: string;
  className?: string;
}) {
  return (
    <Button
      variant="ghost"
      size="sm"
      className={cn("text-muted-foreground", className)}
      render={<Link href={href} onClick={(e) => e.stopPropagation()} />}
    >
      {label}
      <ChevronRight className="size-4 transition-transform group-hover:translate-x-0.5" />
    </Button>
  );
}

/**
 * The kebab "⋯" menu every navigable row carries for secondary actions
 * (duplicate, delete, …). Keeps destructive or rare actions out of the row's
 * immediate reach — they live one click in, behind a dropdown, so the row stays
 * calm and an accidental delete isn't sitting right next to "Open".
 *
 * Pass <MenuItem>s (from "@/components/ui/menu") as children. Stops row
 * propagation so opening the menu never triggers the row's click-to-navigate.
 */
export function RowActions({
  children,
  label = "More actions",
  className,
}: {
  children: React.ReactNode;
  label?: string;
  className?: string;
}) {
  return (
    <Menu>
      <MenuTrigger
        render={
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={label}
            title={label}
            className={cn("text-muted-foreground", className)}
            onClick={(e) => e.stopPropagation()}
          />
        }
      >
        <MoreHorizontal className="size-4" />
      </MenuTrigger>
      {/* MenuContent portals to <body>, but React synthetic events bubble along
          the React tree — where this menu is still a child of the navigable row.
          Without this, a menu-item click (Delete, …) also fires the row's
          click-to-navigate and we'd navigate instead of running the action. */}
      <MenuContent onClick={(e) => e.stopPropagation()}>{children}</MenuContent>
    </Menu>
  );
}

/* ──────────────────────── empty / loading states ────────────────────── */

/**
 * The "you have nothing yet" state — icon, headline, helper copy, and a CTA.
 *
 * An empty screen is an invitation, so the headline is set in the display serif
 * and written as a short sentence naming what this surface is for ("Your first
 * audience starts here.") rather than reporting a count of zero ("No
 * audiences"). Nothing has gone wrong on this screen; it should read like the
 * start of something. Contrast `ListNoResults` below, which is a correction and
 * stays deliberately plain.
 */
export function ListEmpty({
  icon: Icon,
  title,
  description,
  action,
  className,
}: {
  icon?: LucideIcon;
  title: string;
  description?: React.ReactNode;
  action?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-col items-center px-6 py-12 text-center", className)}>
      {Icon && (
        <div className="flex size-11 items-center justify-center rounded-full bg-muted">
          <Icon className="size-5 text-muted-foreground" />
        </div>
      )}
      <p className="mt-4 font-display text-xl">{title}</p>
      {description && (
        <p className="mt-1.5 max-w-sm text-sm leading-relaxed text-muted-foreground">
          {description}
        </p>
      )}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

/** Shown when filters/search hide every row (distinct from a truly empty list). */
export function ListNoResults({
  onClear,
  message = "No results match your filters.",
}: {
  onClear: () => void;
  message?: string;
}) {
  return (
    <div className="flex flex-col items-center px-6 py-12 text-center">
      <p className="text-sm text-muted-foreground">{message}</p>
      <Button variant="outline" size="sm" className="mt-3" onClick={onClear}>
        Clear filters
      </Button>
    </div>
  );
}

/**
 * Shown when the list's initial fetch fails. Without this a `.catch` that only
 * toasts leaves the page on its loading skeleton forever — one transient hiccup
 * becomes a dead screen. Gives the user a clear reason and a Retry that re-runs
 * the page's loader.
 */
export function ListError({
  onRetry,
  message = "We couldn't load this. Check your connection and try again.",
  title = "Couldn't load",
}: {
  onRetry: () => void;
  message?: string;
  title?: string;
}) {
  return (
    <div className="flex flex-col items-center px-6 py-12 text-center">
      <div className="flex size-11 items-center justify-center rounded-full bg-destructive/10">
        <AlertTriangle className="size-5 text-destructive" />
      </div>
      <p className="mt-3 font-medium">{title}</p>
      <p className="mt-1 max-w-sm text-sm text-muted-foreground">{message}</p>
      <Button variant="outline" size="sm" className="mt-4" onClick={onRetry}>
        <RefreshCw className="size-4" />
        Try again
      </Button>
    </div>
  );
}

/** Consistent skeleton placeholder while a list loads. */
export function ListSkeleton({ rows = 5 }: { rows?: number }) {
  return (
    <div className="space-y-2.5 py-1" aria-hidden>
      {Array.from({ length: rows }).map((_, i) => (
        <Skeleton key={i} className="h-9 w-full" />
      ))}
    </div>
  );
}

/* ───────────────────────────── controller ───────────────────────────── */

type Primitive = string | number | boolean | null | undefined;

function compare(a: Primitive, b: Primitive): number {
  if (a == null && b == null) return 0;
  if (a == null) return -1;
  if (b == null) return 1;
  if (typeof a === "number" && typeof b === "number") return a - b;
  if (typeof a === "boolean" && typeof b === "boolean") return a === b ? 0 : a ? 1 : -1;
  return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: "base" });
}

/* ──────────────────────── state that outlives a visit ───────────────── */

/**
 * Makes a list's search, filters, and sort survive leaving the page.
 *
 * Without it, narrowing a list is worth exactly one screen: open a row, come
 * back, and the filter is gone — so anyone working through a filtered list
 * re-applies it on every return trip.
 *
 * State lives in TWO places, deliberately:
 *   • the URL, so the view is linkable and Back restores exactly what you left;
 *   • storage, so arriving at the bare path (a nav click, a fresh tab) still
 *     lands you where you were.
 * The URL wins whenever it carries state; storage fills in when it doesn't.
 *
 * Only what differs from the page's defaults is written, so a cleared list
 * leaves a clean URL and no stored entry — "no filters" is never something you
 * have to restore.
 */
export type ListPersistence = {
  /** Stable id for this list. Scopes the stored entry; keep it unique app-wide. */
  key: string;
  /** Prefix for this list's URL params. Only needed when one page has two lists. */
  param?: string;
  /** "session" forgets at tab close; "local" (the default) outlives it. */
  scope?: "local" | "session";
};

type ListState = {
  q: string;
  filters: Record<string, string>;
  sort: SortState;
};

const STORE_PREFIX = "day3.list.";
const NO_FILTERS: Record<string, string> = {};

function sameSort(a: SortState, b: SortState): boolean {
  return a?.key === b?.key && a?.dir === b?.dir;
}

function paramName(p: ListPersistence, name: string): string {
  return p.param ? `${p.param}_${name}` : name;
}

function storageFor(p: ListPersistence): Storage | null {
  // Access itself throws when a browser blocks site data; a list must still work.
  try {
    return p.scope === "session" ? window.sessionStorage : window.localStorage;
  } catch {
    return null;
  }
}

function parseSort(raw: string | null): SortState | undefined {
  if (!raw) return undefined;
  const [key, dir] = raw.split(":");
  if (!key || (dir !== "asc" && dir !== "desc")) return undefined;
  return { key, dir };
}

function readUrlState(p: ListPersistence, names: string[]): Partial<ListState> | null {
  const sp = new URLSearchParams(window.location.search);
  const out: Partial<ListState> = {};
  let found = false;

  const q = sp.get(paramName(p, "q"));
  if (q !== null) {
    out.q = q;
    found = true;
  }
  const filters: Record<string, string> = {};
  for (const name of names) {
    const value = sp.get(paramName(p, name));
    if (value !== null) filters[name] = value;
  }
  if (Object.keys(filters).length > 0) {
    out.filters = filters;
    found = true;
  }
  const sort = parseSort(sp.get(paramName(p, "sort")));
  if (sort) {
    out.sort = sort;
    found = true;
  }
  return found ? out : null;
}

function readStoredState(p: ListPersistence): Partial<ListState> | null {
  const store = storageFor(p);
  if (!store) return null;
  try {
    const raw = store.getItem(STORE_PREFIX + p.key);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as Partial<ListState>) : null;
  } catch {
    return null;
  }
}

function writeState(
  p: ListPersistence,
  state: ListState,
  defaults: Record<string, string>,
  initialSort: SortState,
): void {
  const dirty: Partial<ListState> = {};
  if (state.q) dirty.q = state.q;
  const filters: Record<string, string> = {};
  for (const name of Object.keys(defaults)) {
    if (state.filters[name] !== defaults[name]) filters[name] = state.filters[name];
  }
  if (Object.keys(filters).length > 0) dirty.filters = filters;
  if (state.sort && !sameSort(state.sort, initialSort)) dirty.sort = state.sort;

  const store = storageFor(p);
  if (store) {
    try {
      if (Object.keys(dirty).length > 0) {
        store.setItem(STORE_PREFIX + p.key, JSON.stringify(dirty));
      } else {
        store.removeItem(STORE_PREFIX + p.key);
      }
    } catch {
      // Quota or blocked storage. The URL still carries the state.
    }
  }

  const sp = new URLSearchParams(window.location.search);
  const put = (name: string, value: string | undefined) => {
    if (value) sp.set(paramName(p, name), value);
    else sp.delete(paramName(p, name));
  };
  put("q", dirty.q);
  for (const name of Object.keys(defaults)) put(name, dirty.filters?.[name]);
  put("sort", dirty.sort ? `${dirty.sort.key}:${dirty.sort.dir}` : undefined);

  const query = sp.toString();
  const next = `${window.location.pathname}${query ? `?${query}` : ""}${window.location.hash}`;
  const current = `${window.location.pathname}${window.location.search}${window.location.hash}`;
  if (next === current) return;
  // replaceState, not router.replace: this is view state, not a navigation. It
  // must not push a history entry (Back would then walk keystrokes) and must not
  // re-run the server component on every character typed into the search box.
  window.history.replaceState(window.history.state, "", next);
}

/**
 * A stable string for one list state, used to tell "the user changed something"
 * from "this is what we just restored". Without it the mount pass writes the
 * still-default state back out before the restored one lands, and momentarily
 * erases the very entry it read.
 */
function signature(state: ListState, defaults: Record<string, string>): string {
  return JSON.stringify([
    state.q,
    Object.keys(defaults).map((name) => state.filters[name]),
    state.sort?.key ?? "",
    state.sort?.dir ?? "",
  ]);
}

// The restore has to land before the browser paints, or a persisted filter shows
// up as a visible flash of the unfiltered list.
const useIsoLayoutEffect = typeof window === "undefined" ? React.useEffect : React.useLayoutEffect;

/* ────────────────────────────── the hook ────────────────────────────── */

type ListControllerConfig<T> = {
  /** Text matched against the search box (compared case-insensitively). */
  searchText?: (item: T) => string;
  /**
   * The list's filter selects, as `name → default value`. Declaring them here
   * rather than as the page's own `useState` is what lets the controller reset
   * and persist them alongside the search box and the sort.
   */
  filters?: Record<string, string>;
  /** Extra filtering, driven by the current `filters` values. */
  predicate?: (item: T, filters: Record<string, string>) => boolean;
  /** Accessors for each sortable column key. */
  sortAccessors?: Record<string, (item: T) => Primitive>;
  initialSort?: SortState;
  /** Opt in to search/filter/sort surviving the visit. See `ListPersistence`. */
  persist?: ListPersistence;
};

type ListController<T, View extends T[] | null> = {
  search: string;
  setSearch: React.Dispatch<React.SetStateAction<string>>;
  /** Current value of each declared filter. */
  filters: Record<string, string>;
  setFilter: (name: string, value: string) => void;
  sort: SortState;
  setSort: React.Dispatch<React.SetStateAction<SortState>>;
  toggleSort: (key: string) => void;
  /** Search or a filter is away from its default — i.e. rows are being hidden. */
  isFiltered: boolean;
  /** Resets search and filters to their defaults. Sort is a view, not a filter. */
  clearFilters: () => void;
  /** Filtered + sorted rows (null only when the source is still loading). */
  view: View;
  total: number;
  shown: number;
  /** Source resolved and genuinely has no rows. */
  isEmpty: boolean;
  /** Source has rows, but the current search/filters hide them all. */
  isFilteredEmpty: boolean;
};

/**
 * Client-side search + filter + sort for in-memory lists (the small datasets the
 * app loads whole). Server-paginated lists (subscribers, recipients) manage their
 * own query and don't use this.
 *
 * `null` items mean "still loading" and make `view` null too — the state a page
 * that fetches on mount starts in. Pages whose rows are server-rendered pass a real
 * array and get a non-null `view` back, so they don't carry a skeleton branch that
 * can never render.
 */
export function useListController<T>(
  items: T[],
  config?: ListControllerConfig<T>,
): ListController<T, T[]>;
export function useListController<T>(
  items: T[] | null,
  config?: ListControllerConfig<T>,
): ListController<T, T[] | null>;
export function useListController<T>(
  items: T[] | null,
  config: ListControllerConfig<T> = {},
) {
  // Callers pass fresh object literals every render. Pin the ones that are
  // configuration rather than state (a lazy useState, so they keep their first
  // value), and effects and resets stop chasing a new identity every pass.
  const [defaults] = React.useState(() => config.filters ?? NO_FILTERS);
  const [initialSort] = React.useState<SortState>(() => config.initialSort ?? null);
  const [persist] = React.useState(() => config.persist);

  const [search, setSearch] = React.useState("");
  const [filters, setFilters] = React.useState<Record<string, string>>(defaults);
  const [sort, setSort] = React.useState<SortState>(initialSort);

  // Restoring in an effect rather than in the initial state is deliberate: these
  // pages are server-rendered too, and reading window during render would make
  // the first client render disagree with the server's HTML.
  const written = React.useRef<string | null>(null);
  useIsoLayoutEffect(() => {
    if (!persist || written.current !== null) return;
    const fromUrl = readUrlState(persist, Object.keys(defaults));
    const saved = fromUrl ?? readStoredState(persist);
    // Only the filters this list declares are taken back out of a stored entry —
    // an older build's leftover names must not leak into the current state.
    const restoredFilters: Record<string, string> = { ...defaults };
    for (const name of Object.keys(defaults)) {
      const value = saved?.filters?.[name];
      if (typeof value === "string") restoredFilters[name] = value;
    }
    const next: ListState = {
      q: typeof saved?.q === "string" ? saved.q : "",
      filters: restoredFilters,
      sort: saved?.sort ?? initialSort,
    };
    written.current = signature(next, defaults);
    if (!saved) return;
    setSearch(next.q);
    setFilters(next.filters);
    setSort(next.sort);
    // Restored from storage, so the URL doesn't show this view yet. Write it here
    // with the state in hand rather than waiting for the sync effect below, which
    // would first see the render that is still holding the defaults.
    if (!fromUrl) writeState(persist, next, defaults, initialSort);
  }, [persist, defaults, initialSort]);

  React.useEffect(() => {
    if (!persist) return;
    const state: ListState = { q: search, filters, sort };
    const sig = signature(state, defaults);
    if (sig === written.current) return;
    written.current = sig;
    writeState(persist, state, defaults, initialSort);
  }, [persist, defaults, initialSort, search, filters, sort]);

  const setFilter = React.useCallback((name: string, value: string) => {
    setFilters((cur) => ({ ...cur, [name]: value }));
  }, []);

  const clearFilters = React.useCallback(() => {
    setSearch("");
    setFilters(defaults);
  }, [defaults]);

  const toggleSort = React.useCallback((key: string) => {
    setSort((cur) =>
      cur?.key === key ? { key, dir: cur.dir === "asc" ? "desc" : "asc" } : { key, dir: "asc" },
    );
  }, []);

  const { searchText, predicate, sortAccessors } = config;

  const view = React.useMemo(() => {
    if (!items) return null;
    const q = search.trim().toLowerCase();
    let out = items;
    if (predicate) out = out.filter((it) => predicate(it, filters));
    if (q && searchText) out = out.filter((it) => searchText(it).toLowerCase().includes(q));
    if (sort && sortAccessors?.[sort.key]) {
      const acc = sortAccessors[sort.key];
      out = [...out].sort((a, b) => compare(acc(a), acc(b)) * (sort.dir === "asc" ? 1 : -1));
    }
    return out;
    // predicate/searchText are inline closures (recomputed each render) — fine for
    // the small lists this powers, and keeps filter state always fresh.
  }, [items, search, filters, predicate, searchText, sort, sortAccessors]);

  const total = items?.length ?? 0;
  const shown = view?.length ?? 0;
  const isFiltered =
    search.trim() !== "" ||
    Object.keys(defaults).some((name) => filters[name] !== defaults[name]);

  return {
    search,
    setSearch,
    filters,
    setFilter,
    sort,
    setSort,
    toggleSort,
    isFiltered,
    clearFilters,
    /** Filtered + sorted rows (null while the source is still loading). */
    view,
    total,
    shown,
    /** Source resolved and genuinely has no rows. */
    isEmpty: items !== null && items.length === 0,
    /** Source has rows, but the current search/filters hide them all. */
    isFilteredEmpty: view !== null && view.length === 0 && total > 0,
  };
}
