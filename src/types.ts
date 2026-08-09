/**
 * @module types
 * Project-agnostic type definitions for the pi pipeline loop plugin.
 * These types define the stage-based orchestration model, session metadata,
 * and configuration interfaces that projects use to customize their pipeline.
 */

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

// ─── Pipeline Stages ─────────────────────────────────────────────────────────

/**
 * Union type of all 8 pipeline stages.
 * Each stage represents a distinct phase in the agent's workflow loop.
 */
export type PipelineStage =
  | "clarify"
  | "design"
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
}

/**
 * Per-stage configuration that maps a pipeline stage to its agent, skill,
 * tool restrictions, and transition rules.
 */
export interface StageConfig {
  /** Path to the agent definition file (relative to projectRoot) */
  agentFile: string;

  /** Path to the skill directory or file for this stage (relative to projectRoot) */
  skillPath: string;

  /** Optional model override for this stage (e.g., "claude-sonnet-4-20250514", "gpt-4o") */
  model?: string;

  /** List of tool names the agent is allowed to use in this stage */
  allowedTools?: string[];

  /** List of bash command prefixes permitted in this stage (e.g., ["npm test", "git"]) */
  allowedBashPrefixes?: string[];

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

  /** Validation status */
  status: "pending" | "valid" | "invalid";
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
 * A self-contained snapshot of the unified verification result.
 * Mirrors the full VerifyResult type from auto-verifier without importing it,
 * avoiding circular dependencies between types.ts and auto-verifier.ts.
 */
export interface VerifyResultSnapshot {
  /** Result from the structured rule engine */
  structured: { passed: boolean; failures: { ruleType: string; detail: string }[] };
  /** Result from the LLM flexible verification layer (null if not run) */
  llm: { passed: boolean; reasoning: string; instructions: { checkType: string; target: string; expected?: string }[] } | null;
  /** Combined overall pass: structured.passed && (llm === null || llm.passed) */
  overallPassed: boolean;
}

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

  /** Whether the pipeline has been terminated by the loop breaker */
  terminated?: boolean;

  /** Human-readable reason for termination */
  terminateReason?: string;

  /** Session-level temporary bash prefix overrides (user-approved) */
  tempAllowedBash?: string[];

  /** Path to the requirement document loaded by /pipeline_start */
  requirementDoc?: string;

  /** Cached assistant messages for the current stage (auto-verifier) */
  assistantMessages?: string[];

  /** Number of verification attempts within the current stage */
  verifyAttempts?: number;

  /** Verification failures for the current stage (populated on failed verification) */
  verifyFailures?: VerifyFailureItem[];

  /** The most recent unified verification result (structured + LLM) */
  lastVerifyResult?: VerifyResultSnapshot;
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

  /** Optional directory for audit logs (relative to projectRoot); defaults to ".audit" */
  auditDir?: string;

  /** Optional directory for domain definitions (relative to projectRoot); defaults to ".domains" */
  domainDir?: string;

  /** Maximum number of pipeline loop iterations; defaults to 3 */
  maxLoops?: number;

  /** Maximum number of full pipeline cycles (e.g. fix→develop loops); defaults to 3 */
  maxLoopCycles?: number;
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
}

/**
 * Per-stage configuration as defined in pipeline_loop.json.
 * All fields are optional — defaults are filled by the JSON config loader.
 */
export interface StageJsonConfig {
  /** Whether this stage is required; false removes it from the pipeline (default true) */
  require?: boolean;

  /** Path to agent definition file (default .pi/agents/{stage}/{stage}.md) */
  agentFile?: string;

  /** Path to skill directory/file (default .pi/skills/{stage}/SKILL.md) */
  skillPath?: string;

  /** Optional model override for this stage */
  model?: string;

  /** Allowed tool names (default depends on stage type) */
  allowedTools?: string[];

  /** Allowed bash command prefixes (default depends on stage type) */
  allowedBashPrefixes?: string[];

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
}

// ─── Plugin Interfaces (Stubs) ───────────────────────────────────────────────

/**
 * Stub interface for a pi SDK event hook.
 * Uses `any` for ctx and return type since the pi SDK types are not installed.
 * Concrete event types: "session_start", "before_agent_start", "tool_call", "tool_result".
 */
export interface Hook {
  /** The pi SDK event name to listen for */
  event: string;

  /** The handler function invoked when the event fires. May return a value (e.g., systemPrompt). */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  handler: (ctx: any) => any;
}

/**
 * Stub interface for a pi SDK custom tool.
 * Will be populated with concrete parameter schemas in Phase 2.
 */
export interface Tool {
  /** Unique tool name registered with pi */
  name: string;

  /** Human-readable description shown to the agent */
  description: string;

  /** JSON Schema-like parameter definition */
  parameters: Record<string, unknown>;

  /** The tool's execution function. Optional ctx provides session context from the pi SDK. */
  execute: (args: Record<string, unknown>, ctx?: any) => Promise<unknown>;
}

/**
 * Stub interface for a pi SDK custom command.
 * Will be populated with concrete command logic in Phase 3.
 */
export interface Command {
  /** Unique command name (invoked as `/command`) */
  name: string;

  /** Human-readable description shown in help */
  description: string;

  /** The command's execution function */
  execute: (args: Record<string, unknown>, ctx?: any) => Promise<unknown>;
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

/**
 * Stub interface for the Pi SDK Extension API.
 * Provides methods to register event hooks, tools, and commands
 * directly with the Pi runtime in Extension mode.
 *
 * Uses `any` for ctx since the pi SDK types are not installed locally.
 */
export interface ExtensionAPI {
  /** Register an event handler for a Pi SDK lifecycle event */
  on(event: string, handler: (ctx: any) => any): void;

  /** Register a custom tool with the Pi agent */
  registerTool(
    name: string,
    description: string,
    parameters: Record<string, unknown>,
    execute: (args: Record<string, unknown>, ctx?: any) => Promise<unknown>,
  ): void;

  /** Register a custom slash-command */
  registerCommand(
    name: string,
    description: string,
    execute: (args: Record<string, unknown>, ctx?: any) => Promise<unknown>,
  ): void;

  /**
   * Execute a shell command through the pi SDK sandbox.
   * Optional — not all pi SDK versions expose this method.
   */
  exec?(
    command: string,
    args?: string[],
    options?: { cwd?: string },
  ): Promise<{ stdout: string; stderr: string; code: number }>;
}

/**
 * Factory function signature for Pi Extension mode.
 * Receives the ExtensionAPI and registers all hooks, tools, and commands.
 */
export type ExtensionFactory = (pi: ExtensionAPI) => Promise<void>;
