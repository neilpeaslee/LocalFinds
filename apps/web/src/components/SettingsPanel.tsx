import type { ReactNode } from "react";
import { saveSettings } from "@/app/settings-actions";
import { PAGE_SIZES } from "@/lib/pagination";
import type { FeedSettings } from "@/lib/settings";

// Collapsible defaults editor. A plain <details> keeps it zero-JS; the single
// <form> posts to the saveSettings server action (the only legal cookie writer).
// Seeded from the persisted defaults (not the resolved/URL state) — it edits the
// defaults, not the current ad-hoc view.

const VIEW_OPTS = [
  ["default", "All current"],
  ["starred", "Starred"],
  ["hidden", "Hidden"],
  ["all", "Everything"],
] as const;

const selectClass = "rounded border border-stone-300 px-2 py-1 text-sm";

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1 text-xs">
      <span className="font-medium text-stone-500">{label}</span>
      {children}
    </label>
  );
}

export function SettingsPanel({ feed }: { feed: FeedSettings }) {
  const sizeValue = feed.pageSize === "all" ? "all" : String(feed.pageSize);
  // React 19 auto-resets a form after its action runs, reverting uncontrolled
  // inputs to the defaultValue they were first mounted with — which would snap
  // the selects back to the pre-save values. Keying the form to the saved
  // settings remounts it after a save, so the inputs pick up the new defaults.
  const formKey = [
    feed.view,
    feed.pageSize,
    feed.density,
    feed.sort,
    feed.days ?? "",
    feed.from ?? "",
    feed.to ?? "",
  ].join("|");
  return (
    <details className="rounded-lg border border-stone-200 bg-white">
      <summary className="cursor-pointer px-3 py-2 text-sm font-medium text-stone-700">
        Settings
      </summary>
      <form
        key={formKey}
        action={saveSettings}
        className="flex flex-col gap-3 border-t border-stone-100 p-3"
      >
        <div className="flex flex-wrap gap-3">
          <Field label="Default view">
            <select name="view" defaultValue={feed.view} className={selectClass}>
              {VIEW_OPTS.map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Per page">
            <select
              name="pageSize"
              defaultValue={sizeValue}
              className={selectClass}
            >
              {PAGE_SIZES.map((s) => (
                <option key={s} value={String(s)}>
                  {s === "all" ? "All" : s}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Sort">
            <select name="sort" defaultValue={feed.sort} className={selectClass}>
              <option value="newest">Newest</option>
              <option value="oldest">Oldest</option>
              <option value="soonest">Soonest (by event date)</option>
            </select>
          </Field>
          <Field label="Cards">
            <select
              name="density"
              defaultValue={feed.density}
              className={selectClass}
            >
              <option value="full">Full</option>
              <option value="compact">Compact</option>
            </select>
          </Field>
          <Field label="Default time window">
            <select
              name="days"
              defaultValue={feed.days ? String(feed.days) : ""}
              className={selectClass}
            >
              <option value="">Any time</option>
              <option value="1">24h</option>
              <option value="7">7d</option>
              <option value="30">30d</option>
            </select>
          </Field>
        </div>
        <div className="flex flex-wrap items-end gap-3">
          <Field label="Default event range — from">
            <input
              type="date"
              name="from"
              defaultValue={feed.from ?? ""}
              className={selectClass}
            />
          </Field>
          <Field label="to">
            <input
              type="date"
              name="to"
              defaultValue={feed.to ?? ""}
              className={selectClass}
            />
          </Field>
          <button
            type="submit"
            className="rounded bg-stone-800 px-3 py-1.5 text-sm text-white"
          >
            Save as default
          </button>
        </div>
        <p className="text-xs text-stone-500">
          These seed every visit; per-page filters still override them. A saved
          event range takes precedence over the time window.
        </p>
      </form>
    </details>
  );
}
