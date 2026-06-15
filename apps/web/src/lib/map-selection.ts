// Pure selection logic for the region map: given all pins + the current viewport
// + active filters, decide which render as individual pins (up to an adaptive,
// highest-tier-first budget) and which fall to coverage clusters. No React, no
// Leaflet — unit-tested in isolation.

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
  widthPx: number;
  heightPx: number;
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

// Adaptive pin budget: ~1 pin per PX_PER_PIN of map area, clamped to [MIN, MAX].
const PX_PER_PIN = 9000;
const MIN_BUDGET = 15;
const MAX_BUDGET = 60;

export function budgetForViewport(widthPx: number, heightPx: number): number {
  const area = Math.max(0, widthPx) * Math.max(0, heightPx);
  return Math.max(MIN_BUDGET, Math.min(MAX_BUDGET, Math.round(area / PX_PER_PIN)));
}

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

export function selectPins(
  pins: MapPin[],
  filters: MapFilters,
  viewport: Viewport,
): { shown: MapPin[]; overflow: MapPin[] } {
  const survivors = pins
    .filter((p) => inBounds(p, viewport) && passesFilters(p, filters))
    .sort((a, z) => a.tier - z.tier || a.name.localeCompare(z.name));
  const budget = budgetForViewport(viewport.widthPx, viewport.heightPx);
  return { shown: survivors.slice(0, budget), overflow: survivors.slice(budget) };
}
