/**
 * @module docs-paths
 * 222 Phase 0: single source of truth for the configurable `docs` layout.
 *
 * Everything that turns a docs directory into a runtime path lives here:
 * - glob constructors (`buildPlanDocGlob` / `buildCommitDocGlob` /
 *   `buildReviewDocGlob`) and the Windows separator variant;
 * - the validation + precedence resolver (`normalizeDocsDir` /
 *   `deriveDocsDirs` / `docsDirsOf`) — explicit `docs.<x>Dir` key, then the
 *   directory derived from `docs.stageDirs`, then the built-in default;
 * - stage write-scope defaults derived from the resolved directories;
 * - install/runtime token rendering (`renderDocsPathTokens`).
 *
 * Layer neutrality: this module sits at the `src/` root (NOT under `core/`) so
 * both `core/` and `utils/` may import it at runtime — `utils/subagent-rpc.ts`
 * has a static guard forbidding runtime imports of `../core/`. Pure functions
 * only: no file-system I/O, no configuration object mutation.
 */

import path from "node:path";
import type { DocsDirs, DocsJsonConfig, PipelineConfig, PipelineStage } from "./types";
import {
  ALLOWED_WRITE_ALL,
  DEFAULT_DESIGN_DIR,
  DEFAULT_JOBS_DIR,
  DEFAULT_READONLY_WRITE_PATHS,
  DEFAULT_REVIEW_DIR,
  DEFAULT_STAGE_DOC_DIRS,
} from "./constants";

// ─── Glob constructors ──────────────────────────────────────────────────────

/** Windows path-separator variant of a verify glob (verbatim match on separators). */
export function winGlobVariant(glob: string): string {
  return glob.replace(/\//g, "\\");
}

/** Strip trailing separators so `${dir}/${pattern}` never doubles a slash. */
function trimTrailingSlashes(dir: string): string {
  return dir.replace(/\/+$/, "");
}

/** Plan-doc glob for a design directory: `${dir}/*_Plan.md`. */
export function buildPlanDocGlob(dir: string): string {
  return `${trimTrailingSlashes(dir)}/*_Plan.md`;
}

/** Commit-doc glob (new / legacy) for a design directory. */
export function buildCommitDocGlob(dir: string, legacy = false): string {
  return `${trimTrailingSlashes(dir)}/*${legacy ? "_commit" : "_Develop_Commit"}.md`;
}

/** Code-review report glob (new / legacy) for a review directory. */
export function buildReviewDocGlob(dir: string, legacy = false): string {
  return `${trimTrailingSlashes(dir)}/${legacy ? "code_review_*" : "Code_Review_*"}.md`;
}

// ─── Validation ─────────────────────────────────────────────────────────────

const WIN_ABS_RE = /^[a-zA-Z]:[\\/]/;

/**
 * Validate one project-relative docs directory value (fail-open contract).
 *
 * Accepted: a non-empty relative path; backslashes are normalized to `/` and
 * trailing slashes are stripped. Rejected (a `warning` is returned, no `value`):
 * non-strings, empty/blank strings, absolute paths (posix or Windows drive) and
 * any path containing a `..` segment.
 */
export function normalizeDocsDir(raw: unknown): { value?: string; warning?: string } {
  if (typeof raw !== "string") return { warning: `expected a non-empty string, got ${typeof raw}` };
  const trimmed = raw.trim();
  if (trimmed.length === 0) return { warning: "empty string ignored" };
  const posix = trimTrailingSlashes(trimmed.replace(/\\/g, "/"));
  if (path.isAbsolute(trimmed) || WIN_ABS_RE.test(trimmed)) {
    return { warning: `absolute path "${trimmed}" ignored` };
  }
  if (posix.split("/").some((seg) => seg === "..")) {
    return { warning: `path traversal "${trimmed}" ignored` };
  }
  return { value: posix };
}

// ─── Precedence resolution ──────────────────────────────────────────────────

/**
 * First VALID, NON-BOILERPLATE configured stage directory among `keys`
 * (order = priority).
 *
 * 222 review issue 1: a `docs.stageDirs[key]` value EQUAL to the built-in
 * default (`DEFAULT_STAGE_DOC_DIRS[key]`) is BOILERPLATE — it is what the
 * shipped template used to pin (`review: "docs/design"`, `fix: "docs/review"`,
 * …). Treating it as a real derivation made an upgraded project (legacy six-key
 * `stageDirs`, no `docs.*Dir` key) derive `reviewDir = docs/design` from the
 * `review` key, which broke review-report discovery, `fix` start evidence,
 * verify narrowing and the doc menu at once. Skipping boilerplate keeps the
 * "installed projects are unaffected" invariant and also silences the
 * misleading `disagree` warning they used to emit on every startup.
 *
 * The check runs on the NORMALIZED value, so `"docs/design/"` / `"docs\\design"`
 * count as boilerplate too (no phantom "custom" directory that only differs by
 * a separator).
 */
function pickStageDir(
  stageDirs: Partial<Record<PipelineStage, string>> | undefined,
  keys: readonly PipelineStage[],
  warnings: string[],
  label: string,
): string | undefined {
  const values: string[] = [];
  for (const key of keys) {
    const raw = stageDirs?.[key];
    if (raw === undefined) continue;
    // R1Q4-A symmetry: derived values are validated exactly like explicit keys,
    // so an absolute / traversal stageDirs entry never becomes a write-scope
    // prefix or a read-only glob.
    const parsed = normalizeDocsDir(raw);
    if (!parsed.value) {
      warnings.push(`docs.stageDirs.${key}: ${parsed.warning}; ignored for ${label}`);
      continue;
    }
    // Review issue 1: template boilerplate (value === that stage's built-in
    // default) is not a derivation input — see the function doc comment.
    if (parsed.value === DEFAULT_STAGE_DOC_DIRS[key]) continue;
    values.push(parsed.value);
  }
  const distinct = [...new Set(values)];
  if (distinct.length > 1) {
    warnings.push(
      `docs.stageDirs disagree for ${label} (${distinct.join(" | ")}); using "${distinct[0]}"`,
    );
  }
  return distinct[0];
}

/**
 * Resolve the three docs directories from RAW config (single source of
 * precedence: explicit key → directory derived from `docs.stageDirs` → default).
 *
 * The returned `warnings` are the ONLY place these diagnostics are produced, so
 * the loader can emit each one exactly once. `configured` reports whether any
 * explicit `docs.<x>Dir` key was supplied (used to decide whether the resolved
 * block is attached to `PipelineConfig`).
 */
export function deriveDocsDirs(
  docs?: DocsJsonConfig,
  stageDirs?: Partial<Record<PipelineStage, string>>,
): { dirs: DocsDirs; configured: boolean; warnings: string[] } {
  const warnings: string[] = [];
  const read = (key: keyof DocsDirs, raw: unknown, fallback: string): string => {
    if (raw === undefined) return fallback;
    const parsed = normalizeDocsDir(raw);
    if (!parsed.value) {
      warnings.push(`docs.${key}: ${parsed.warning}; using "${fallback}"`);
      return fallback;
    }
    return parsed.value;
  };

  const derivedDesign = pickStageDir(stageDirs, ["plan", "develop"], warnings, "design");
  const derivedReview = pickStageDir(stageDirs, ["review", "fix"], warnings, "review");
  const designDir = read("designDir", docs?.designDir, derivedDesign ?? DEFAULT_DESIGN_DIR);
  const reviewDir = read("reviewDir", docs?.reviewDir, derivedReview ?? DEFAULT_REVIEW_DIR);
  const jobsDir = read("jobsDir", docs?.jobsDir, DEFAULT_JOBS_DIR);

  if (docs?.designDir !== undefined && derivedDesign && derivedDesign !== designDir) {
    warnings.push(
      `docs.designDir "${designDir}" overrides the directory derived from docs.stageDirs ("${derivedDesign}") ` +
        `for deliverables and, unless docs.stageDirs.<stage> is a NON-DEFAULT custom value, for the doc menu`,
    );
  }
  if (docs?.reviewDir !== undefined && derivedReview && derivedReview !== reviewDir) {
    warnings.push(
      `docs.reviewDir "${reviewDir}" overrides the directory derived from docs.stageDirs ("${derivedReview}") ` +
        `for review reports and, unless docs.stageDirs.<stage> is a NON-DEFAULT custom value, for the doc menu`,
    );
  }

  return {
    dirs: { designDir, reviewDir, jobsDir },
    configured:
      docs?.designDir !== undefined
      || docs?.reviewDir !== undefined
      || docs?.jobsDir !== undefined,
    warnings,
  };
}

/**
 * Runtime entry point (no warnings, no I/O): the resolved directories for an
 * already-resolved config. Explicit `docsDirs` entries win over `docsStageDirs`
 * derivation, which in turn wins over the built-in defaults.
 */
export function docsDirsOf(
  config: Pick<PipelineConfig, "docsDirs" | "docsStageDirs">,
): DocsDirs {
  const configured = config.docsDirs;
  return {
    designDir:
      configured?.designDir
      ?? pickStageDir(config.docsStageDirs, ["plan", "develop"], [], "design")
      ?? DEFAULT_DESIGN_DIR,
    reviewDir:
      configured?.reviewDir
      ?? pickStageDir(config.docsStageDirs, ["review", "fix"], [], "review")
      ?? DEFAULT_REVIEW_DIR,
    jobsDir: configured?.jobsDir ?? DEFAULT_JOBS_DIR,
  };
}

/** Default directories — the single source for callers without a config. */
export const DEFAULT_DOCS_DIRS: DocsDirs = {
  designDir: DEFAULT_DESIGN_DIR,
  reviewDir: DEFAULT_REVIEW_DIR,
  jobsDir: DEFAULT_JOBS_DIR,
};

// ─── Derived write scope ────────────────────────────────────────────────────

/** One stage's write-scope default (mirrors the `STAGE_TYPE_TOOL_DEFAULTS` shape). */
export interface StageToolDefaults {
  allowedWritePaths: string[];
  allowedReadOnlyPaths?: string[];
}

/**
 * Stage write-scope defaults derived from the resolved directories.
 *
 * R3Q9-A (append-only): the read-only stages keep every legacy entry of
 * `DEFAULT_READONLY_WRITE_PATHS` and ADD `${designDir}/` + `${reviewDir}/`, so a
 * customised layout stays writable. `develop` / `fix` keep the fully open write
 * scope and protect the plan document of the configured design directory.
 */
export function buildStageTypeToolDefaults(dirs: DocsDirs): Record<string, StageToolDefaults> {
  const docPaths = [
    ...new Set([
      ...DEFAULT_READONLY_WRITE_PATHS,
      `${dirs.designDir}/`,
      `${dirs.reviewDir}/`,
    ]),
  ];
  const planGlob = buildPlanDocGlob(dirs.designDir);
  return {
    clarify: { allowedWritePaths: docPaths },
    plan: { allowedWritePaths: docPaths },
    "design-review": { allowedWritePaths: docPaths },
    develop: { allowedWritePaths: [ALLOWED_WRITE_ALL], allowedReadOnlyPaths: [planGlob] },
    review: { allowedWritePaths: docPaths },
    fix: { allowedWritePaths: [ALLOWED_WRITE_ALL], allowedReadOnlyPaths: [planGlob] },
  };
}

// ─── Template token rendering ───────────────────────────────────────────────

/**
 * 222 Phase 5: replace the docs-path tokens with the resolved directories.
 *
 * Used both at install time (template copy / managed block / drift expectation
 * / conflict-check prompt) and at runtime (YAML deliverables, generated verify
 * content). Unknown tokens are left untouched.
 */
export function renderDocsPathTokens(text: string, dirs: DocsDirs): string {
  return text
    .replaceAll("{designDir}", dirs.designDir)
    .replaceAll("{reviewDir}", dirs.reviewDir)
    .replaceAll("{jobsDir}", dirs.jobsDir);
}