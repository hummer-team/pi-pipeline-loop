/**
 * @module write-scope/types
 * 218 Phase 2 (T2.2): candidate/decision data shapes shared by the tool-guard
 * collection phase and the merged write decision (F.3-1/2).
 *
 * A "write candidate" is ONE denied-or-asked write target of the CURRENT tool
 * call. All candidates of one call merge into exactly ONE human decision
 * ("one tool call → at most one interaction"), which is the core R6 fix.
 */

/** Coarse path class for the out-of-root Deny breaker key (F.2/Q24-B). */
export const OUTSIDE_PATH_CLASS = "@outside";

/** Coarse path class for project-root files themselves (no directory segment). */
export const ROOT_PATH_CLASS = "@root";

/**
 * 218 F.3-2: category shown to the human, merged into ONE decision.
 */
export interface WriteCandidate {
  /** Project-relative path when in-root, absolute when out-of-root. */
  path: string;
  /** F.3-1 protection class — readonly outranks protected outranks whitelist_miss. */
  category: "protected" | "whitelist_miss";
  /** Tool that produced this candidate (violation detail `tool` field source). */
  source: "bash" | "write" | "edit";
  /** Coarse class for the Deny breaker key: first path segment or "@outside". */
  pathClass: string;
  /**
   * Original guard block reason carried verbatim so the protected-only batch
   * reproduces the pre-218 `askProtectDecision` text byte-for-byte (ask mode;
   * deny mode never collects).
   */
  reason?: string;
}

/** Final application result of one merged write decision. */
export type WriteDecisionOutcome =
  | { action: "pass" }
  | { action: "block"; reason: string; candidates: WriteCandidate[] };

/**
 * Per-tool-call accumulator shared by all bash segments (and by the single
 * write/edit candidate), so the guard asks the human exactly once per call.
 */
export interface WriteCandidateCollector {
  /** whitelist_miss targets — merged into one ask/allow/queue decision. */
  readonly miss: WriteCandidate[];
  /** protected targets collected ONLY under owner + protect.ask === true. */
  readonly protectedBatch: WriteCandidate[];
}

/** Fresh empty collector for one tool call. */
export function createWriteCandidateCollector(): WriteCandidateCollector {
  return { miss: [], protectedBatch: [] };
}

/**
 * Coarse breaker-key class for a PROJECT-RELATIVE path: the first path
 * segment (`docs/design/x.md` → `docs`), or "@root" for root-level files.
 * Deliberately insensitive to the exact file so "the same intent" repeated at
 * different temp paths counts together (F.3-3).
 */
export function inRootPathClass(relPath: string): string {
  const first = relPath.split("/")[0];
  return !first || first === "." ? ROOT_PATH_CLASS : first;
}

/** Distinct path classes of a candidate batch, in first-seen order. */
export function uniqueClasses(candidates: WriteCandidate[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const c of candidates) {
    if (!seen.has(c.pathClass)) {
      seen.add(c.pathClass);
      out.push(c.pathClass);
    }
  }
  return out;
}

/**
 * Human-readable target list for menus/block reasons: at most `max` paths,
 * then "…+N" (plan risk mitigation: merged prompts must not explode).
 */
export function formatCandidateList(candidates: WriteCandidate[], max = 5): string {
  const head = candidates.slice(0, max).map((c) => c.path);
  const rest = candidates.length - head.length;
  return head.join(", ") + (rest > 0 ? ` …+${rest}` : "");
}
