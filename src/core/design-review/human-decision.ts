/**
 * @module design-review/human-decision
 * 193 Phase 2 (tasks 6-8): the human plan-revision decision record builders,
 * the English decision menu, and the interaction-eligibility evidence rules.
 *
 * Boundaries (locked semantics):
 * - ONLY a verified non-child owner whose ACTUAL session file matches the
 *   owner recorded on the pending decision may interact or persist a choice.
 *   Unknown roles or missing evidence keep the decision `pending` — never a
 *   guessed authority.
 * - The menu is shown exactly ONCE per pending decision per process
 *   (module-level single-flight). Single-flight prevents UI overlap; it is
 *   NOT a transaction lock — persistence serialization lives in
 *   pipeline-meta-transaction.
 * - Cancel / Esc / undefined / unknown values / exceptions / missing select
 *   keep the decision `pending` with ZERO stage-action visits, ZERO retry
 *   counting and ZERO RPCs. Re-presentation only ever happens through an
 *   explicit resume (Phase 3), never from an ordinary settle.
 */

import crypto from "node:crypto";
import type {
  DesignReviewActorEvidence,
  DesignReviewActorInput,
  HumanDecision,
  HumanDecisionChoice,
  HumanDecisionIssue,
  HumanDecisionReviewIdentity,
} from "./decision-types";

/** Exact menu title required by the requirements (English protocol string). */
export const HUMAN_DECISION_TITLE = "Design Review Decision";

/** Exact option labels in display order. */
export const HUMAN_DECISION_OPTIONS: readonly string[] = ["Revise Plan", "Proceed to Develop", "Cancel"];

/** Hard cap for the issue snapshot carried by a decision record. */
export const HUMAN_DECISION_MAX_ISSUES = 50;

/**
 * Map a raw menu selection to the persisted choice token. Anything that is
 * not one of the two affirmative labels (Cancel, unknown values, missing
 * selection) yields `undefined` = keep pending.
 */
export function mapHumanDecisionSelection(selection: string | undefined | null): HumanDecisionChoice | undefined {
  if (selection === "Revise Plan") return "revise-plan";
  if (selection === "Proceed to Develop") return "proceed-develop";
  return undefined;
}

/**
 * 193 Phase 2 (task 6): build the PENDING decision record bound 1:1 to the
 * just-consumed FAIL snapshot. Issues are bounded defensively; the mode is
 * the value PINNED for this review (never re-resolved later).
 */
export function buildPendingHumanDecision(input: {
  reviewIdentity: HumanDecisionReviewIdentity;
  reportDoc: string;
  reportHash: string;
  planHash: string;
  issues: readonly HumanDecisionIssue[];
  mode: "manual" | "smart";
  ownerSessionFile?: string;
}): HumanDecision {
  const issues = input.issues
    .filter((i) => typeof i.issueId === "string" && typeof i.text === "string")
    .slice(0, HUMAN_DECISION_MAX_ISSUES)
    .map((i) => ({ issueId: i.issueId, text: i.text }));
  return {
    state: "pending",
    decisionId: crypto.randomUUID(),
    reviewIdentity: { ...input.reviewIdentity },
    reportDoc: input.reportDoc,
    reportHash: input.reportHash,
    planHash: input.planHash,
    issues,
    mode: input.mode,
    ...(input.ownerSessionFile !== undefined ? { ownerSessionFile: input.ownerSessionFile } : {}),
    createdAt: Date.now(),
  };
}

/**
 * 193 Phase 2 (task 8): derive the chosen record from a PENDING one. The
 * immutable binding fields (identity/report/plan/issues/mode) carry over
 * untouched; only choice/source/decidedAt are added.
 */
export function applyHumanDecisionChoice(
  pending: HumanDecision,
  choice: HumanDecisionChoice,
  decidedAt: number,
): HumanDecision {
  if (pending.state !== "pending") {
    // Defensive: only a pending record may receive a first choice.
    throw new Error("human decision choice may only be applied to a pending decision");
  }
  return {
    ...pending,
    state: "chosen",
    choice,
    source: "human",
    decidedAt,
  };
}

/**
 * 193 Phase 2 (task 8): conservative role resolution. Phase 3 refines the
 * sources; Phase 2 grants interaction ONLY to an explicit non-child actor
 * whose session file EQUALS the owner file recorded on the decision. Every
 * other combination (absent input, child, missing file, mismatch, missing
 * owner evidence) resolves to "unknown"/"child" and stays pending.
 */
export function resolveDesignReviewActorEvidence(
  actor: DesignReviewActorInput | undefined,
  ownerSessionFile: string | undefined,
): DesignReviewActorEvidence {
  if (!actor) {
    return { role: "unknown", source: "absent", reason: "no actor evidence provided" };
  }
  if (actor.isChild) {
    return {
      role: "child",
      source: "child-flag",
      ...(actor.sessionFile !== undefined ? { sessionFile: actor.sessionFile } : {}),
      reason: "subagent sessions never own human decisions",
    };
  }
  if (!actor.sessionFile) {
    return { role: "unknown", source: "session-file", reason: "actor session file unavailable" };
  }
  if (!ownerSessionFile) {
    return {
      role: "unknown",
      source: "session-file",
      sessionFile: actor.sessionFile,
      reason: "owner session file was not recorded on the decision",
    };
  }
  if (actor.sessionFile !== ownerSessionFile) {
    return {
      role: "unknown",
      source: "session-file",
      sessionFile: actor.sessionFile,
      reason: "actor session file does not match the authorized owner",
    };
  }
  return { role: "owner", source: "session-file", sessionFile: actor.sessionFile };
}

/** English summary (requirements round-1 decision 1A): issues + report path. */
export function buildHumanDecisionSummary(decision: HumanDecision): string {
  const lines = [
    `Design review FAILED for plan "${decision.reviewIdentity.planDoc}" (round ${decision.reviewIdentity.round}).`,
    `Report: ${decision.reportDoc}`,
    `Open issues (${decision.issues.length}):`,
  ];
  for (const issue of decision.issues) {
    lines.push(`  - [${issue.issueId}] ${issue.text}`);
  }
  lines.push(
    "Choose: revise the plan (route back to \"plan\"), proceed to develop (human override of this FAIL), or cancel (stay pending).",
  );
  return lines.join("\n");
}

// ─── in-process single-flight (UI overlap protection, NOT a transaction) ────

const menuInFlight = new Set<string>();

/** Returns true when THIS caller may show the menu; false = already in flight. */
export function beginHumanDecisionMenu(decisionId: string): boolean {
  if (menuInFlight.has(decisionId)) return false;
  menuInFlight.add(decisionId);
  return true;
}

/** Release the single-flight slot (call in a finally block). */
export function endHumanDecisionMenu(decisionId: string): void {
  menuInFlight.delete(decisionId);
}

/** True while a menu for this decision id is in flight. */
export function isHumanDecisionMenuInFlight(decisionId: string): boolean {
  return menuInFlight.has(decisionId);
}

/** Test hook: clear all in-flight markers (mirrors clearAllDecisionTimers). */
export function clearAllHumanDecisionMenus(): void {
  menuInFlight.clear();
}

/** Select control shape the coordinator may provide (pi ctx.ui.select). */
export type HumanDecisionSelectFn = (
  title: string,
  options: readonly string[],
) => Promise<string | undefined>;

/**
 * 193 Phase 2 (task 7): present the menu exactly once. Any exception or
 * unrecognised selection maps to `undefined` (keep pending) — the caller is
 * responsible for the single-flight slot and for NEVER retrying the menu.
 */
export async function presentHumanDecisionMenu(
  select: HumanDecisionSelectFn | undefined,
  notify: ((msg: string) => void) | undefined,
  decision: HumanDecision,
): Promise<HumanDecisionChoice | undefined> {
  if (typeof select !== "function") {
    return undefined;
  }
  const summary = buildHumanDecisionSummary(decision);
  if (typeof notify === "function") {
    try {
      notify(summary);
    } catch {
      // Notify failure must not block the decision request itself.
    }
  }
  try {
    const selection = await select(HUMAN_DECISION_TITLE, HUMAN_DECISION_OPTIONS);
    return mapHumanDecisionSelection(selection);
  } catch {
    return undefined;
  }
}
