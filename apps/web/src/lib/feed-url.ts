// Builds /feed URLs that encode only what differs from the persisted cookie
// defaults. Omitting a param means "use the cookie default" (that's how
// resolveFeed reads it), so a value equal to the cookie default is dropped and
// any other value — including a hardcoded default that differs from the cookie —
// is emitted explicitly. Without this, picking e.g. size 50 while the cookie
// default is 25 would drop `size` and silently revert to 25.
//
// `days=any` is the sentinel for "explicitly no date filter", needed so "Any
// time" can override a persisted date default (absence alone can't say that).

import type { FeedDensity } from "./settings";
import type { FeedSort, FeedView } from "@localfinds/db";
import type { PageSize } from "./pagination";

export interface FeedState {
  view: FeedView;
  days?: number;
  from?: string;
  to?: string;
  tag?: string;
  pageSize: PageSize;
  density: FeedDensity;
  sort: FeedSort;
}

// The omission baseline — the persisted cookie defaults (FeedSettings is
// assignable to this; tag is never persisted so it isn't part of it).
export interface FeedDefaults {
  view: FeedView;
  days?: number;
  from?: string;
  to?: string;
  pageSize: PageSize;
  density: FeedDensity;
  sort: FeedSort;
}

export function feedHref(
  target: FeedState,
  defaults: FeedDefaults,
  page?: number,
): string {
  const qs = new URLSearchParams();
  if (target.view !== defaults.view) qs.set("view", target.view);
  if (target.sort !== defaults.sort) qs.set("sort", target.sort);
  if (target.density !== defaults.density) qs.set("density", target.density);
  if (target.pageSize !== defaults.pageSize)
    qs.set("size", String(target.pageSize));

  if (target.from || target.to) {
    if (target.from !== defaults.from || target.to !== defaults.to) {
      if (target.from) qs.set("from", target.from);
      if (target.to) qs.set("to", target.to);
    }
  } else if (target.days) {
    if (target.days !== defaults.days) qs.set("days", String(target.days));
  } else if (defaults.from || defaults.to || defaults.days) {
    qs.set("days", "any"); // explicit "no date", overriding a persisted default
  }

  if (target.tag) qs.set("tag", target.tag);
  if (page && page > 1) qs.set("page", String(page));

  const s = qs.toString();
  return s ? `/feed?${s}` : "/feed";
}
