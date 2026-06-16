"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { type FeedDefaults, type FeedState, feedHref } from "@/lib/feed-url";

// The feed's only client island: native date inputs that push an event-date
// range onto the URL. Setting a range supersedes the days window; clearing it
// drops the date filter. Everything else is preserved via `state`, and feedHref
// keeps the URL clean relative to the cookie defaults.
export function DateRangePicker({
  state,
  defaults,
  from,
  to,
}: {
  state: FeedState;
  defaults: FeedDefaults;
  from?: string;
  to?: string;
}) {
  const router = useRouter();
  const [f, setF] = useState(from ?? "");
  const [t, setT] = useState(to ?? "");

  function apply() {
    router.push(
      feedHref(
        { ...state, from: f || undefined, to: t || undefined, days: undefined },
        defaults,
      ),
    );
  }

  function clear() {
    setF("");
    setT("");
    router.push(
      feedHref({ ...state, from: undefined, to: undefined, days: undefined }, defaults),
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-1.5 text-xs text-stone-600">
      <span className="mr-1 font-medium text-stone-500">Event dates</span>
      <input
        type="date"
        value={f}
        onChange={(e) => setF(e.target.value)}
        aria-label="Events from"
        className="rounded border border-stone-300 px-1.5 py-0.5"
      />
      <span aria-hidden="true">→</span>
      <input
        type="date"
        value={t}
        onChange={(e) => setT(e.target.value)}
        aria-label="Events to"
        className="rounded border border-stone-300 px-1.5 py-0.5"
      />
      <button
        type="button"
        onClick={apply}
        className="rounded bg-stone-800 px-2 py-0.5 text-white"
      >
        Apply
      </button>
      {(from || to) && (
        <button
          type="button"
          onClick={clear}
          className="rounded bg-stone-100 px-2 py-0.5 text-stone-600 hover:bg-stone-200"
        >
          Clear
        </button>
      )}
    </div>
  );
}
