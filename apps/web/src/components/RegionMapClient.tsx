"use client";

import dynamic from "next/dynamic";
import type { RegionMapProps } from "./RegionMap";

// Leaflet touches the DOM at import time, so the map can only render in the
// browser. next/dynamic with ssr:false isn't allowed in a Server Component, so
// this thin client wrapper owns the dynamic import and the page renders it.
const RegionMap = dynamic(() => import("./RegionMap"), {
  ssr: false,
  loading: () => (
    <div className="flex h-72 w-full items-center justify-center rounded-lg border border-stone-200 bg-stone-100 text-sm text-stone-400 sm:h-96">
      Loading map…
    </div>
  ),
});

export default function RegionMapClient(props: RegionMapProps) {
  return <RegionMap {...props} />;
}
