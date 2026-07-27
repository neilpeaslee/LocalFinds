// Vanilla Leaflet inside a LiveView hook — the port of RegionMap.tsx, which used
// react-leaflet. Both libraries are vendored (assets/vendor/) rather than npm
// installed: deploy-api.sh builds the release on the box, and npm on that path
// is the same class of dependency that broke the agent spawner under systemd.
import * as L from "../../vendor/leaflet.js"
import Supercluster from "../../vendor/supercluster.min.js"

const DEFAULT_CENTER = [44.1, -69.11]
const MASK_COLOR = "#1c1917"
const PRIMARY_COLOR = "#b45309"
const TOWN_COLOR = "#44403c"
const CLUSTER_FILL = "#64748b"
const CLUSTER_STROKE = "#475569"
const WORLD_RING = [[85, -180], [85, 180], [-85, 180], [-85, -180]]

// Multiply a #rrggbb (or #rgb) color toward black for a pin's darker border.
function darken(hex, factor = 0.6) {
  const h = hex.replace("#", "")
  const full = h.length === 3 ? h.split("").map((c) => c + c).join("") : h
  const n = Number.parseInt(full, 16)
  const clamp = (v) => Math.max(0, Math.min(255, Math.round(v)))
  const r = clamp(((n >> 16) & 255) * factor)
  const g = clamp(((n >> 8) & 255) * factor)
  const b = clamp((n & 255) * factor)
  return `#${((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1)}`
}

function bboxRing([s, w, n, e]) {
  return [[s, w], [s, e], [n, e], [n, w]]
}

function computeBounds(rings, pins) {
  let south = Infinity, west = Infinity, north = -Infinity, east = -Infinity
  for (const ring of rings) {
    for (const [lat, lng] of ring) {
      south = Math.min(south, lat); west = Math.min(west, lng)
      north = Math.max(north, lat); east = Math.max(east, lng)
    }
  }
  if (!rings.length) {
    for (const p of pins) {
      south = Math.min(south, p.lat); west = Math.min(west, p.lng)
      north = Math.max(north, p.lat); east = Math.max(east, p.lng)
    }
  }
  if (!Number.isFinite(south)) return null
  return [[south, west], [north, east]]
}

export default {
  mounted() {
    const read = (name) => JSON.parse(this.el.dataset[name] || "[]")
    const pins = read("pins")
    const towns = read("towns")
    const boundaries = read("boundaries")
    this.colorOf = new Map(read("themes").map((t) => [t.key, t.color]))

    this.map = L.map(this.el, {scrollWheelZoom: false})
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution:
        '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    }).addTo(this.map)

    // Towns with a real polygon get one; the rest fall back to a dashed bbox.
    const havePolygon = new Set(boundaries.map((b) => b.name))
    const fallbackTowns = towns.filter((t) => !havePolygon.has(t.name))
    const coverageRings = [
      ...boundaries.flatMap((b) => b.rings),
      ...fallbackTowns.map((t) => bboxRing(t.bbox)),
    ]

    const bounds = computeBounds(coverageRings, pins)
    if (bounds) {
      this.map.fitBounds(bounds, {padding: [16, 16]})
      this.map.setZoom(this.map.getZoom() + 1) // ZoomInOne
    } else {
      this.map.setView(DEFAULT_CENTER, 11)
    }

    // Everything below is drawn once — only the cluster layer redraws on pan.
    if (coverageRings.length > 0) {
      L.polygon([WORLD_RING, ...coverageRings], {
        interactive: false, stroke: false, fillColor: MASK_COLOR, fillOpacity: 0.35,
      }).addTo(this.map)
    }

    for (const b of boundaries) {
      for (const ring of b.rings) {
        L.polygon(ring, {
          color: b.primary ? PRIMARY_COLOR : TOWN_COLOR,
          weight: b.primary ? 2.5 : 1.5,
          fill: false,
        })
          .bindTooltip(b.name, {direction: "center", opacity: 0.9})
          .addTo(this.map)
      }
    }

    for (const t of fallbackTowns) {
      const [s, w, n, e] = t.bbox
      L.rectangle([[s, w], [n, e]], {
        color: t.primary ? PRIMARY_COLOR : TOWN_COLOR,
        weight: t.primary ? 2.5 : 1.5,
        dashArray: "4 3",
        fill: false,
      })
        .bindTooltip(t.name, {direction: "center", opacity: 0.9})
        .addTo(this.map)
    }

    // Built ONCE, not per viewport (a deliberate deviation from the reference —
    // see the spec). Querying it per pan is what getClusters is for, and it
    // keeps a bubble's count stable as you pan past it.
    this.index = new Supercluster({radius: 60, maxZoom: 20, minPoints: 4})
    this.index.load(
      pins.map((p) => ({
        type: "Feature",
        properties: {
          osmId: p.osm_id, name: p.name, theme: p.theme,
          subtype: p.subtype, kind: p.kind,
        },
        geometry: {type: "Point", coordinates: [p.lng, p.lat]},
      })),
    )

    this.clusterLayer = L.layerGroup().addTo(this.map)
    this.redraw = () => this.drawClusters()
    this.map.on("moveend", this.redraw)
    this.map.on("zoomend", this.redraw)
    this.drawClusters()
  },

  drawClusters() {
    const b = this.map.getBounds()
    const features = this.index.getClusters(
      [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()],
      Math.round(this.map.getZoom()),
    )

    this.clusterLayer.clearLayers()

    for (const f of features) {
      const [lng, lat] = f.geometry.coordinates
      const props = f.properties

      if (!props.cluster) {
        // Singleton -> a themed individual pin.
        const color = this.colorOf.get(props.theme) || CLUSTER_FILL
        const suffix = props.subtype ? ` · ${props.subtype}` : props.kind ? ` · ${props.kind}` : ""
        L.circleMarker([lat, lng], {
          radius: 5,
          color: darken(color), // darker outer border for definition
          fillColor: color,
          fillOpacity: 0.8,
          weight: 2,
          className: "lf-pin",
        })
          .bindTooltip(`<span class="font-medium">${props.name}</span>${suffix}`)
          .addTo(this.clusterLayer)
        continue
      }

      // Group -> a gray coverage count-bubble.
      const count = props.point_count || 0
      const marker = L.circleMarker([lat, lng], {
        radius: Math.min(16, 10 + Math.log2(count + 1) * 1.3),
        color: CLUSTER_STROKE,
        fillColor: CLUSTER_FILL,
        fillOpacity: 0.55,
        weight: 2,
        className: "lf-bubble",
      }).bindTooltip(String(count), {
        direction: "center", permanent: true, opacity: 1, className: "cluster-count",
      })

      marker.on("click", () => {
        const zoom = Math.min(this.index.getClusterExpansionZoom(props.cluster_id), 18)
        this.map.flyTo([lat, lng], zoom)
      })

      marker.addTo(this.clusterLayer)
    }
  },

  destroyed() {
    // React unmounting cleaned this up for free; a hook must do it or live
    // navigation leaks a Leaflet instance per visit.
    if (this.map) {
      this.map.off("moveend", this.redraw)
      this.map.off("zoomend", this.redraw)
      this.map.remove()
      this.map = null
    }
  },
}
