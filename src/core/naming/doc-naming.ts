/**
 * @module core/naming/doc-naming
 * 201 Phase 0: Single source of truth for design deliverable document naming.
 *
 * All design deliverable file names are derived here — never from scattered
 * hardcoded strings/regexes at call sites. Later phases wire callers onto
 * these pure functions (no behavior contract beyond the names themselves).
 *
 * Naming contract (201 final):
 * | deliverable           | new name                                            | compat            |
 * |-----------------------|-----------------------------------------------------|-------------------|
 * | plan doc              | `{reqBase}_Plan.md`                                 | hard switch       |
 * | develop/fix commit doc| `{reqBase}_Develop_Commit.md`                       | new gen / dual read|
 * | design review report  | `Design_Review_{round}_{reqBase}_Design.md`         | new gen / dual read|
 * | code review report    | `Code_Review_{reqBase}_Develop_Commit_{index}.md`   | new gen / dual read|
 * | update receipt        | `Design_Review_Update_{round}_{opId}_{reqBase}_Design.md` | hard switch |
 *
 * Requirement/design-und docs (`docs/design/{index}_{xxx}.md`) stay untouched.
 *
 * Pure string functions — no file system I/O, no dependencies.
 */

/**
 * Strip a trailing `_Plan` / `_plan` marker from a plan document stem to get
 * the requirement base name (`{reqBase}`).
 *
 * `195_Bug_Plan` / `195_Bug_plan` → `195_Bug`. Any other stem is returned
 * verbatim (including empty string and stems without either suffix).
 *
 * @param stem - Plan document file name without extension
 * @returns The requirement base name
 */
export function reqBaseFromPlanStem(stem: string): string {
  if (stem.endsWith("_Plan")) return stem.slice(0, -"_Plan".length);
  if (stem.endsWith("_plan")) return stem.slice(0, -"_plan".length);
  return stem;
}

/** Plan document file name: `{reqBase}_Plan.md`. */
export function planDocFileName(reqBase: string): string {
  return `${reqBase}_Plan.md`;
}

/** develop/fix commit document file name: `{reqBase}_Develop_Commit.md`. */
export function commitDocFileName(reqBase: string): string {
  return `${reqBase}_Develop_Commit.md`;
}

/** Design review report file name: `Design_Review_{round}_{reqBase}_Design.md`. */
export function designReviewDocFileName(reqBase: string, round: number): string {
  return `Design_Review_${round}_${reqBase}_Design.md`;
}

/** Code review report file name: `Code_Review_{reqBase}_Develop_Commit_{index}.md`. */
export function codeReviewDocFileName(reqBase: string, index: number): string {
  return `Code_Review_${reqBase}_Develop_Commit_${index}.md`;
}

/**
 * Standalone design-review update receipt file name:
 * `Design_Review_Update_{round}_{operationId}_{reqBase}_Design.md`.
 */
export function updateReceiptFileName(reqBase: string, round: number, operationId: string): string {
  return `Design_Review_Update_${round}_${operationId}_${reqBase}_Design.md`;
}

// ─── Dual-pattern matchers (read compatibility for legacy names) ────────────

/** New design-review report name: `Design_Review_{round}_{...}_Design.md`. */
export const NEW_DESIGN_REVIEW_RE = /^Design_Review_\d+_.+_Design\.md$/;

/** Legacy design-review report name: `review-design-{round}-{...}.md`. */
export const LEGACY_DESIGN_REVIEW_RE = /^review-design-\d+-.+\.md$/;

/** New code review report name: `Code_Review_{reqBase}_Develop_Commit_{index}.md`. */
export const NEW_CODE_REVIEW_RE = /^Code_Review_.+_Develop_Commit_\d+\.md$/;

/** Legacy code review report name: `code_review_{...}.md`. */
export const LEGACY_CODE_REVIEW_RE = /^code_review_.+\.md$/;

/** New develop/fix commit doc name: `{...}_Develop_Commit.md`. */
export const NEW_COMMIT_RE = /_Develop_Commit\.md$/;

/** Legacy develop/fix commit doc name: `{...}_commit.md`. */
export const LEGACY_COMMIT_RE = /_commit\.md$/;
