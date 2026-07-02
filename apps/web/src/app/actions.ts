"use server";

import { recordFeedback, updateFindStatus } from "@localfinds/db";
import { revalidatePath } from "next/cache";

const ACTIONS = [
  "thumbs_up",
  "thumbs_down",
  "star",
  "unstar",
  "hide",
  "unhide",
] as const;
type FeedbackAction = (typeof ACTIONS)[number];

// Star/hide change what the feed shows AND are recorded as taste signal;
// thumbs are pure signal for the agents.
const STATUS_EFFECT: Partial<Record<FeedbackAction, "starred" | "hidden" | "shown">> = {
  star: "starred",
  unstar: "shown",
  hide: "hidden",
  unhide: "shown",
};

export async function submitFeedback(formData: FormData): Promise<void> {
  const findId = Number(formData.get("findId"));
  const action = String(formData.get("action")) as FeedbackAction;
  if (!Number.isInteger(findId) || !ACTIONS.includes(action)) return;

  await recordFeedback(findId, action);
  const status = STATUS_EFFECT[action];
  if (status) await updateFindStatus(findId, status);
  // The full feed lives at /feed; the dashboard's compact list mirrors it.
  revalidatePath("/feed");
  revalidatePath("/");
}
