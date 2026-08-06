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

/** "12 campaigns" or "12 of 40 campaigns" when a filter is narrowing the list. */
export function ListCount({
  shown,
  total,
  noun,
  className,
}: {
  shown: number;
  total: number;
  noun: string;
  className?: string;
}) {
  const label =
    shown === total
      ? `${total.toLocaleString()} ${pluralize(total, noun)}`
      : `${shown.toLocaleString()} of ${total.toLocaleString()} ${pluralize(total, noun)}`;
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

/**
 * Client-side search + filter + sort for in-memory lists (the small datasets the
 * app loads whole). Server-paginated lists (subscribers, recipients) manage their
 * own query and don't use this.
 */
export function useListController<T>(
  items: T[] | null,
  config: {
    /** Text matched against the search box (compared case-insensitively). */
    searchText?: (item: T) => string;
    /** Extra filtering driven by the page's filter selects. */
    predicate?: (item: T) => boolean;
    /** Accessors for each sortable column key. */
    sortAccessors?: Record<string, (item: T) => Primitive>;
    initialSort?: SortState;
  } = {},
) {
  const [search, setSearch] = React.useState("");
  const [sort, setSort] = React.useState<SortState>(config.initialSort ?? null);

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
    if (predicate) out = out.filter(predicate);
    if (q && searchText) out = out.filter((it) => searchText(it).toLowerCase().includes(q));
    if (sort && sortAccessors?.[sort.key]) {
      const acc = sortAccessors[sort.key];
      out = [...out].sort((a, b) => compare(acc(a), acc(b)) * (sort.dir === "asc" ? 1 : -1));
    }
    return out;
    // predicate/searchText are inline closures (recomputed each render) — fine for
    // the small lists this powers, and keeps filter state always fresh.
  }, [items, search, predicate, searchText, sort, sortAccessors]);

  const total = items?.length ?? 0;
  const shown = view?.length ?? 0;

  return {
    search,
    setSearch,
    sort,
    setSort,
    toggleSort,
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
