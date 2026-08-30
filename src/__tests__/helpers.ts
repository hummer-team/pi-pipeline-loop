import type { PipelineConfig, SessionMeta, PipelineStage } from "../types";
import type { RuntimeCtx } from "../core/runtime-ctx";
import { PROTECTED_PATHS } from "../constants";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

export const STAGE_LIST: PipelineStage[] = [
  "clarify", "plan", "develop", "review", "fix", "awaiting_human", "completed",
];

export function makeStageConfig(overrides?: Partial<Record<string, unknown>>) {
  return {
    agentPath: "./agents/test-agent.md",
    skillPath: "test-skill/SKILL.md",
    nextStage: "plan" as PipelineStage | null,
    requireDomain: false,
    ...overrides,
  };
}

/**
 * Generate a unique test projectRoot to avoid cross-test pollution
 * of the shared state source (meta.json) and audit logs.
 */
let _testProjectRootCounter = 0;
function makeUniqueTestRoot(): string {
  _testProjectRootCounter++;
  return path.join(tmpdir(), `pi-pipeline-test-${Date.now()}-${_testProjectRootCounter}`);
}

export function makeTestConfig(overrides?: Partial<PipelineConfig>): PipelineConfig {
  return {
    projectRoot: makeUniqueTestRoot(),
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
    summaries: {},
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
    /** Optional TUI confirm — injectable for confirm-mode tests */
    confirm?: (message: string) => Promise<boolean>;
  };
  toolCall: { name: string; arguments: Record<string, unknown> };
  result: { success?: boolean; exitCode?: number; error?: string } | undefined;
  /** @internal Original ExtensionContext for standalone functions (e.g., extractAssistantMessages) */
  _ctx: { sessionManager: { getBranch(): any[]; getEntries(): any[] } };
  /**
   * 138: Optional pi SDK mock for wake-up tests.
   * When provided, sendUserMessage will be tracked for assertion.
   */
  pi?: { sendUserMessage: (msg: string, opts?: Record<string, unknown>) => void };
};

export function createMockCtx(
  meta: SessionMeta,
  opts?: {
    selectReturn?: string | undefined;
    /** Confirm dialog return value (default: true when provided) */
    confirmReturn?: boolean;
    /** Whether confirm is available (default: true if confirmReturn is set) */
    hasConfirm?: boolean;
    /** 138: Optional pi mock with sendUserMessage spy for wake-up tests */
    pi?: { sendUserMessage: (msg: string, opts?: Record<string, unknown>) => void };
  },
) {
  const metadataUpdates: SessionMeta[] = [];
  const notifications: string[] = [];
  const statusCalls: { key: string; text: string }[] = [];

  const mock: MockCtx & { metadataUpdates: SessionMeta[]; notifications: string[]; statusCalls: { key: string; text: string }[] } = {
    session: {
      getMeta: () => meta,
      updateMeta: (patch: Partial<SessionMeta>) => {
        // Merge with current meta to match real session-state behavior
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
      confirm: (opts?.hasConfirm !== false && opts?.confirmReturn !== undefined)
        ? async (_message: string) => opts.confirmReturn ?? true
        : opts?.hasConfirm === false
          ? undefined
          : async (_message: string) => true,
    },
    toolCall: { name: "read", arguments: {} },
    result: undefined,
    _ctx: { sessionManager: { getBranch: () => [], getEntries: () => [] } },
    metadataUpdates,
    notifications,
    statusCalls,
  };

  // 138: Forward pi mock if provided
  if (opts?.pi) {
    mock.pi = opts.pi;
  }

  return mock;
}

/**
 * Return a type-complete RuntimeCtx test mock.
 * MockCtx structure does not satisfy RuntimeCtx (real ExtensionUIContext/ExtensionContext
 * have many members). This helper centralizes the unsafe cast in one place so call sites
 * need not use `as any`.
 *
 * The return type intersects RuntimeCtx with the mock-specific assertion helpers
 * (metadataUpdates/notifications/statusCalls) so tests can assert on call history
 * while still passing the ctx as RuntimeCtx to production code.
 */
export type MockRuntimeCtx = RuntimeCtx & {
  metadataUpdates: SessionMeta[];
  notifications: string[];
  statusCalls: { key: string; text: string }[];
};

export function createMockRuntimeCtx(
  meta: SessionMeta,
  opts?: Parameters<typeof createMockCtx>[1],
): MockRuntimeCtx {
  return createMockCtx(meta, opts) as unknown as MockRuntimeCtx;
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

/**
 * Write a pipeline-stage-prompt.yml file to the project's .pi/references/ directory.
 * Shared helper to avoid duplicate definitions across test files.
 */
export async function writePromptYml(projectRoot: string, content: string): Promise<void> {
  const refsDir = join(projectRoot, ".pi", "references");
  await mkdir(refsDir, { recursive: true });
  await writeFile(join(refsDir, "pipeline-stage-prompt.yml"), content, "utf-8");
}
