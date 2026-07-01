"use server";

import {
  type FindStatus,
  unhideAll,
  updateFindStatuses,
} from "@localfinds/db";
import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import {
  type Settings,
  SETTINGS_COOKIE,
  SETTINGS_COOKIE_OPTIONS,
  readSettings,
  serializeSettings,
  validDate,
  validDays,
  validDensity,
  validPageSize,
  validSort,
  validView,
} from "@/lib/settings";

// Persist the global defaults. The only place a cookie is written — pages read
// it. Re-renders the feed (and the dashboard, which mirrors it) afterwards.
export async function saveSettings(formData: FormData): Promise<void> {
  const f = (await readSettings()).feed;

  const from = validDate(formData.get("from"));
  const to = validDate(formData.get("to"));
  const days = validDays(formData.get("days"));

  const next: Settings = {
    feed: {
      view: validView(formData.get("view")) ?? f.view,
      pageSize: validPageSize(formData.get("pageSize")) ?? f.pageSize,
      density: validDensity(formData.get("density")) ?? f.density,
      sort: validSort(formData.get("sort")) ?? f.sort,
      // A persisted range beats a window; picking "Any time" clears both.
      from,
      to,
      days: from || to ? undefined : days,
    },
  };

  (await cookies()).set(
    SETTINGS_COOKIE,
    serializeSettings(next),
    SETTINGS_COOKIE_OPTIONS,
  );
  revalidatePath("/feed");
  revalidatePath("/");
}

// ---- Bulk feed management (status-only; no feedback rows). ----

export async function unhideAllAction(): Promise<void> {
  await unhideAll();
  revalidatePath("/feed");
  revalidatePath("/");
}

const BULK_STATUSES: FindStatus[] = ["hidden", "starred", "shown"];

// Apply a status to the current page's finds. `ids` is a comma-separated list of
// the visible find ids carried in a hidden form field.
export async function bulkUpdateStatus(formData: FormData): Promise<void> {
  const status = String(formData.get("status")) as FindStatus;
  if (!BULK_STATUSES.includes(status)) return;
  const ids = String(formData.get("ids") ?? "")
    .split(",")
    .map((s) => Number(s))
    .filter((n) => Number.isInteger(n) && n > 0);
  if (ids.length === 0) return;
  await updateFindStatuses(ids, status);
  revalidatePath("/feed");
  revalidatePath("/");
}
