/**
 * @module constants
 * Shared constants used across pipeline modules.
 */

import type { PipelineStage } from "./types";
import * as pathMod from "node:path";

/**
 * Configuration directory name — consistent with pi SDK CONFIG_DIR_NAME.
 * Used by pipeline-init to create the .pi/ directory structure.
 */
export const CONFIG_DIR_NAME = ".pi";

/**
 * Prefix derived from CONFIG_DIR_NAME — used for resolve-time path rewriting
 * (when piWorkDir differs from ".pi", values prefixed with ".pi/" are rewritten)
 * and for the protection-set baseline. Single source of truth for the literal.
 */
export const PI_PREFIX = `${CONFIG_DIR_NAME}/`;

/**
 * Shared template directory — resolves to dist/template/ in production (after
 * build) or src/template/ in dev (when running tests against src/).
 *
 * Both src/ and dist/ layouts place the `template/` folder one level below
 * the module that imports this constant (`__dirname` resolves correctly in
 * both contexts because `tsc` preserves the relative folder structure).
 */
export const TEMPLATE_DIR = pathMod.resolve(__dirname, "template");

/**
 * Stages eligible for pipeline resume on aborted restart.
 * Excludes "awaiting_human" (frozen, requires decision menu) and
 * "completed" (terminal, requires fresh start).
 */
export const RESUMABLE_STAGES: PipelineStage[] = [
  "clarify", "plan", "design-review", "develop", "review", "fix",
];

/** Paths that agents in loop stages (develop/fix) must not modify.
 * Project rule files (e.g. AGENTS.md) are NOT protected by default;
 * users may add them via `config.protect.paths` if needed.
 */
export const PROTECTED_PATHS = [PI_PREFIX, ".git/"] as const;

/** Hard cap for stage-chain walking (prevents runaway loops on misconfigured chains) */
export const MAX_STAGE_CHAIN_LENGTH = 16;

/**
 * Sentinel value for allowedWritePaths meaning "all paths allowed".
 * When present in allowedWritePaths, stage write whitelist is fully open
 * and global protection chain applies unchanged.
 */
export const ALLOWED_WRITE_ALL = "**";

// ─── Spawn Wait Timeout (Phase 0 / 179) ──────────────────────────────────────

/**
 * Default maximum time (ms) to wait for a live same-named subagent to settle
 * before the pipeline escalates to manual handling.
 *
 * Single shared timeout source for two deferral paths:
 * - G3: a new stage spawn waits for an older same-agent subagent to settle
 *   before it is dequeued (prevents same-agent cross-stage twin liveness).
 * - G5/G7: the confirm gate popup is deferred until no top-level subagent is
 *   running (prevents Esc-key collateral cancellation from a subagent window).
 *
 * Overridable per-project via `spawnWaitTimeoutMs` in pipeline_loop.json.
 * Invalid values warn and fall back to this default.
 */
export const DEFAULT_SPAWN_WAIT_TIMEOUT_MS = 120_000;

/**
 * 210 Phase 0: default human-slot decision-wait timer for the decision
 * provider chain (requirement 5.2). Overridable via
 * `decisionPolicy.decisionWaitTimeoutMs`.
 */
export const DEFAULT_DECISION_WAIT_TIMEOUT_MS = 600_000;

/**
 * 216 P3: owner-wake channel reason for a RUNNING-state stage-exit refusal
 * (first refusal / defer from a child origin). Deliberately distinct from the
 * frozen 203 channel and the confirm-gate 211 channel — the owner-side arm
 * matches on the `stageExitRefusal.escalatedAt` credential, no freeze needed.
 */
export const STAGE_EXIT_REFUSED_ESCALATION_REASON = "stage_exit_refused";

/**
 * 216 P3: freeze/abort reason when the same-cause stage-exit refusal crosses
 * the freeze threshold (2nd occurrence) or the per-visit fuse budget
 * (`stage_exit_refusal_overflow` audit family). Registered in
 * KNOWN_POLICY_REASONS so users may configure decisionPolicy rules for it.
 */
export const STAGE_EXIT_REFUSED_OVERFLOW_REASON = "stage_exit_refused_overflow";

/**
 * 216 P3 (R5-Q4-A): freeze reasons that must keep the decision menu open for
 * a HUMAN when a UI exists — no decision-wait deadline is armed, so the
 * deadline policy can never auto-converge (continue/abort) these menus.
 * Headless (no-UI) convergence via `decision_provider_absent` stays unchanged.
 */
export const HUMAN_ONLY_DECISION_REASONS: ReadonlyArray<string> = [STAGE_EXIT_REFUSED_OVERFLOW_REASON];

/**
 * 210 Phase 0: default stage no-progress idle ceiling for the dual watchdog
 * (requirement 5.2). Overridable via `watchdog.stageIdleTimeoutMs`.
 */
export const DEFAULT_STAGE_IDLE_TIMEOUT_MS = 900_000;

/**
 * 210 Phase 0: default stage wall-clock ceiling for the dual watchdog
 * (requirement 5.2). Overridable via `watchdog.stageTimeoutMs`.
 */
export const DEFAULT_STAGE_TIMEOUT_MS = 5_400_000;

/**
 * Poll interval (ms) for the deferred-spawn fallback loop.
 *
 * When a new stage spawn is deferred because a same-agent subagent in another
 * stage is still live, the plugin listens for `subagents:completed/failed`
 * (event-driven). This interval drives a best-effort `probeAgentState` poll as
 * a safety net in case the lifecycle event is lost. The poll self-cleans on
 * settle or timeout.
 */
export const DEFERRED_SPAWN_POLL_INTERVAL_MS = 5_000;

// ─── Confirm Gate Re-ask Cap (Phase 4 / 179) ─────────────────────────────────

/**
 * Maximum number of bounded auto re-asks for an unresolved confirm gate.
 *
 * The owner session re-presents the plan/review confirmation dialog up to this
 * many times after an Esc-dismiss. Beyond the cap it only emits the actionable
 * hint (`formatConfirmGatePendingCopy`) to avoid a dialog storm.
 *
 * Raised from 1 to 3 (Phase 4 / 179, G5/G7) because a subagent-window Esc can
 * collateral-cancel the owner's dialog; a single miss must not deadlock the gate.
 */
export const CONFIRM_GATE_REASK_MAX = 3;

/**
 * Default maximum number of violations before the violation overflow breaker fires.
 * When violations.length >= this value, freezeAndPrompt("violation_overflow") is triggered.
 */
export const DEFAULT_MAX_VIOLATIONS = 3;

/**
 * Default maximum loop cycles before freeze (question 17-D).
 * Used as the fallback when meta.maxLoopCycles and config.maxLoopCycles are both unset.
 * Phase 0 (195_Bug): single source of truth for loop cycle budget default.
 */
export const DEFAULT_MAX_LOOP_CYCLES = 5;

/**
 * Default executor failure budget for stage-executor/terminal.ts budgetLimitOf (question 29-A).
 * Independent from maxLoopCycles — executor failures are counted per loop visit, not per cycle.
 * Phase 0 (195_Bug): decouples executor budget from loop cycle budget.
 */
export const DEFAULT_EXECUTOR_FAILURE_BUDGET = 3;

/**
 * Advisory-only: maximum bash_destructive prompt count before escalation.
 * Phase 0 (195_Bug): declared but NOT wired to any freezeAndPrompt call chain (N2).
 * Reserved for Phase 7 (bash_destructive guardSource-aware prompting).
 */
export const DEFAULT_BASH_DESTRUCTIVE_PROMPT_MAX = 5;

/**
 * Default cap on confirm rejections per stage (post-verify confirm gate).
 * Stage-level `confirm.maxRejections` overrides this value.
 * When exceeded, behavior is controlled by `confirmOverflow` ("ask" | "terminate").
 */
export const DEFAULT_CONFIRM_MAX_REJECTIONS = 5;

/**
 * 189 Bug 1: Maximum auto re-spawn attempts after transient run failures.
 * Total attempts = TRANSIENT_RETRY_MAX + 1 (initial + retries).
 * Exceeding this limit triggers freezeAndPrompt with reason "transient_retry_overflow".
 */
export const TRANSIENT_RETRY_MAX = 2;

/**
 * Default overflow behavior when confirm rejections exceed the cap.
 * - "ask": Prompt the user with Continue/Terminate TUI select.
 * - "terminate": Immediately abort the pipeline with flowState="aborted".
 */
export const DEFAULT_CONFIRM_OVERFLOW = "ask" as const;

// ─── Audit Throttle Window (Phase 3 / 170) ──────────────────────────────────

/**
 * Default throttle window for frozen/abort audit deduplication (milliseconds).
 * Same pipelineId+tool+flowState combination emits at most one audit entry
 * within this window to prevent log flooding.
 * Referenced by tool-guard.ts (frozen rejection) and agent-settled.ts (unbound notify).
 */
export const AUDIT_THROTTLE_WINDOW_MS = 60_000;

/**
 * 218 P0 (T0.3): Staleness ceiling for `activeSpawns` ledger entries whose
 * agentId the manager registry cannot resolve (`probeAgentState = "unknown"`).
 * `reconcileActiveSpawns` deletes such entries once their age exceeds this
 * window; live entries are kept regardless of age. Same value as the previous
 * inline 30-min heuristics in `prompt-injector.ts` (single source now).
 */
export const ACTIVE_SPAWN_TTL_MS = 30 * 60_000;

// ─── Frozen Aborted Exempt Tools (Phase 2 / 171) ─────────────────────────────

/**
 * Tools exempt from the frozen-state block when flowState === "aborted" or "blocked".
 * These are read-only probe tools that enable self-rescue in the zombie state
 * (no decision menu available for aborted pipelines).
 *
 * Phase 5 (173) E2: Effective for aborted+blocked (172-G6a verified tool-guard.ts:542).
 * awaiting_human maintains full block (no exemption — decision menu is escape hatch).
 *
 * - pipeline_state: read-only meta snapshot (safe — no write side effects)
 * - get_subagent_result: reads back subagent result text (external tool, read-only)
 *
 * NOTE: `read` is intentionally NOT included (Q2-B decision). Aborted after Phase 1
 * only occurs on owner exit / stale_startup / user_abort — process death means
 * transcript is on disk and recoverable after resume.
 */
export const FROZEN_ABORT_EXEMPT_TOOLS: readonly string[] = [
  "pipeline_state",
  "get_subagent_result",
] as const;

// ─── Decision Menu Interrupt Threshold (Phase 6 / 172) ──────────────────────

/**
 * Maximum elapsed time (ms) for a ui.select to resolve with undefined that is
 * classified as a "system interrupt" rather than a "user cancel".
 * When the select resolves in less than this time with undefined, we assume
 * the pi TUI dismissed it due to streaming output (not user pressing Esc).
 * Default: 1500ms.
 */
export const DECISION_DISMISS_INTERRUPT_MS = 1500;

// ─── Protect-Ask Dismiss Threshold (Phase 4 / 173) ─────────────────────────

/**
 * Maximum elapsed time (ms) for a protect-ask ui.select to resolve with undefined
 * that is classified as "dismissed" (streaming output auto-dismiss) rather than
 * "canceled" (user Esc). When elapsed < this threshold, the dismiss does NOT
 * count as a violation but increments dismissCount.
 *
 * Default: 1500ms (same as DECISION_DISMISS_INTERRUPT_MS for consistency).
 */
export const PROTECT_ASK_DISMISS_MS = 1500;

/**
 * Maximum number of fast-dismiss ask dialogs before triggering freezeAndPrompt.
 * When dismissCount >= this value, the pipeline freezes with reason "dismiss_overflow"
 * and the decision menu is presented on the owner side.
 *
 * Default: 5.
 */
export const DEFAULT_MAX_DISMISS_COUNT = 5;

// ─── Canonical Stage Order (Phase 3 / 173) ──────────────────────────────────

/**
 * Canonical ordering of pipeline stages for choose_stage inference and jump semantics.
 * Used by inferResumeStage() and executeDecision("choose_stage") to determine
 * forward/backward stage relationships and summary disposition (skipped/invalid).
 *
 * Note: review and fix form a cycle (review→fix→review) but are listed linearly
 * here for ordinal comparison. Jump semantics handle the cycle via config.stages
 * nextStage chain, not this constant.
 */
export const CANONICAL_STAGE_ORDER: readonly string[] = [
  "clarify",
  "plan",
  "design-review",
  "develop",
  "review",
  "fix",
  "awaiting_human",
  "completed",
] as const;

// ─── Pipeline Turn Signatures (Phase 2 / 172) ─────────────────────────────────

/**
 * Centralized list of message prefixes/patterns that identify a user turn as
 * pipeline-orchestrated (as opposed to a pure chat interaction).
 *
 * MAINTENANCE NOTE: When new sendUserMessage wake messages or @mention patterns
 * are added to the codebase, they MUST be registered here to avoid the settle
 * gate (agent_settled) silently skipping verification for pipeline turns.
 *
 * Each entry is either:
 * - A string prefix (message starts with this text → pipeline turn)
 * - A RegExp pattern (message matches this pattern → pipeline turn)
 *
 * Strings are checked via `msg.startsWith(prefix)`.
 * RegExps are checked via `regex.test(msg)`.
 */
export const PIPELINE_TURN_SIGNATURES: ReadonlyArray<string | RegExp> = [
  // verify-advance wake: "Verification failed for "{stage}": ..."
  // Source: core/verify-advance.ts L354/366/387
  "Verification failed for \"",

  // stage-advancer route wake: "Stage "{from}" {reason}. Routing to "{to}" ..."
  // Source: core/stage-advancer.ts L422
  "Stage \"",

  // verify-advance stage completion wake: "Pipeline advanced from {from} to {to}. ..."
  // Source: core/verify-advance.ts L472
  "Pipeline advanced from ",

  // subagent-rpc spawn prompt prefix: "Begin the {stage} stage work now. ..."
  // Source: utils/subagent-rpc.ts L467
  "Begin the ",

  // 194 Phase 3 (task 3): trusted owner wake from a closed-loop executor
  // terminal. The settle gate FIRST verifies the embedded wakeId against the
  // run's persisted pendingWakeId (stage-executor/turn-source.ts); this
  // registration is the fallback so the wake turn is never mistaken for
  // ordinary chat even if the strict source check is unavailable.
  "pi-pipeline:owner-wake ",

  // 192 Phase 1 terminal wake: "[plugin auto-settle] Design-review ... "
  // 194 Phase 3 (task 3): registers the PREVIOUSLY UNRECOGNISED legacy wake
  // prefix (a production wake turn used to fall into the ordinary-chat gate)
  // so review/update terminal wakes are pipeline turns on the text path too.
  "[plugin auto-settle] ",

  // @mention pattern: "@agent-name file [args]" where args include round indicators
  // Matches: "@feat-design-plan-agent docs/req.md 1", "@agent file 2 答", "@agent file full-und?"
  // Source: commands/pipeline-start.ts L803, user-initiated @mentions
  /^@\S+\s+\S+.*(\d+\s*答|full-und\?|\s\d+$)/,
] as const;

// ─── Spawn Tool Names (Phase 4 / 171) ────────────────────────────────────────

/**
 * Tool names used by pi-subagents to spawn subagents.
 * Centralized here so tool-guard and other modules can reference a single source
 * instead of hardcoding "Agent" strings.
 */
export const SPAWN_TOOL_NAMES: readonly string[] = ["Agent"] as const;

// ─── Terminal Context Compaction Defaults (Phase 4 / 169) ────────────────────

/**
 * Whether terminal context compaction is enabled by default.
 * When true, ctx.compact is invoked once after the pipeline reaches completed.
 */
export const DEFAULT_COMPACT_ENABLED = true;

/**
 * Minimum token count to trigger compaction.
 * Below this threshold, compaction is skipped (audit-only, no token waste).
 * Matches the official trigger-compact.ts example value.
 */
export const DEFAULT_COMPACT_TOKEN_THRESHOLD = 100_000;

/**
 * Default custom instructions for terminal context compaction.
 * Anchors critical context pointers that must survive the lossy compression.
 */
export const DEFAULT_COMPACT_INSTRUCTIONS = `Pipeline completed. Preserve the following context pointers verbatim:

1. Terminal state: pipeline reached "completed" stage
2. stageVisitOrder: the full ordered list of stages visited (including re-visits)
3. Deliverable paths: all stage summary artifact paths (meta.summaries[].path) and completed.md
4. Requirement doc: the requirement document pointer (meta.requirementDoc) with all clarification conclusions
5. Commit pointers: any git commit ids referenced during the pipeline
6. Keep all the above pointers verbatim — do not summarize or paraphrase file paths, commit ids, or stage names`;

/**
 * Default write whitelist for read-only stages (clarify/plan/review).
 * These stages may only write to documentation directories.
 */
export const DEFAULT_READONLY_WRITE_PATHS = ["docs/", "doc/", "documentation/"];

/**
 * 192 Phase 2 (K04/K05): built-in default for the design-review authorized
 * UPDATE prompt. Used ONLY when the YAML file or the
 * `design_review_update_prompt` key is ABSENT (missing-file / missing-key).
 * Explicit empty values, non-strings, or YAML read/parse errors BLOCK the
 * update dispatch instead of silently falling back to this default.
 *
 * Runtime tokens use the SAME declared set as YAML templates:
 * {pipelineId} {planDoc} {reviewDoc} {round} {operationId} {baselinePlanHash}
 * {updateReceiptDoc} ({requirementDoc} and {issues} are also declared for
 * custom templates). Example fields are written WITHOUT braces so they are
 * never treated as runtime tokens. The independent
 * `.pi/references/design-review-update-prompt.md` file is a historical asset
 * and is NOT a runtime fallback.
 *
 * 194 Phase 1 (C1/C2): the update receipt is a STANDALONE document the plugin
 * derives ({updateReceiptDoc}), never a plan-body section. A CUSTOM update
 * template that does not reference {updateReceiptDoc} is rejected before
 * dispatch, so every 194 update is told exactly where its receipt belongs.
 */
export const DEFAULT_DESIGN_REVIEW_UPDATE_PROMPT = `## Design Review Update Mode
This plan update is triggered by a **design-review FAIL** verdict. You are in authorized update mode.

**Context**
- Pipeline: {pipelineId}
- Plan document (deliverable you edit): {planDoc}
- Review report (read it fully first): {reviewDoc}
- Review round: {round}
- Update operation id: {operationId}
- Baseline plan hash (before your change): {baselinePlanHash}
- Update receipt document (the ONLY place your process receipt goes): {updateReceiptDoc}

**MUST**: Process every issue of the review report with TWO deliverables — the
edited plan document and ONE standalone update receipt document:
- Apply the actual fixes to the plan document ({planDoc})
- Write the disposition receipt into the receipt document ({updateReceiptDoc}),
  creating or overwriting it with the EXACT format below
- Provide one disposition per issue: \`fixed\`, \`deferred\`, or \`rejected\`, each with a concrete justification
- \`fixed\` requires actual changes in the plan document AND a plan Phase location in \`### Changes Made\` — do NOT claim "fixed" without them
- Do NOT add new clarification rounds and do NOT fabricate user confirmation
- Do NOT modify source code, the requirement document, or any other file
- If an issue needs a NEW requirement or decision you cannot make alone, set its disposition to \`new-decision\` and STOP for owner review
- If an issue is provably unfixable in this plan, set its disposition to \`unfixable\` and explain why

**Receipt Output Format** (the section header, the seven identity rows and both
sub-sections are exact; the receipt document carries EXACTLY ONE such section):

\`\`\`markdown
## Design Review Update

**Pipeline**: {pipelineId}
**Plan**: {planDoc}
**Review Operation**: <the operation row of the consumed review report, copied verbatim>
**Report**: {reviewDoc}
**Round**: {round}
**Operation**: {operationId}
**Baseline Hash**: {baselinePlanHash}

### Issue Dispositions

| # | Issue | Disposition | Justification |
|---|-------|-------------|---------------|
| 1 | <short issue summary from the report> | fixed / deferred / rejected / new-decision / unfixable | <one-line rationale> |
...

### Changes Made

- <where in the plan each fixed issue was addressed, citing the plan Phase (e.g. "Phase 3"), for the next review round>
\`\`\`

**Constraints**
- Write ONLY the plan document ({planDoc}) and the receipt document ({updateReceiptDoc}); keep all existing plan structure and decisions unless explicitly addressing review issues
- The plan body must NOT gain or edit any \`## Design Review Update\` protocol section — the receipt lives exclusively in the standalone document
- The disposition table must cover EVERY issue of the consumed report exactly once; missing or duplicate entries invalidate the update
- The updated plan is automatically re-reviewed in the next design-review round; final fix QUALITY is judged there, not by this step`;

/**
 * 193 Phase 1: built-in default guidance appended to a REVIEW dispatch when
 * the design-review stage runs in SMART confirmation mode.
 *
 * Selection policy (identical to the update prompt, K04/K05): the ONLY custom
 * source is the YAML key `design_review_smart_decision_prompt` in
 * `{piWorkDir}/references/pipeline-stage-prompt.yml`; only a genuinely absent
 * file/key falls back to this constant, while explicit empty/non-string values
 * and read/parse/token errors BLOCK the dispatch (never a silent default swap).
 *
 * Declared runtime tokens: {pipelineId} {planDoc} {round} {operationId}
 * {inputHash} {reportDoc}. Example fields are written WITHOUT braces so they
 * are never treated as runtime tokens. The guidance is appended ONLY to the
 * exact review prompt; update and develop-handoff dispatches never carry it.
 */
export const DEFAULT_DESIGN_REVIEW_SMART_DECISION_PROMPT = `## Design Review Smart Plan-Revision Decision

This review runs under SMART confirmation mode for pipeline {pipelineId}.
Identity: plan {planDoc}, round {round}, review operation {operationId},
input hash {inputHash}, report {reportDoc}.

- If your verdict is PASS: ignore this section entirely and never write a
  Plan Revision Decision into a PASS report.
- If your verdict is FAIL: append EXACTLY ONE section to the report:

\`\`\`markdown
## Plan Revision Decision

**action**: revise-plan
**reason**: <replace this line with one real justification>
\`\`\`

- **action** accepts ONLY these two lowercase tokens:
  - revise-plan — every issue is fixable inside the plan document by an
    authorized autonomous revision pass.
  - request-human — at least one issue needs a human call (requirement
    conflict, product direction, missing authority, or information only the
    owner can supply).
- proceed-develop is NOT a valid action: a FAIL verdict can never ask to
  enter development; smart mode does not release FAIL automatically.
- **reason** must be a real justification line — never blank, never left as the
  angle-bracket instruction or any other copied template placeholder.
- A FAIL report without this exact section (or with a duplicated,
  contradictory, empty or placeholder variant) is rejected as INVALID and
  returned to you for correction — it is never routed anywhere.`;

/** Default path templates for stage resources (use {stage} placeholder) */
export const DEFAULT_SKILL_PATH = "{stage}/SKILL.md";
export const DEFAULT_VERIFY_FILE = ".pi/references/{stage}_spec/verify.md";

// ─── Commit Doc Naming Constraint (Phase 3 / 182, Phase 0 / 189) ─────────────

/**
 * Naming constraint for commit-doc deliverables (develop/fix stages).
 *
 * 189 Phase 0: Narrowed from the loose `{reqBase}_*_commit.md` pattern to the
 * exact single-file-per-requirement contract. 
 * 201 Phase 2: Generated name is `{reqBase}_Develop_Commit.md`; legacy
 * `{reqBase}_plan_commit.md` remains read-compatible but is never generated.
 * Per-phase commit ids are appended to a single file's `**dev commit id**`
 * line; never split into per-phase files. This eliminates `_phase0_`, `_dev_`,
 * `_develop_` drift that previously bypassed verification (audit 106_Feat
 * commit-doc misname).
 *
 * Appended to the stage deliverables prompt by prompt-injector so the model
 * sees the constraint at the point of writing commit docs.
 */
export const COMMIT_DOC_NAMING_CONSTRAINT =
  "Commit doc file MUST be named exactly `{reqBase}_Develop_Commit.md` (e.g. `106_Feat.md` → `docs/design/106_Feat_Develop_Commit.md`). Per-phase commit ids MUST be appended to the single file's `**dev commit id**` line; NEVER create per-phase files (`_phase0_`, `_dev_`, `_develop_` suffixes forbidden).";

/**
 * 204 Phase 2: plan-stage naming constraint, mirrored on COMMIT_DOC_NAMING_CONSTRAINT.
 * Injected into the plan-stage deliverables prompt so the model learns the exact
 * file name and required structure BEFORE writing (previously only an after-the-fact
 * verify glob guarded this).
 */
export const PLAN_DOC_NAMING_CONSTRAINT =
  "Plan doc file MUST be named exactly `{reqBase}_Plan.md` (same directory as the requirement doc). " +
  "The document MUST contain the six sections Summary / Phase {x} / Task List / Acceptance Criteria / " +
  "Unit Tests Core / Commit Specification, and MUST end with a `## 用户确认` (or `## User Confirmation`) " +
  "section — never invent an alternative file name or heading layout.";

/** Default write scope by stage type (tools and bash prefixes no longer restricted) */
export const STAGE_TYPE_TOOL_DEFAULTS: Record<
  string,
  { allowedWritePaths: string[]; allowedReadOnlyPaths?: string[] }
> = {
  clarify: {
    allowedWritePaths: DEFAULT_READONLY_WRITE_PATHS,
  },
  plan: {
    allowedWritePaths: DEFAULT_READONLY_WRITE_PATHS,
  },
  "design-review": {
    allowedWritePaths: DEFAULT_READONLY_WRITE_PATHS,
  },
  develop: {
    allowedWritePaths: [ALLOWED_WRITE_ALL],
    allowedReadOnlyPaths: ["docs/design/*_Plan.md"],
  },
  review: {
    allowedWritePaths: DEFAULT_READONLY_WRITE_PATHS,
  },
  fix: {
    allowedWritePaths: [ALLOWED_WRITE_ALL],
    allowedReadOnlyPaths: ["docs/design/*_Plan.md"],
  },
};

// ─── Doc Menu / Archive Configuration (206 Phase 0) ──────────────────────────

/**
 * 206 Phase 0: built-in age thresholds (in days) offered by the
 * `/pipeline-archive` threshold menu. Not configurable — the values 7/3/1 are
 * fixed constants per the 206_Feat final decision matrix.
 */
export const ARCHIVE_THRESHOLD_DAYS: readonly number[] = [7, 3, 1];

/**
 * 206 Phase 0: default archive landing directory name. Resolved against the
 * user's home directory at execution time (`<os.homedir()>/<dest>`).
 * Used when `archive.dest` is missing/invalid in pipeline_loop.json.
 */
export const DEFAULT_ARCHIVE_DEST = "pi-pipeline-archive";

/**
 * 206 Phase 0: fallback archive scan directories when neither `archive.dirs`
 * nor `docs.stageDirs` values are configured. Project-relative.
 */
export const DEFAULT_DOCS_FALLBACK_DIRS: readonly string[] = ["docs"];

/**
 * 206 Phase 0: built-in stage → candidate-document directory map used when
 * `docs.stageDirs` is NOT configured (auto-match mode). Values are
 * project-relative directory paths.
 *
 * - clarify/plan/design-review/develop/review → "docs/design"
 * - fix → "docs/review" (code-review reports live there)
 */
export const DEFAULT_STAGE_DOC_DIRS: Readonly<Partial<Record<PipelineStage, string>>> = {
  clarify: "docs/design",
  plan: "docs/design",
  "design-review": "docs/design",
  develop: "docs/design",
  review: "docs/design",
  fix: "docs/review",
};

/**
 * 206 Phase 0: maximum number of candidate documents shown in the
 * `/pipeline-start` doc-candidate menu (Q3-A: single-select, ≤5, mtime desc).
 */
export const MAX_DOC_CANDIDATES = 5;

/** Resolve a path template by replacing {stage} with the actual stage name */
export function resolveStagePath(template: string, stage: string): string {
  return template.replace(/\{stage\}/g, stage);
}

/** Default verification prompt used when no verify.md body is available */
export const DEFAULT_VERIFY_PROMPT = "- Fully understand the requirement context (goals, scope, boundaries)\n" +
    "- Clear and unambiguous solution selection that covers all requirement boundaries\n";

/**
 * System prompt for the LLM parse stage — instructs the LLM to extract
 * structured VerificationInstruction[] from Markdown verification descriptions.
 */
export const DEFAULT_VERIFY_PARSE_PROMPT = `You are a verification instruction parser. Given a Markdown description of what to verify, extract structured verification instructions as a JSON array.

Each instruction must have:
- "checkType": one of "fileExists", "fileContent", "command", "gitStatus"
- "target": the file path, command, or git check target
- "expected": (optional) expected content pattern or value

Respond ONLY with a JSON array. No explanation, no markdown.

Example output:
[
  {"checkType": "fileExists", "target": "docs/design/commit.md"},
  {"checkType": "fileContent", "target": "docs/design/commit.md", "expected": "^phase_name:"},
  {"checkType": "command", "target": "bun run build"},
  {"checkType": "gitStatus", "target": "cleanWorkingTree"}
]`;

/**
 * System prompt for the LLM judge stage — instructs the LLM to evaluate
 * verification execution results and render an overall pass/fail judgment.
 */
export const DEFAULT_VERIFY_JUDGE_PROMPT = `You are a verification result judge. Given the execution results of verification instructions, determine whether the overall verification has passed.

Consider:
- All file existence checks must pass
- All content pattern checks must match
- All commands must succeed with expected exit codes
- Git status checks must be satisfied

Respond with JSON: {"passed": true/false, "reasoning": "brief explanation"}
Respond ONLY with JSON. No explanation outside the JSON object.`;

/**
 * System prompt for the LLM extraction stage in pipeline-init 1 / verify-generator shared module —
 * instructs the LLM to extract delivery items from skill file content.
 *
 * The example uses a placeholder <build command from project> instead of a
 * tech-stack-specific command to avoid biasing the LLM toward any particular
 * ecosystem. The actual project tech stack context is injected by
 * verify-generator before the prompt is sent (see detectTechStack in tech-stack.ts).
 */
export const DEFAULT_VERIFY_EXTRACT_PROMPT = `You are a delivery item extractor. Given a skill file content, extract the deliverables that must be produced for the stage to be considered complete.

Look for items marked with **必须**, **Must**, **Required**, **MUST** or similar strong obligation markers.

For each deliverable, classify it as one of:
- "file": a file that must be created/modified
- "command": a command that must succeed — MUST be based on the project's actual tech stack (e.g. Maven/Gradle for Java, npm/bun for Node, cargo for Rust), not generic examples
- "git": a git state that must be true
- "keyword": a keyword that must appear in the output

Respond with JSON array:
[
  {"type": "file", "target": "docs/design/commit.md"},
  {"type": "command", "target": "<build command from project>"},
  {"type": "command", "target": "<test command from project>"},
  {"type": "keyword", "target": "答"}
]

Respond ONLY with the JSON array.`;

/**
 * Default system prompt for model-based conflict/overlap detection between
 * business SKILL content and plugin-injected prompt segments.
 * Used by runConflictCheck in pipeline-init when yml conflict_check_prompt
 * key is missing or empty.
 *
 * Phase 6 (146): mirrors the structure of DEFAULT_VERIFY_EXTRACT_PROMPT.
 */
export const DEFAULT_CONFLICT_CHECK_PROMPT = `You are a prompt conflict analyzer. Given the business skill content and the plugin-injected prompt segments for the same pipeline stage, detect CONFLICTS and OVERLAPS between them.

Definitions:
- "conflict": the two sources give contradictory instructions (e.g., one says "call stage_advance" and the other says "must NOT call stage_advance").
- "overlap": the two sources cover the same requirement redundantly with different wording (e.g., both describe the nextStage handoff protocol) — not contradictory but duplicated; recommend which source should own it.

For each issue, respond with a JSON object:
{
  "stage": "<stage>",
  "items": [
    {
      "kind": "conflict" | "overlap",
      "skillSnippet": "<verbatim quote from the skill content>",
      "pluginSnippet": "<verbatim quote from the plugin segment>",
      "reason": "<why this is a conflict or overlap>",
      "suggestion": "<recommended fix: which source to change and how>"
    }
  ]
}

Rules:
- Only report real issues; do not invent problems.
- Quote snippets verbatim.
- If no issues found, respond with {"stage": "<stage>", "items": []}.

Respond ONLY with the JSON object.`;
