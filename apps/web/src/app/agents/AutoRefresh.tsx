"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

// Re-renders the (server) Agents page on an interval while a run is in
// progress, so a `running → success` transition shows without a manual reload.
// Mounted only when `active` is true, so polling stops once runs finish.
export function AutoRefresh({
  active,
  intervalMs = 4000,
}: {
  active: boolean;
  intervalMs?: number;
}) {
  const router = useRouter();
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => router.refresh(), intervalMs);
    return () => clearInterval(id);
  }, [active, intervalMs, router]);
  return null;
}
