/**
 * @module types
 * Project-agnostic type definitions for the pi pipeline loop plugin.
 * These types define the stage-based orchestration model, session metadata,
 * and configuration interfaces that projects use to customize their pipeline.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
export type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { RuntimeCtx } from "./core/runtime-ctx";

// ─── Audit Log Types ──────────────────────────────────────────────────────────

/**
 * Audit log severity levels.
 * - "info": Default level, no prefix in log line (backward compatible)
 * - "warn": Adds [WARN] prefix, used for auto_verify_fail and loop_break_fatal
 * - "error": Adds [ERROR] prefix, used for real-error catch blocks
 */
export type AuditLogLevel = "info" | "warn" | "error";

/**
 * Function signature for injecting audit logging into verifiers.
 * Used by Phase 1 to propagate error-level logging through the verifier chain.
 */
export type AuditLogFn = (
  stage: string,
  message?: Record<string, string>,
  level?: AuditLogLevel,
) => Promise<void>;

// ─── Execution Function Type (DI) ────────────────────────────────────────────

/**
 * Dependency-injected shell execution function.
 * Wraps pi.exec() so verifiers never call child_process directly.
 *
 * @param cmd - The command to execute (e.g., "git", "npm")
 * @param args - Arguments array (e.g., ["log", "-1"])
 * @param cwd - Working directory for the command
 * @returns Object with stdout, stderr, and exit code
 */
export type ExecFn = (
  cmd: string,
  args: string[],
  cwd: string
) => Promise<{ stdout: string; stderr: string; code: number }>;

// ─── Start Stage Mode ─────────────────────────────────────────────────────────

/**
 * Startup behavior mode for /pipeline-start command.
 * - "auto": Zero-interaction default (backward compatible with 142).
 *   Fresh → clarify; aborted → resume/new matrix unchanged.
 * - "confirm": Lightweight confirmation on resume. Resumable aborted
 *   pipelines prompt "Resume at {stage}? [Y/n]" before proceeding.
 * - "ask": Interactive TUI menu with new/resume/spec/cancel options.
 *   Supports jumping to a specific stage (spec mode).
 * Default: "auto" (backward compatible).
 */
export type StartStageMode = "auto" | "confirm" | "ask";

// ─── Pipeline Stages ─────────────────────────────────────────────────────────

/**
 * Union type of all pipeline stages.
 * Each stage represents a distinct phase in the agent's workflow loop.
 * 7-stage state machine: clarify → plan → develop → review → fix → completed
 * (awaiting_human is a fallback only, not in normal nextStage chain)
 */
export type PipelineStage =
  | "clarify"
  | "plan"
  | "develop"
  | "review"
  | "fix"
  | "awaiting_human"
  | "completed";

// ─── Stage Configuration ─────────────────────────────────────────────────────

/**
 * Verification configuration for a stage.  When `require` is true the
 * auto-verifier runs after the agent settles and may auto-advance.
 */
export interface VerifyConfig {
  /** Whether verification is required for this stage (default true) */
  require?: boolean;

  /** Path to the verify file (YAML frontmatter rules + Markdown body prompt) */
  verifyFile?: string;

  /**
   * Verification trigger mode (default "hook").
   * - "hook": auto-verification runs in agent_settled hook (existing behavior)
   * - "tool": agent calls pipeline_verify tool explicitly; agent_settled skips verification
   */
  mode?: "hook" | "tool";

  /**
   * Skip re-execution of requiredCommands when the model has already successfully
   * executed the same command via tool calls during the current stage.
   * Matching is based on tool call records (not textual claims), and invalidated
   * by write/edit operations after the matching call. Audit only when skipped.
   * Default: false.
   */
  selfVerifySkip?: boolean;

  /**
   * Interactive completion marker text. When configured, agent_settled prechecks
   * whether this marker has been written to the requirement document before running
   * verification. If the marker is not found on disk, verification is skipped,
   * the stage is NOT advanced, and verifyAttempts is NOT incremented (prevents freeze).
   */
  completionMarker?: string;
}

/**
 * Per-stage configuration that maps a pipeline stage to its agent, skill,
 * write scope restrictions, and transition rules.
 */
export interface StageConfig {
  /** Path to the agent definition file, relative to projectRoot (optional — no default fallback) */
  agentPath?: string;

  /** Path to the skill directory or file for this stage (relative to `.pi/skills/` directory, e.g. `"{stage}/SKILL.md"`) */
  skillPath: string;

  /** Whether this stage is disabled (set to true when require: false in JSON config) */
  disabled?: boolean;

  /**
   * Stage-level write whitelist (directory prefix matching).
   * - `"**"` = all paths allowed (full write access, global protect still applies)
   * - `[]` = no writes allowed (completely forbidden)
   * - `undefined` = fall back to stage-type default
   * - `["docs/", "src/"]` = only these directory prefixes allowed
   *
   * When whitelist is active (not containing "**"), stage whitelist takes priority:
   * - Paths matching whitelist are allowed (exempt from gitignore write protection)
   * - Hardcoded protected paths (.pi/, AGENTS.md, .git/) CANNOT be exempted
   * - git add/commit remains subject to global git content-level protection
   */
  allowedWritePaths?: string[];

  /**
   * The next stage to transition to after this stage completes.
   * `null` indicates this is the terminal stage (pipeline ends).
   */
  nextStage: PipelineStage | null;

  /** Whether this stage requires a domain context to be loaded */
  requireDomain: boolean;

  /** Optional verification configuration for auto-verification */
  verify?: VerifyConfig;
}

// ─── Summary Metadata ────────────────────────────────────────────────────────

/**
 * Metadata for a stage's summary artifact, used to track completion
 * and enable incremental re-runs.
 */
export interface SummaryMeta {
  /** File path to the summary artifact */
  path: string;

  /** Content hash of the summary (for change detection) */
  hash: string;

  /** Validation status. "skipped" indicates the stage was skipped by user decision. */
  status: "pending" | "valid" | "invalid" | "skipped";

  /**
   * Version number for versioned summary artifacts.
   * First generation: 1 (or undefined, treated as 1).
   * Subsequent loop iterations: 2, 3, ... (file named `{stage}-{n}.md`).
   * Backward-compatible: missing field is treated as version 1.
   */
  version?: number;
}

// ─── Domain Configuration ────────────────────────────────────────────────────

/**
 * Configuration for a domain context that can be loaded into stages
 * that have `requireDomain: true`.
 */
export interface DomainConfig {
  /** Unique domain identifier */
  id: string;

  /** Semantic version of the domain definition */
  version: string;

  /** Path to the domain's skill directory or file */
  skillPath: string;
}

// ─── Verification Failure Tracking ───────────────────────────────────────────

/**
 * A single verification failure item stored in SessionMeta.
 * Tracks the rule type, detail, and when it was recorded.
 */
export interface VerifyFailureItem {
  /** The type of rule that failed (e.g., "requiredFiles", "requiredCommands") */
  ruleType: string;
  /** Human-readable failure detail */
  detail: string;
  /** Unix timestamp (ms) when the failure was recorded */
  timestamp: number;
}

/**
 * A single violation item stored in SessionMeta.
 * Records tool-call interceptions for feedback injection and overflow detection.
 */
export interface ViolationItem {
  /** The type of violation that was blocked */
  type: "write_protected" | "git_protected" | "bash_destructive";
  /** The tool name that was blocked (if applicable) */
  tool?: string;
  /** English correction detail (e.g., "Tool \"write\" not allowed in \"clarify\" stage.") */
  detail: string;
  /** Optional suggestion (allowed tools/prefixes, protected paths) */
  suggestion?: string;
  /** Unix timestamp (ms) when the violation was recorded */
  timestamp: number;
}

/**
 * A self-contained snapshot of the unified verification result.
 * Mirrors the full VerifyResult type from auto-verifier without importing it,
 * avoiding circular dependencies between types.ts and auto-verifier.ts.
 */
export interface VerifyResultSnapshot {
  /** Result from the structured rule engine */
  structured: { passed: boolean; failures: { ruleType: string; detail: string }[] };
  /** Combined overall pass: structured.passed */
  overallPassed: boolean;
}

// ─── Flow State ──────────────────────────────────────────────────────────────

/**
 * Unified flow state for the pipeline lifecycle.
 * - "running": Pipeline is actively progressing through stages.
 * - "blocked": Pipeline is frozen due to a blocking condition; requires user decision.
 * - "aborted": Pipeline has been terminated by user action (terminal state).
 */
export type FlowState = "running" | "blocked" | "aborted";

// ─── Session Metadata ────────────────────────────────────────────────────────

/**
 * Runtime metadata stored in the pi session, tracking the pipeline's
 * current state across stage transitions and loop iterations.
 */
export interface SessionMeta {
  /** The stage currently being executed */
  currentStage: PipelineStage;

  /** The stage that was used before the current one (undefined on first stage) */
  previousStage?: PipelineStage;

  /** Unix timestamp (ms) when the current stage started */
  stageStartTime: number;

  /** Unique identifier for this pipeline run */
  pipelineId: string;

  /** Active domain configuration for the current pipeline run */
  domain: DomainConfig;

  /** Map of stage name to its summary metadata */
  summaries: Record<string, SummaryMeta>;

  /** Number of completed loop iterations within current step */
  loopCount: number;

  /** Index of the current step within the current stage */
  currentStepIndex: number;

  /** Maximum number of loop iterations before the pipeline halts */
  maxLoops: number;

  /** Context files passed between stages during handoff (stage -> file paths) */
  contextFiles?: Record<string, string[]>;

  /** Maximum number of full pipeline cycles allowed (default 3) */
  maxLoopCycles?: number;

  /** Current cycle count within a circular reference (e.g. fix→develop) */
  loopCycleCount?: number;

  /** Ordered list of stages visited (for cycle detection) */
  stageVisitOrder?: PipelineStage[];

  /**
   * @deprecated Use flowState instead. Kept for backward-compatible reading only.
   * Whether the pipeline has been terminated by the loop breaker.
   */
  terminated?: boolean;

  /**
   * @deprecated Use blockedReason instead. Kept for backward-compatible reading only.
   * Human-readable reason for termination.
   */
  terminateReason?: string;

  /**
   * Unified flow state for the pipeline lifecycle.
   * When absent, the pipeline is considered "running" (default).
   */
  flowState?: FlowState;

  /** Human-readable reason when the pipeline is in "blocked" flow state. */
  blockedReason?: string;

  /** Session-level allowed commands (user-approved for destructive command bypass) */
  sessionAllowedCommands?: string[];

  /**
   * C2 flag: set true when stage_advance successfully advances within the current turn.
   * Consumed by agent_settled to skip redundant verification (idempotent guard).
   * Cleared after agent_settled processes it, or on stage transitions.
   */
  advancedThisTurn?: boolean;

  /** Path to the requirement document loaded by /pipeline-start */
  requirementDoc?: string;

  /** Read-only record of the currently selected model (populated via model_select event) */
  currentModel?: { provider: string; modelId: string };

  /** Number of verification attempts within the current stage */
  verifyAttempts?: number;

  /** Verification failures for the current stage (populated on failed verification) */
  verifyFailures?: VerifyFailureItem[];

  /**
   * Persistent flag set when a verification config-class error is detected
   * (EISDIR, empty path, directory, unresolved requirementDoc placeholder).
   *
   * Lifecycle:
   * - Cleared on pipeline-start resume (full-und R2Q3=A-1): verify is re-run
   *   from scratch, so the skipVerify escape hatch is re-evaluated against
   *   the new run's config rather than carried over from the aborted run.
   * - Preserved on freeze → resume (decision-menu path, 141 semantics):
   *   the skipVerify escape hatch remains reachable across freeze boundaries.
   * - Cleared on stage transitions (skip/rollback/restart/advance).
   */
  verifyConfigError?: boolean;

  /** The most recent unified verification result (structured + LLM) */
  lastVerifyResult?: VerifyResultSnapshot;

  /**
   * Session-level file write allowance list (precise relative paths).
   * When a protected file is edited with the user choosing "Allow edits for this session",
   * the path is added here and subsequent edits to the same path bypass protection.
   * Cleared on pipeline quit/reset.
   */
  sessionAllowedWritePaths?: string[];

  /**
   * Tool-call violation history for the current stage.
   * Records all interception events (tool_not_allowed, bash_prefix, write_protected, git_protected).
   * Used for prompt feedback injection and overflow circuit-breaker detection.
   * Cleared on stage transitions (advance/skip/rollback/restart/resume).
   */
  violations?: ViolationItem[];
}

// ─── Protect Configuration ───────────────────────────────────────────────────

/**
 * File protection configuration for the pipeline plugin.
 * Controls which files are protected from modification and which can be exempted.
 *
 * Three-layer protection model:
 * 1. Hardcoded paths (`.pi/`, `AGENTS.md`, `.git/`) — always protected, cannot be exempted
 * 2. Dynamic gitignore protection — parsed from project `.gitignore` files
 * 3. Allow list — exempts specific paths from gitignore protection (edit only, git add/commit still blocked)
 */
export interface ProtectConfig {
  /**
   * Whether to parse `.gitignore` files for dynamic protection (default: true).
   * When enabled, files matching gitignore patterns are protected from modification.
   */
  gitignore?: boolean;

  /**
   * Additional hardcoded protected paths (merged with built-in `.pi/`, `AGENTS.md`, `.git/`).
   * These paths cannot be exempted via the `allow` list.
   */
  paths?: string[];

  /**
   * Paths exempted from gitignore dynamic protection (edit permission only).
   * Directories are normalized with trailing `/` for boundary matching.
   * Note: `allow` does NOT exempt from git add/commit operations, and does NOT
   * affect hardcoded protection (`.pi/`, `AGENTS.md`, `.git/`).
   */
  allow?: string[];

  /**
   * Whether to prompt the user via TUI when a protected path is edited (default: false).
   * When true, write/edit/bash operations hitting hardcoded or gitignore protection
   * trigger a 3-choice dialog: follow plugin default / allow this edit / allow for session.
   */
  ask?: boolean;
}

// ─── Pipeline Configuration ──────────────────────────────────────────────────

/**
 * Top-level configuration interface that projects provide to `createPipeline()`.
 * Maps each pipeline stage to its configuration and sets global pipeline options.
 */
export interface PipelineConfig {
  /** Stage-to-config mapping; all 8 stages must be defined */
  stages: Record<PipelineStage, StageConfig>;

  /** Absolute path to the project root directory */
  projectRoot: string;

  /** Optional directory for audit logs (relative to projectRoot); defaults to ".pi/audit" */
  auditDir?: string;

  /** Optional directory for domain definitions (relative to projectRoot); defaults to ".domains" */
  domainDir?: string;

  /** Maximum number of pipeline loop iterations; defaults to 3 */
  maxLoops?: number;

  /** Maximum number of full pipeline cycles (e.g. fix→develop loops); defaults to 3 */
  maxLoopCycles?: number;

  /**
   * Maximum number of verification attempts before the pipeline freezes (blocked).
   * When not set, defaults to `maxLoops` (or 3 if maxLoops is also unset).
   * Acts as a circuit-breaker for repeated verify failures within a single stage.
   */
  maxVerifyAttempts?: number;

  /**
   * KeyId for the TUI shortcut that opens the pipeline decision menu.
   * Defaults to "ctrl+enter". Must match KeyId format: modifiers (ctrl|shift|alt|super)+
   * followed by a single alphanumeric key or SpecialKey (enter|escape|tab|space|backspace|
   * delete|home|end|pageUp|pageDown|up|down|left|right|f1-f12).
   * Invalid values fall back to "ctrl+enter" with a console warning.
   */
  decisionShortcutKey?: string;

  /**
   * TUI output configuration.
   * When pipelineStage is true, pipeline stage transitions are displayed via notify + setStatus.
   * Default: true (stage transitions displayed in TUI).
   */
  output?: { pipelineStage?: boolean };

  /**
   * Enable LLM-based delivery item extraction during verify generation.
   * When true, uses pi SDK LLM (createModels + ctx.modelRegistry) to extract items
   * from skill files alongside hardcoded marker extraction. Default: false.
   */
  llmExtract?: boolean;

  /**
   * File protection configuration.
   * Controls gitignore-based protection, hardcoded paths, and allow-list exemptions.
   * Default: { gitignore: true, paths: [], allow: [] }
   */
  protect?: ProtectConfig;

  /**
   * Startup behavior mode for /pipeline-start command.
   * Controls how the pipeline handles fresh starts and aborted resumes.
   * Default: "auto" (zero-interaction, backward compatible).
   */
  startStageMode?: StartStageMode;

  /**
   * Audit configuration for prompt snapshots.
   * Controls what is recorded in the prompt snapshot audit log.
   * Default: { promptSnapshot: "full" }.
   *   - "full": Record complete systemPrompt (base + pluginPromptFull).
   *   - "plugin": Record only the plugin segment (backward compatible).
   *   - "off": Do not write prompt snapshot (zero overhead).
   */
  audit?: { promptSnapshot?: "full" | "plugin" | "off" };
}

// ─── JSON Configuration Interfaces ────────────────────────────────────────────

/**
 * Verification configuration in pipeline_loop.json.
 */
export interface VerifyJsonConfig {
  /** Whether verification is required (default true) */
  require?: boolean;

  /** Path to verify.md file (default .pi/references/{stage}_spec/verify.md) */
  verifyFile?: string;

  /** Verification trigger mode: "hook" (default) or "tool" */
  mode?: "hook" | "tool";

  /**
   * Skip re-execution of requiredCommands when the model already successfully
   * executed the same command via tool calls in the current stage. Default: false.
   */
  selfVerifySkip?: boolean;

  /**
   * Interactive completion marker text. When configured, agent_settled prechecks
   * whether this marker exists in the requirement document before running verification.
   * If not found, verification is skipped (no advance, no verifyAttempts increment).
   */
  completionMarker?: string;
}

/**
 * Per-stage configuration as defined in pipeline_loop.json.
 * All fields are optional — defaults are filled by the JSON config loader.
 */
export interface StageJsonConfig {
  /** Whether this stage is required; false removes it from the pipeline (default true) */
  require?: boolean;

  /** Path to agent definition file, relative to projectRoot (no default — must be configured explicitly) */
  agentPath?: string;

  /** Path to skill directory/file relative to `.pi/skills/` (default `{stage}/SKILL.md`) */
  skillPath?: string;

  /** Stage-level write whitelist (default depends on stage type) */
  allowedWritePaths?: string[];

  /** Next stage to transition to; null = terminal */
  nextStage?: PipelineStage | null;

  /** Whether domain context is required (default false) */
  requireDomain?: boolean;

  /** Optional verification configuration */
  verify?: VerifyJsonConfig;
}

/**
 * Top-level structure of a pipeline_loop.json file.
 * This replaces the full TypeScript PipelineConfig for simple use-cases.
 */
export interface PipelineJsonConfig {
  /** Stage definitions — only stages present in this map participate in the pipeline */
  stages: Partial<Record<PipelineStage, StageJsonConfig>>;

  /** Project root directory (default process.cwd()) */
  projectRoot?: string;

  /** Audit log directory relative to projectRoot (default ".pi/audit") */
  auditDir?: string;

  /** Domain definitions directory relative to projectRoot (default ".pi/domains") */
  domainDir?: string;

  /** Maximum loop iterations per stage (default 3) */
  maxLoops?: number;

  /** Maximum pipeline cycles (e.g. fix→develop) before termination (default 3) */
  maxLoopCycles?: number;

  /**
   * Maximum verification attempts before freezing (default: maxLoops or 3).
   * Circuit-breaker for repeated verify failures within a single stage.
   */
  maxVerifyAttempts?: number;

  /**
   * TUI shortcut KeyId to open the pipeline decision menu (default "ctrl+enter").
   * Must match KeyId format; invalid values fall back to "ctrl+enter".
   */
  decisionShortcutKey?: string;

  /** TUI output configuration (default: { pipelineStage: true }) */
  output?: { pipelineStage?: boolean };

  /** Enable LLM-based delivery item extraction during verify generation (default false) */
  llmExtract?: boolean;

  /** File protection configuration (default: { gitignore: true, paths: [], allow: [] }) */
  protect?: ProtectConfig;

  /**
   * Startup behavior mode for /pipeline-start command.
   * Controls how the pipeline handles fresh starts and aborted resumes.
   * Default: "auto" (zero-interaction, backward compatible).
   */
  startStageMode?: StartStageMode;
}

// ─── Plugin Interfaces (Stubs) ───────────────────────────────────────────────

/**
 * Internal hook interface for pi SDK lifecycle events.
 * The handler receives a RuntimeCtx (built by the registration bridge in Phase 2).
 * Concrete event types: "session_start", "before_agent_start", "tool_call", "tool_result".
 */
export interface Hook {
  /** The pi SDK event name to listen for */
  event: string;

  /** The handler function invoked when the event fires. May return a value (e.g., systemPrompt). */
  handler: (ctx: RuntimeCtx) => unknown;
}

/**
 * Internal tool interface for pi SDK custom tools.
 * The execute function receives typed args and a RuntimeCtx.
 */
export interface Tool {
  /** Unique tool name registered with pi */
  name: string;

  /** Human-readable description shown to the agent */
  description: string;

  /** JSON Schema-like parameter definition */
  parameters: Record<string, unknown>;

  /** The tool's execution function. Receives RuntimeCtx with session state adapter. */
  execute: (args: Record<string, unknown>, ctx?: RuntimeCtx) => Promise<unknown>;
}

/**
 * Internal command interface for pi SDK slash-commands.
 * The execute function receives parsed args and a RuntimeCtx.
 */
export interface Command {
  /** Unique command name (invoked as `/command`) */
  name: string;

  /** Human-readable description shown in help */
  description: string;

  /** The command's execution function */
  execute: (args: Record<string, unknown>, ctx?: RuntimeCtx) => Promise<unknown>;
}

/**
 * The pipeline plugin object returned by `createPipeline()`.
 * Contains all hooks, tools, and commands that the pi SDK should register.
 */
export interface PipelinePlugin {
  /** Event hooks for session lifecycle, prompt injection, and tool interception */
  hooks: Hook[];

  /** Custom tools registered with the pi agent */
  tools: Tool[];

  /** Custom slash-commands available to the user */
  commands: Command[];
}

// ─── Extension API (Pi SDK) ─────────────────────────────────────────────────
// ExtensionAPI is imported from @earendil-works/pi-coding-agent at the top of this file.

/**
 * Factory function signature for Pi Extension mode.
 * Receives the ExtensionAPI and registers all hooks, tools, and commands.
 */
export type ExtensionFactory = (pi: ExtensionAPI) => Promise<void>;
