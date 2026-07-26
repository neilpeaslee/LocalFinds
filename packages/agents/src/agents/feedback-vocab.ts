// Shared interpretation of one entry in the feedback vocabulary
// (packages/db/src/schema.ts's FeedbackAction), reused by every agent whose
// task prompt instructs it to fold read_feedback rows into profile.md/ICP
// notes: curator, prospector, concierge, source-keeper, scout. Centralized
// here so the next vocabulary change is one edit, not five separate prompt
// edits scattered across agents/*.ts.
//
// localfinds.feedback is append-only — a retraction can't delete or replace
// the earlier row, so a "thumbs_clear" row shows up in read_feedback just
// like any other feedback row. Without this note, an agent folding feedback
// into a dated profile bullet has no way to tell a retraction apart from a
// fresh signal, and would durably record it as one — worse than the original
// missing-toggle problem, because a wrong profile note doesn't get corrected
// on the next run the way a stale UI button would.
export const THUMBS_CLEAR_NOTE =
  'A "thumbs_clear" action means the human retracted an earlier thumb on that item — treat it as canceling that signal, not as a new taste signal of its own.';
