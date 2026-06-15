"use client";

import "leaflet/dist/leaflet.css";
import type { MapPin } from "@localfinds/db";
import type { LatLngBoundsExpression, LatLngTuple } from "leaflet";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  CircleMarker,
  MapContainer,
  Polygon,
  Rectangle,
  TileLayer,
  Tooltip,
  useMap,
  useMapEvents,
} from "react-leaflet";
import Supercluster from "supercluster";
import {
  selectVisible,
  tiersForZoom,
  type MapFilters,
  type Viewport,
} from "@/lib/map-selection";

export interface TownBoxProp {
  name: string;
  bbox: [number, number, number, number];
  primary?: boolean;
}

export interface BoundaryFeature {
  type: "Feature";
  properties: { name: string; primary?: boolean; osm?: string };
  geometry: {
    type: "Polygon" | "MultiPolygon";
    coordinates: number[][][] | number[][][][];
  };
}

export interface MapThemeProp {
  key: string;
  label: string;
  color: string;
}

export interface RegionMapProps {
  towns: TownBoxProp[];
  boundaries: { features: BoundaryFeature[] };
  businesses: MapPin[];
  /** Theme key -> color/label, from readMapCategories (plus "other"). */
  themes: MapThemeProp[];
}

type Ring = LatLngTuple[];
type Vp = Viewport & { zoom: number };

const DEFAULT_CENTER: LatLngTuple = [44.1, -69.11];
const MASK_COLOR = "#1c1917";
const PRIMARY_COLOR = "#b45309";
const TOWN_COLOR = "#44403c";
const CLUSTER_FILL = "#64748b"; // slate-500
const CLUSTER_STROKE = "#475569"; // slate-600

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

function bboxRing([s, w, n, e]: TownBoxProp["bbox"]): Ring {
  return [
    [s, w],
    [s, e],
    [n, e],
    [n, w],
  ];
}

// Once the map has fitted the coverage bounds, zoom in one extra level.
function ZoomInOne({ active }: { active: boolean }) {
  const map = useMap();
  const [done, setDone] = useState(false);
  useEffect(() => {
    if (done || !active) return;
    setDone(true);
    map.setZoom(map.getZoom() + 1);
  }, [map, active, done]);
  return null;
}

// Emits the current viewport (bounds + zoom) on load and after any pan/zoom, so
// the parent can recompute which pins are in view.
function ViewportTracker({ onChange }: { onChange: (v: Vp) => void }) {
  const map = useMap();
  const emit = useCallback(() => {
    const b = map.getBounds();
    onChange({
      south: b.getSouth(),
      west: b.getWest(),
      north: b.getNorth(),
      east: b.getEast(),
      zoom: map.getZoom(),
    });
  }, [map, onChange]);
  useMapEvents({ moveend: emit, zoomend: emit, load: emit });
  useEffect(() => {
    emit();
  }, [emit]);
  return null;
}

export default function RegionMap({ towns, boundaries, businesses, themes }: RegionMapProps) {
  const [vp, setVp] = useState<Vp | null>(null);

  const colorOf = useMemo(() => {
    const m = new Map(themes.map((t) => [t.key, t.color]));
    return (key: string) => m.get(key) ?? CLUSTER_FILL;
  }, [themes]);

  const availableTiers = useMemo(
    () => [...new Set(businesses.map((b) => b.tier))].sort((a, z) => a - z),
    [businesses],
  );

  // Phase 1 default filters: all themes on, tiers driven by zoom, no closed/chains.
  const candidates = useMemo(() => {
    if (!vp) return [] as MapPin[];
    const filters: MapFilters = {
      themes: new Set([...themes.map((t) => t.key), "other"]),
      subtypes: new Map(),
      tags: [],
      tiers: tiersForZoom(vp.zoom, availableTiers),
      showClosed: false,
      showChains: false,
      query: "",
    };
    return selectVisible(businesses, filters, vp);
  }, [vp, businesses, themes, availableTiers]);

  // Cluster the WHOLE candidate set: supercluster merges nearby points, so an
  // isolated point comes back as a singleton (rendered as a themed pin) and any
  // group comes back as one cluster (a count bubble). A pin can't fall under a
  // bubble — it would have merged in — and overlapping groups combine into one.
  const clusters = useMemo(() => {
    if (!vp) return [];
    const index = new Supercluster({ radius: 90, maxZoom: 20 });
    index.load(
      candidates.map((p) => ({
        type: "Feature" as const,
        properties: {
          id: p.id, name: p.name, theme: p.theme, subtype: p.subtype, kind: p.kind,
        },
        geometry: { type: "Point" as const, coordinates: [p.lng, p.lat] },
      })),
    );
    return index.getClusters([vp.west, vp.south, vp.east, vp.north], Math.round(vp.zoom));
  }, [candidates, vp]);

  const { fallbackTowns, coverageRings, bounds, maskPositions } = useMemo(() => {
    const haveBoundary = new Set(boundaries.features.map((f) => f.properties.name));
    const fallback = towns.filter((t) => !haveBoundary.has(t.name));
    const rings: Ring[] = [
      ...boundaries.features.flatMap(featureOuterRings),
      ...fallback.map((t) => bboxRing(t.bbox)),
    ];
    return {
      fallbackTowns: fallback,
      coverageRings: rings,
      bounds: computeBounds(rings, businesses),
      maskPositions: [
        [
          [85, -180],
          [85, 180],
          [-85, 180],
          [-85, -180],
        ] as Ring,
        ...rings,
      ],
    };
  }, [towns, boundaries, businesses]);

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
        <ViewportTracker onChange={setVp} />
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
                dashArray: "4 3",
                fill: false,
              }}
            >
              <Tooltip direction="center" opacity={0.9}>
                {t.name}
              </Tooltip>
            </Rectangle>
          );
        })}

        {clusters.map((c) => {
          const [lng, lat] = c.geometry.coordinates;
          const props = c.properties as {
            cluster?: boolean;
            point_count?: number;
            id?: number;
            name?: string;
            theme?: string;
            subtype?: string | null;
            kind?: string | null;
          };
          // Singleton -> a themed individual pin.
          if (!props.cluster) {
            const color = colorOf(props.theme ?? "other");
            return (
              <CircleMarker
                key={`pin-${props.id}`}
                center={[lat, lng]}
                radius={5}
                pathOptions={{ color, fillColor: color, fillOpacity: 0.9, weight: 1, className: "lf-pin" }}
              >
                <Tooltip>
                  <span className="font-medium">{props.name}</span>
                  {props.subtype ? ` · ${props.subtype}` : props.kind ? ` · ${props.kind}` : ""}
                </Tooltip>
              </CircleMarker>
            );
          }
          // Group -> a gray coverage count-bubble.
          const count = props.point_count ?? 0;
          const radius = Math.min(16, 10 + Math.log2(count + 1) * 1.3);
          return (
            <CircleMarker
              key={`cl-${c.id}`}
              center={[lat, lng]}
              radius={radius}
              pathOptions={{ color: CLUSTER_STROKE, fillColor: CLUSTER_FILL, fillOpacity: 0.55, weight: 2 }}
            >
              <Tooltip direction="center" permanent opacity={1} className="cluster-count">
                {count}
              </Tooltip>
            </CircleMarker>
          );
        })}
      </MapContainer>

      <div className="absolute top-3 right-3 z-[1000] max-w-[10rem] rounded-md border border-stone-200 bg-white/95 p-2 text-xs text-stone-700 shadow-sm">
        <div className="mb-1 flex items-center gap-1.5">
          <span
            className="inline-block h-3 w-3 rounded-sm border-2"
            style={{ borderColor: PRIMARY_COLOR }}
          />
          <span>Coverage area</span>
        </div>
        {themes.map((t) => (
          <div key={t.key} className="flex items-center gap-1.5">
            <span
              className="inline-block h-2.5 w-2.5 rounded-full"
              style={{ backgroundColor: t.color }}
            />
            <span>{t.label}</span>
          </div>
        ))}
        <div className="mt-1 flex items-center gap-1.5">
          <span
            className="inline-block h-2.5 w-2.5 rounded-full"
            style={{ backgroundColor: CLUSTER_FILL }}
          />
          <span>more (zoom in)</span>
        </div>
      </div>
    </div>
  );
}

function computeBounds(rings: Ring[], businesses: MapPin[]): LatLngBoundsExpression | undefined {
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
