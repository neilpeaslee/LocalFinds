// Vanilla Leaflet inside a LiveView hook — the port of RegionMap.tsx, which used
// react-leaflet. Both libraries are vendored (assets/vendor/) rather than npm
// installed: deploy-api.sh builds the release on the box, and npm on that path
// is the same class of dependency that broke the agent spawner under systemd.
import * as L from "../../vendor/leaflet.js"
import Supercluster from "../../vendor/supercluster.min.js"

const DEFAULT_CENTER = [44.1, -69.11]

export default {
  mounted() {
    const pins = JSON.parse(this.el.dataset.pins || "[]")

    this.map = L.map(this.el, {scrollWheelZoom: false})
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution:
        '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    }).addTo(this.map)
    this.map.setView(DEFAULT_CENTER, 11)

    // Built ONCE, not per viewport (a deliberate deviation from the reference —
    // see the spec). Querying it per pan is what getClusters is for.
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
  },

  destroyed() {
    // React unmounting cleaned this up for free; a hook must do it or live
    // navigation leaks a Leaflet instance per visit.
    if (this.map) {
      this.map.remove()
      this.map = null
    }
  },
}
