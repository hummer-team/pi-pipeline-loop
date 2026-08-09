import type { PipelineConfig, SessionMeta, PipelineStage } from "../types";
import { PROTECTED_PATHS } from "../constants";

export const STAGE_LIST: PipelineStage[] = [
  "clarify", "design", "plan", "develop", "review", "fix", "awaiting_human", "completed",
];

export function makeStageConfig(overrides?: Partial<Record<string, unknown>>) {
  return {
    agentFile: "./agents/test-agent.md",
    skillPath: "test-skill/SKILL.md",
    allowedTools: ["read", "bash", "write", "edit", "generate_stage_summary", "validate_summary", "pipeline_handoff", "stage_advance", "loop_check", "pipeline_state"],
    allowedBashPrefixes: ["ls", "npm", "bun", "git", "cat"],
    nextStage: "design" as PipelineStage | null,
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
    getMetadata: () => SessionMeta;
    updateMetadata: (meta: SessionMeta) => void;
    setModel: (model: string) => Promise<void>;
  };
  ui: { notify: (msg: string) => void; setStatus: (key: string, text: string) => void };
  toolCall: { name: string; arguments: Record<string, unknown> };
  result: { success?: boolean; exitCode?: number; error?: string } | undefined;
};

export function createMockCtx(meta: SessionMeta): MockCtx & { metadataUpdates: SessionMeta[]; notifications: string[]; statusCalls: { key: string; text: string }[] } {
  const metadataUpdates: SessionMeta[] = [];
  const notifications: string[] = [];
  const statusCalls: { key: string; text: string }[] = [];

  return {
    session: {
      getMetadata: () => meta,
      updateMetadata: (newMeta: SessionMeta) => {
        metadataUpdates.push(newMeta);
        Object.assign(meta, newMeta);
      },
      setModel: async (_model: string) => {},
    },
    ui: {
      notify: (msg: string) => {
        notifications.push(msg);
      },
      setStatus: (key: string, text: string) => {
        statusCalls.push({ key, text });
      },
    },
    toolCall: { name: "read", arguments: {} },
    result: undefined,
    metadataUpdates,
    notifications,
    statusCalls,
  };
}

export { PROTECTED_PATHS };
