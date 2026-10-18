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

/**
 * 204 Phase 2: derives the requirement base from a requirement DOC path.
 * `docs/design/204_Bug.md` → `204_Bug`; tolerates `.MD`, `\` separators and
 * an already-`_Plan`-suffixed stem. Returns "" for empty / extension-less input.
 */
export function reqBaseFromRequirementDoc(reqDoc: string): string {
  if (!reqDoc || typeof reqDoc !== "string") return "";
  const normalized = reqDoc.replace(/\\/g, "/");
  const base = normalized.split("/").pop() ?? "";
  const m = /^(.+)\.(md|MD)$/.exec(base);
  if (!m) return "";
  return reqBaseFromPlanStem(m[1]);
}

/**
 * 204 Phase 2: plan doc path relative to the requirement doc's directory.
 * `docs/design/204_Bug.md` → `docs/design/204_Bug_Plan.md`;
 * a bare `204_Bug.md` yields the bare file name.
 */
export function planDocRelPathFromRequirementDoc(reqDoc: string): string {
  const normalized = String(reqDoc ?? "").replace(/\\/g, "/");
  const idx = normalized.lastIndexOf("/");
  const dir = idx === -1 ? "" : normalized.slice(0, idx + 1);
  const name = planDocFileName(reqBaseFromRequirementDoc(normalized));
  return `${dir}${name}`;
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

/**
 * Legacy design-review report name: `review-design-{round}-{...}.md`.
 *
 * The body after the round is intentionally GENERIC (`.+`) so one matcher
 * covers BOTH historical base-name shapes seen on disk — the old plan-name
 * form (`review-design-1-{planBasename}.md`, e.g. `..._plan.md`) and the
 * bare requirement form (`review-design-1-{reqBase}.md`). The round is a
 * capturing group so round-aware consumers (round allocation / release
 * guards) can reuse this matcher as-is instead of re-deriving their own
 * regex (201 review issue 2/3 — single source of truth).
 */
export const LEGACY_DESIGN_REVIEW_RE = /^review-design-(\d+)-.+\.md$/;

/** New code review report name: `Code_Review_{reqBase}_Develop_Commit_{index}.md`. */
export const NEW_CODE_REVIEW_RE = /^Code_Review_.+_Develop_Commit_\d+\.md$/;

/** Legacy code review report name: `code_review_{...}.md`. */
export const LEGACY_CODE_REVIEW_RE = /^code_review_.+\.md$/;

/** New develop/fix commit doc name: `{...}_Develop_Commit.md`. */
export const NEW_COMMIT_RE = /_Develop_Commit\.md$/;

/** Legacy develop/fix commit doc name: `{...}_commit.md`. */
export const LEGACY_COMMIT_RE = /_commit\.md$/;

// ─── Verify-rule glob literals (single source for authored verify paths) ─────
//
// Authored verify rule sets (verify.md `path:` fields) reference these globs.
// The glob detectors in verify-path-resolver compare against the constants
// below so the glob literals live in ONE place alongside the file-name
// matchers (201 Phase 0/2/3; Windows backslash variants are derived, never
// re-typed at call sites).

/** Plan-doc verify glob (201 Phase 1 hard switch — legacy `*_plan.md` no longer matches). */
export const PLAN_DOC_GLOB = "docs/design/*_Plan.md";

/** New develop/fix commit-doc verify glob (201 Phase 2). */
export const NEW_COMMIT_DOC_GLOB = "docs/design/*_Develop_Commit.md";

/** Legacy develop/fix commit-doc verify glob (dual read). */
export const LEGACY_COMMIT_DOC_GLOB = "docs/design/*_commit.md";

/** New code-review report verify glob (201 Phase 3). */
export const NEW_REVIEW_DOC_GLOB = "docs/review/Code_Review_*.md";

/** Legacy code-review report verify glob (dual read). */
export const LEGACY_REVIEW_DOC_GLOB = "docs/review/code_review_*.md";

/** Windows path-separator variant of a verify glob (verbatim match on separators). */
function winGlobVariant(glob: string): string {
  return glob.replace(/\//g, "\\");
}

/** Windows variants of the verify globs above. */
export const PLAN_DOC_GLOB_WIN = winGlobVariant(PLAN_DOC_GLOB);
export const NEW_COMMIT_DOC_GLOB_WIN = winGlobVariant(NEW_COMMIT_DOC_GLOB);
export const LEGACY_COMMIT_DOC_GLOB_WIN = winGlobVariant(LEGACY_COMMIT_DOC_GLOB);
export const NEW_REVIEW_DOC_GLOB_WIN = winGlobVariant(NEW_REVIEW_DOC_GLOB);
export const LEGACY_REVIEW_DOC_GLOB_WIN = winGlobVariant(LEGACY_REVIEW_DOC_GLOB);
