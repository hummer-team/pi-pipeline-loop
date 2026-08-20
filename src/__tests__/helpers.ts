import type { PipelineConfig, SessionMeta, PipelineStage } from "../types";
import { PROTECTED_PATHS } from "../constants";

export const STAGE_LIST: PipelineStage[] = [
  "clarify", "plan", "develop", "review", "fix", "awaiting_human", "completed",
];

export function makeStageConfig(overrides?: Partial<Record<string, unknown>>) {
  return {
    agentFile: "./agents/test-agent.md",
    skillPath: "test-skill/SKILL.md",
    allowedTools: ["read", "bash", "write", "edit", "generate_stage_summary", "validate_summary", "pipeline_handoff", "stage_advance", "loop_check", "pipeline_state"],
    allowedBashPrefixes: ["ls", "npm", "bun", "git", "cat"],
    nextStage: "plan" as PipelineStage | null,
    requireDomain: false,
    ...overrides,
  };
}

export function makeTestConfig(overrides?: Partial<PipelineConfig>): PipelineConfig {
  return {
    projectRoot: "/tmp/test-pipeline",
    stages: Object.fromEntries(STAGE_LIST.map((s, i) => [s, makeStageConfig({ nextStage: STAGE_LIST[i + 1] ?? null })])),
    maxLoops: 3,
    auditDir: ".pi/audit",
    domainDir: ".pi/domains",
    output: { pipelineStage: true },
    protect: { gitignore: true, paths: [], allow: [] },
    ...overrides,
  } as PipelineConfig;
}

export function makeTestMeta(overrides?: Partial<SessionMeta>): SessionMeta {
  return {
    currentStage: "develop",
    previousStage: "plan",
    stageStartTime: Date.now(),
    pipelineId: "pipe-test-001",
    domain: { id: "general", version: "latest", skillPath: "/tmp/domain.md" },
    summaries: { plan: { path: "/tmp/summary.md", hash: "abc123", status: "valid" } },
    loopCount: 0,
    currentStepIndex: 0,
    maxLoops: 3,
    ...overrides,
  };
}

export type MockCtx = {
  session: {
    getMeta: () => SessionMeta;
    updateMeta: (patch: Partial<SessionMeta>) => SessionMeta;
  };
  ui: {
    notify: (msg: string) => void;
    setStatus: (key: string, text: string) => void;
    /** Optional TUI select — injectable for ask-protect tests */
    select?: (message: string, options: string[]) => Promise<string | undefined>;
  };
  toolCall: { name: string; arguments: Record<string, unknown> };
  result: { success?: boolean; exitCode?: number; error?: string } | undefined;
  /** @internal Original ExtensionContext for standalone functions (e.g., extractAssistantMessages) */
  _ctx: { sessionManager: { getBranch(): any[]; getEntries(): any[] } };
};

export function createMockCtx(meta: SessionMeta, opts?: { selectReturn?: string | undefined }): MockCtx & { metadataUpdates: SessionMeta[]; notifications: string[]; statusCalls: { key: string; text: string }[] } {
  const metadataUpdates: SessionMeta[] = [];
  const notifications: string[] = [];
  const statusCalls: { key: string; text: string }[] = [];

  return {
    session: {
      getMeta: () => meta,
      updateMeta: (patch: Partial<SessionMeta>) => {
        const merged = { ...meta, ...patch };
        metadataUpdates.push(merged);
        Object.assign(meta, merged);
        return merged;
      },
    },
    ui: {
      notify: (msg: string) => {
        notifications.push(msg);
      },
      setStatus: (key: string, text: string) => {
        statusCalls.push({ key, text });
      },
      select: opts?.selectReturn !== undefined
        ? async (_message: string, _options: string[]) => opts.selectReturn
        : async (_message: string, _options: string[]) => undefined,
    },
    toolCall: { name: "read", arguments: {} },
    result: undefined,
    _ctx: { sessionManager: { getBranch: () => [], getEntries: () => [] } },
    metadataUpdates,
    notifications,
    statusCalls,
  };
}

/**
 * Minimal mock of ExtensionContext.sessionManager for testing SessionState
 * and extractAssistantMessages.
 *
 * @param entries - Array of session entries to return from both getEntries() and getBranch()
 */
export function makeMockSessionManager(entries: unknown[] = []) {
  return {
    getEntries: () => entries as any[],
    getBranch: () => entries as any[],
  };
}

export { PROTECTED_PATHS };
