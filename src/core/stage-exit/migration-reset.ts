/**
 * @module stage-exit/migration-reset
 * 216_Bug (T2.4 / code-review round 2): the ONE reset every real stage
 * migration must apply.
 *
 * A stage migration is the only true boundary between stage VISITS, so the
 * per-stage attempt counter and the stage-exit refusal accounting always move
 * together. Spread this into a migration patch instead of writing the two
 * fields by hand — a site that resets `verifyAttempts` but forgets
 * `stageExitRefusal` makes the next same-NAME re-entry look like a continuation
 * of the previous visit (`stage-exit-refusal.ts` scopes `sameVisit` by stage
 * name), so the first refusal of the new visit would skip both the owner
 * escalation and the decision menu and go straight to freeze/abort.
 *
 * Kept in its own leaf module (no imports besides types) so `flow-state.ts` can
 * use it without creating an import cycle with `stage-exit-refusal.ts`.
 */
import type { SessionMeta } from "../../types";

/** Counter fields reset by every committed stage migration. */
export function stageMigrationResetCounters(): Pick<
  SessionMeta,
  "verifyAttempts" | "stageExitRefusal"
> {
  return { verifyAttempts: 0, stageExitRefusal: undefined };
}
