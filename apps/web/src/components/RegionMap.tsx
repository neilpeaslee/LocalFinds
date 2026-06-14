"use client";

import "leaflet/dist/leaflet.css";
import type { LatLngBoundsExpression, LatLngTuple } from "leaflet";
import { useEffect, useRef, useState } from "react";
import {
  CircleMarker,
  MapContainer,
  Polygon,
  Rectangle,
  TileLayer,
  Tooltip,
  useMap,
} from "react-leaflet";

export interface TownBoxProp {
  name: string;
  /** [south, west, north, east] = [minLat, minLng, maxLat, maxLng]. */
  bbox: [number, number, number, number];
  primary?: boolean;
}

export interface BusinessPin {
  name: string;
  kind: string | null;
  lat: number;
  lng: number;
  town: string | null;
}

export interface BoundaryFeature {
  type: "Feature";
  properties: { name: string; primary?: boolean; osm?: string };
  geometry: {
    type: "Polygon" | "MultiPolygon";
    // Polygon: ring[]; MultiPolygon: polygon[] of ring[]. Rings are [lng, lat].
    coordinates: number[][][] | number[][][][];
  };
}

export interface RegionMapProps {
  towns: TownBoxProp[];
  boundaries: { features: BoundaryFeature[] };
  businesses: BusinessPin[];
}

type Ring = LatLngTuple[];

// Once the map has fitted the coverage bounds, zoom in one extra level (keeping
// the region centered) so the area fills the frame — a bit spills off the edges.
function ZoomInOne({ active }: { active: boolean }) {
  const map = useMap();
  const done = useRef(false);
  useEffect(() => {
    if (done.current || !active) return;
    done.current = true;
    map.setZoom(map.getZoom() + 1);
  }, [map, active]);
  return null;
}

// Rockland, ME — used only when there's no coverage data at all to frame.
const DEFAULT_CENTER: LatLngTuple = [44.1, -69.11];
const MASK_COLOR = "#1c1917"; // stone-900
const PRIMARY_COLOR = "#b45309"; // amber-700
const TOWN_COLOR = "#44403c"; // stone-700
const PIN_STROKE = "#0369a1"; // sky-700
const PIN_FILL = "#0ea5e9"; // sky-500

// The outer ring(s) of a feature, as Leaflet [lat, lng] tuples. (MultiPolygons
// and inner holes are rare for town boundaries; we keep each part's outer ring.)
function featureOuterRings(f: BoundaryFeature): Ring[] {
  const polys: number[][][][] =
    f.geometry.type === "Polygon"
      ? [f.geometry.coordinates as number[][][]]
      : (f.geometry.coordinates as number[][][][]);
  return polys
    .map((poly) => poly[0])
    .filter(Boolean)
    .map((ring) => ring.map(([lng, lat]) => [lat, lng] as LatLngTuple));
}

// The four corners of a town bbox as a Leaflet ring (for towns with no polygon).
function bboxRing([s, w, n, e]: TownBoxProp["bbox"]): Ring {
  return [
    [s, w],
    [s, e],
    [n, e],
    [n, w],
  ];
}

export default function RegionMap({
  towns,
  boundaries,
  businesses,
}: RegionMapProps) {
  const [showPins, setShowPins] = useState(true);

  const haveBoundary = new Set(boundaries.features.map((f) => f.properties.name));
  // Towns we must draw from their bbox because no real polygon was fetched.
  const fallbackTowns = towns.filter((t) => !haveBoundary.has(t.name));

  // Every coverage ring (real polygons + bbox fallbacks) — the mask's holes and
  // the source for framing the map.
  const coverageRings: Ring[] = [
    ...boundaries.features.flatMap(featureOuterRings),
    ...fallbackTowns.map((t) => bboxRing(t.bbox)),
  ];

  const bounds = computeBounds(coverageRings, businesses);

  // World rectangle with every coverage ring punched out as a hole: fill dims
  // everything outside the covered towns, leaving them "lit".
  const maskPositions: Ring[] = [
    [
      [85, -180],
      [85, 180],
      [-85, 180],
      [-85, -180],
    ],
    ...coverageRings,
  ];

  return (
    <div className="relative h-72 w-full sm:h-96">
      <MapContainer
        bounds={bounds}
        boundsOptions={{ padding: [16, 16] }}
        center={bounds ? undefined : DEFAULT_CENTER}
        zoom={bounds ? undefined : 11}
        scrollWheelZoom={false}
        className="h-full w-full overflow-hidden rounded-lg border border-stone-200"
      >
        <ZoomInOne active={Boolean(bounds)} />
        <TileLayer
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
        />

        {coverageRings.length > 0 && (
          <Polygon
            positions={maskPositions}
            interactive={false}
            pathOptions={{ stroke: false, fillColor: MASK_COLOR, fillOpacity: 0.35 }}
          />
        )}

        {boundaries.features.map((f) =>
          featureOuterRings(f).map((ring, i) => (
            <Polygon
              key={`${f.properties.name}:${i}`}
              positions={ring}
              pathOptions={{
                color: f.properties.primary ? PRIMARY_COLOR : TOWN_COLOR,
                weight: f.properties.primary ? 2.5 : 1.5,
                fill: false,
              }}
            >
              <Tooltip direction="center" opacity={0.9}>
                {f.properties.name}
              </Tooltip>
            </Polygon>
          )),
        )}

        {fallbackTowns.map((t) => {
          const [s, w, n, e] = t.bbox;
          return (
            <Rectangle
              key={t.name}
              bounds={[
                [s, w],
                [n, e],
              ]}
              pathOptions={{
                color: t.primary ? PRIMARY_COLOR : TOWN_COLOR,
                weight: t.primary ? 2.5 : 1.5,
                dashArray: "4 3", // dashed = approximate box, not a real boundary
                fill: false,
              }}
            >
              <Tooltip direction="center" opacity={0.9}>
                {t.name}
              </Tooltip>
            </Rectangle>
          );
        })}

        {showPins &&
          businesses.map((b) => (
            <CircleMarker
              key={`${b.name}:${b.lat}:${b.lng}`}
              center={[b.lat, b.lng]}
              radius={4}
              pathOptions={{
                color: PIN_STROKE,
                fillColor: PIN_FILL,
                fillOpacity: 0.9,
                weight: 1,
              }}
            >
              <Tooltip>
                <span className="font-medium">{b.name}</span>
                {b.kind ? ` · ${b.kind}` : ""}
              </Tooltip>
            </CircleMarker>
          ))}
      </MapContainer>

      <div className="absolute top-3 right-3 z-[1000] rounded-md border border-stone-200 bg-white/95 p-2 text-xs text-stone-700 shadow-sm">
        <div className="mb-1 flex items-center gap-1.5">
          <span
            className="inline-block h-3 w-3 rounded-sm border-2"
            style={{ borderColor: PRIMARY_COLOR }}
          />
          <span>Coverage area</span>
        </div>
        <label className="flex cursor-pointer items-center gap-1.5">
          <input
            type="checkbox"
            checked={showPins}
            onChange={(e) => setShowPins(e.target.checked)}
            className="accent-sky-600"
          />
          <span
            className="inline-block h-3 w-3 rounded-full border"
            style={{ backgroundColor: PIN_FILL, borderColor: PIN_STROKE }}
          />
          <span>Businesses ({businesses.length})</span>
        </label>
      </div>
    </div>
  );
}

// Frame the map on the coverage rings (falling back to business pins).
function computeBounds(
  rings: Ring[],
  businesses: BusinessPin[],
): LatLngBoundsExpression | undefined {
  let south = Infinity;
  let west = Infinity;
  let north = -Infinity;
  let east = -Infinity;

  for (const ring of rings) {
    for (const [lat, lng] of ring) {
      south = Math.min(south, lat);
      west = Math.min(west, lng);
      north = Math.max(north, lat);
      east = Math.max(east, lng);
    }
  }
  if (!rings.length) {
    for (const b of businesses) {
      south = Math.min(south, b.lat);
      west = Math.min(west, b.lng);
      north = Math.max(north, b.lat);
      east = Math.max(east, b.lng);
    }
  }

  if (!Number.isFinite(south)) return undefined;
  return [
    [south, west],
    [north, east],
  ];
}
