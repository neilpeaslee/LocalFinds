// Pure selection logic for the region map: filter all pins down to the ones
// inside the current viewport that pass the active filters. The view layer then
// clusters this set (supercluster) — isolated points render as themed pins,
// groups as coverage count-bubbles — so density is governed by clustering, not a
// fixed budget. No React, no Leaflet — unit-tested in isolation.

import type { MapPin } from "@localfinds/db";

export interface MapFilters {
  /** Theme keys to show (a pin's `theme` must be in here). */
  themes: Set<string>;
  /** Per-theme selected sub-type keys; a theme absent here shows all its sub-types. */
  subtypes: Map<string, Set<string>>;
  /** Every listed tag must be present on the pin (AND). */
  tags: string[];
  /** Tiers to show (a pin's `tier` must be in here). */
  tiers: Set<number>;
  showClosed: boolean;
  showChains: boolean;
  /** Case-insensitive name substring; "" = no name filter. */
  query: string;
}

export interface Viewport {
  south: number;
  west: number;
  north: number;
  east: number;
}

// Zoom -> default visible tiers. Monotonic; reaches all *business* tiers (1–3) at
// high zoom. Tier 4 ("not a business") is never auto-selected (opt-in only).
export function tiersForZoom(zoom: number, available: number[]): Set<number> {
  const tiers =
    zoom <= 9 ? [1] :
    zoom <= 11 ? [1, 2] :
    [1, 2, 3];
  return new Set(tiers.filter((t) => available.includes(t)));
}

// Assumes a non-antimeridian-crossing viewport (west <= east) — true for a single region.
function inBounds(p: MapPin, v: Viewport): boolean {
  return p.lat >= v.south && p.lat <= v.north && p.lng >= v.west && p.lng <= v.east;
}

function passesFilters(p: MapPin, f: MapFilters): boolean {
  if (!f.themes.has(p.theme)) return false;
  const subs = f.subtypes.get(p.theme);
  if (subs && subs.size > 0 && (p.subtypeKey === null || !subs.has(p.subtypeKey))) return false;
  if (!f.tiers.has(p.tier)) return false;
  if (!f.showClosed && p.status === "closed") return false;
  if (!f.showChains && p.isChain) return false;
  if (f.tags.length > 0 && !f.tags.every((t) => p.tags.includes(t))) return false;
  if (f.query && !p.name.toLowerCase().includes(f.query.toLowerCase())) return false;
  return true;
}

// Filtered, in-viewport candidates. The view layer clusters these: an isolated
// point becomes a themed pin, a group becomes a coverage count-bubble.
export function selectVisible(
  pins: MapPin[],
  filters: MapFilters,
  viewport: Viewport,
): MapPin[] {
  return pins.filter((p) => inBounds(p, viewport) && passesFilters(p, filters));
}
