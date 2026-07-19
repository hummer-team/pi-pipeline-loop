/**
 * @module types
 * Project-agnostic type definitions for the pi pipeline loop plugin.
 * These types define the stage-based orchestration model, session metadata,
 * and configuration interfaces that projects use to customize their pipeline.
 */

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
  allowedTools: string[];

  /** List of bash command prefixes permitted in this stage (e.g., ["npm test", "git"]) */
  allowedBashPrefixes: string[];

  /**
   * The next stage to transition to after this stage completes.
   * `null` indicates this is the terminal stage (pipeline ends).
   */
  nextStage: PipelineStage | null;

  /** Whether this stage requires a domain context to be loaded */
  requireDomain: boolean;
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

// ─── Session Metadata ────────────────────────────────────────────────────────

/**
 * Runtime metadata stored in the pi session, tracking the pipeline's
 * current state across stage transitions and loop iterations.
 */
export interface SessionMeta {
  /** The stage currently being executed */
  currentStage: PipelineStage;

  /** The stage that was executed before the current one (undefined on first stage) */
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
  execute: (args: Record<string, unknown>) => Promise<unknown>;
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
}

/**
 * Factory function signature for Pi Extension mode.
 * Receives the ExtensionAPI and registers all hooks, tools, and commands.
 */
export type ExtensionFactory = (pi: ExtensionAPI) => Promise<void>;
