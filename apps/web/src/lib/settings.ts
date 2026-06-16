// Cookie-backed global settings: persistent defaults that seed each page. A
// value resolves as URL param > cookie default > hardcoded default. Read in
// Server Components via readSettings(); written only by the saveSettings server
// action (Next.js forbids setting a cookie during a render).

import type { FeedSort, FeedView } from "@localfinds/db";
import { cookies } from "next/headers";
import { DEFAULT_PAGE_SIZE, type PageSize, parsePageSize } from "./pagination";
import { first } from "./url";

export type FeedDensity = "full" | "compact";

export interface FeedSettings {
  view: FeedView;
  // A persisted default window (days over discoveredAt) OR an event-date range
  // (from/to over eventStart). The range wins when both are present.
  days?: number;
  from?: string;
  to?: string;
  pageSize: PageSize;
  density: FeedDensity;
  sort: FeedSort;
}

export interface Settings {
  feed: FeedSettings;
}

export const SETTINGS_COOKIE = "lf_settings";

export const SETTINGS_COOKIE_OPTIONS = {
  path: "/",
  maxAge: 60 * 60 * 24 * 365,
  sameSite: "lax" as const,
};

export const DEFAULT_SETTINGS: Settings = {
  feed: {
    view: "default",
    pageSize: DEFAULT_PAGE_SIZE,
    density: "full",
    sort: "newest",
  },
};

// ---- Validators: never trust the cookie or form input. Each returns the valid
// value or undefined so callers fall back to the next source in precedence. ----

const VIEWS: FeedView[] = ["default", "starred", "hidden", "all"];
const DENSITIES: FeedDensity[] = ["full", "compact"];
const SORTS: FeedSort[] = ["newest", "oldest", "soonest"];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function validView(v: unknown): FeedView | undefined {
  return typeof v === "string" && VIEWS.includes(v as FeedView)
    ? (v as FeedView)
    : undefined;
}
export function validDensity(v: unknown): FeedDensity | undefined {
  return typeof v === "string" && DENSITIES.includes(v as FeedDensity)
    ? (v as FeedDensity)
    : undefined;
}
export function validSort(v: unknown): FeedSort | undefined {
  return typeof v === "string" && SORTS.includes(v as FeedSort)
    ? (v as FeedSort)
    : undefined;
}
export function validDate(v: unknown): string | undefined {
  return typeof v === "string" && DATE_RE.test(v) ? v : undefined;
}
export function validDays(v: unknown): number | undefined {
  const n = typeof v === "number" ? v : Number(v);
  return n === 1 || n === 7 || n === 30 ? n : undefined;
}
export function validPageSize(v: unknown): PageSize | undefined {
  if (v === "all") return "all";
  if (v === 25 || v === 50 || v === 100) return v;
  if (typeof v === "string") {
    const n = Number(v);
    if (n === 25 || n === 50 || n === 100) return n as PageSize;
  }
  return undefined;
}

function mergeFeed(base: FeedSettings, raw: unknown): FeedSettings {
  const r = (raw ?? {}) as Record<string, unknown>;
  return {
    view: validView(r.view) ?? base.view,
    days: validDays(r.days) ?? base.days,
    from: validDate(r.from) ?? base.from,
    to: validDate(r.to) ?? base.to,
    pageSize: validPageSize(r.pageSize) ?? base.pageSize,
    density: validDensity(r.density) ?? base.density,
    sort: validSort(r.sort) ?? base.sort,
  };
}

// Deep-merge a (possibly partial/old/tampered) parsed cookie onto the defaults,
// validating every field, so the result is always a complete, safe Settings.
export function mergeSettings(base: Settings, raw: unknown): Settings {
  const r = (raw ?? {}) as Record<string, unknown>;
  return { feed: mergeFeed(base.feed, r.feed) };
}

export function serializeSettings(settings: Settings): string {
  return encodeURIComponent(JSON.stringify(settings));
}

export async function readSettings(): Promise<Settings> {
  const raw = (await cookies()).get(SETTINGS_COOKIE)?.value;
  if (!raw) return DEFAULT_SETTINGS;
  try {
    return mergeSettings(DEFAULT_SETTINGS, JSON.parse(decodeURIComponent(raw)));
  } catch {
    return DEFAULT_SETTINGS;
  }
}

// ---- Resolution: merge URL params over the cookie defaults for one render. ----

export interface ResolvedFeed {
  view: FeedView;
  days?: number;
  from?: string;
  to?: string;
  tag?: string;
  pageSize: PageSize;
  density: FeedDensity;
  sort: FeedSort;
  page: number;
}

type SearchParams = Record<string, string | string[] | undefined>;

export function resolveFeed(sp: SearchParams, settings: Settings): ResolvedFeed {
  const f = settings.feed;
  const urlFrom = validDate(first(sp.from));
  const urlTo = validDate(first(sp.to));
  const urlDaysRaw = first(sp.days);
  const urlNoDate = urlDaysRaw === "any"; // explicit "no date" sentinel
  const urlDays = validDays(urlDaysRaw);
  const urlSize = first(sp.size);

  // Date precedence: URL range > URL days > URL "any" (explicit none) >
  // cookie range > cookie days > none.
  let days: number | undefined;
  let from: string | undefined;
  let to: string | undefined;
  if (urlFrom || urlTo) {
    from = urlFrom;
    to = urlTo;
  } else if (urlDays) {
    days = urlDays;
  } else if (urlNoDate) {
    // leave all undefined — explicitly overrides any persisted date default
  } else if (f.from || f.to) {
    from = f.from;
    to = f.to;
  } else {
    days = f.days;
  }

  return {
    view: validView(first(sp.view)) ?? f.view,
    days,
    from,
    to,
    // Tags stay ad-hoc (URL only) — never persisted as a default.
    tag: first(sp.tag) || undefined,
    pageSize: urlSize ? parsePageSize(urlSize) : f.pageSize,
    density: validDensity(first(sp.density)) ?? f.density,
    sort: validSort(first(sp.sort)) ?? f.sort,
    // Page is always ad-hoc; the pager re-adds it, every other link drops it.
    page: Math.max(1, Number(first(sp.page)) || 1),
  };
}
