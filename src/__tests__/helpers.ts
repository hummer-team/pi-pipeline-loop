import type { PipelineConfig, SessionMeta, PipelineStage } from "../types";
import type { RuntimeCtx } from "../core/runtime-ctx";
import { matchCommitExpectation } from "../core/session-state";
import { PROTECTED_PATHS } from "../constants";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

export const STAGE_LIST: PipelineStage[] = [
  "clarify", "plan", "design-review", "develop", "review", "fix", "awaiting_human", "completed",
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

/**
 * 192 Phase 1: strict-capable in-memory session fixture for design-review
 * tests. Mirrors the production `updateMetaVerified` semantics using the
 * SAME production expectation-comparison (matchCommitExpectation) — the
 * fixture simulates a HEALTHY shared store (persisted read-back) and honest
 * conflict reporting. Adapters without this interface are reported
 * `unavailable` by the domain commit paths (fail-closed), so any test
 * exercising strict commits must use this (or the real adapter).
 */
export function makeStrictSession(
  initial: SessionMeta,
  opts?: { appendFails?: boolean; writeFails?: boolean },
) {
  let meta: SessionMeta = { ...initial };
  const session = {
    getMeta: () => meta,
    updateMeta: (patch: Partial<SessionMeta>) => {
      meta = { ...meta, ...patch };
      return meta;
    },
    updateMetaVerified(
      patch: Partial<SessionMeta>,
      expected: import("../core/session-state").MetaCommitExpectation,
    ): import("../types").ReliableMetaCommitResult {
      // Simulated local append failure
      if (opts?.appendFails) {
        return { status: "unavailable", reason: "local_append_failed" };
      }
      if (opts?.writeFails) {
        return { status: "unavailable", reason: "shared_write_failed" };
      }
      const conflict = matchCommitExpectation(meta, expected);
      if (conflict) {
        return { status: "conflict", reason: conflict };
      }
      const merged: SessionMeta = { ...meta, ...patch };
      meta = merged;
      // read-back verification (healthy shared store echoes the write)
      const readBack: SessionMeta = { ...meta };
      meta = readBack;
      if (patch.designReview) {
        const want = patch.designReview;
        const got = readBack.designReview;
        if (
          !got
          || got.authorizationId !== want.authorizationId
          || got.round !== want.round
          || got.phase !== want.phase
          || (want.operation?.operationId ?? undefined) !== (got.operation?.operationId ?? undefined)
        ) {
          return { status: "unavailable", reason: "readback_identity_mismatch" };
        }
      }
      return { status: "persisted", meta: readBack };
    },
  };
  return session;
}

export type StrictMockSession = ReturnType<typeof makeStrictSession>;

export type MockCtx = {
  session: {
    getMeta: () => SessionMeta;
    updateMeta: (patch: Partial<SessionMeta>) => SessionMeta;
    /** 192 Phase 1: strict-capable commit used by design-review domain paths */
    updateMetaVerified: (
      patch: Partial<SessionMeta>,
      expected: import("../core/session-state").MetaCommitExpectation,
    ) => import("../types").ReliableMetaCommitResult;
  };
  ui: {
    notify: (msg: string) => void;
    /** `undefined` is the delete call used by the move-to-end status writer */
    setStatus: (key: string, text: string | undefined) => void;
    /** Optional TUI select — injectable for ask-protect tests */
    select?: (message: string, options: string[]) => Promise<string | undefined>;
    /** Optional TUI confirm — injectable for confirm-mode tests */
    confirm?: (message: string) => Promise<boolean>;
  };
  toolCall: { name: string; arguments: Record<string, unknown> };
  result: { success?: boolean; exitCode?: number; error?: string } | undefined;
  /** @internal Original ExtensionContext for standalone functions (e.g., extractAssistantMessages) */
  _ctx: {
    sessionManager: {
      getBranch(): unknown[];
      getEntries(): unknown[];
      getHeader?(): Record<string, unknown> | undefined;
      getSessionName?(): string;
      getSessionFile?(): string;
    };
  };
  /**
   * 138: Optional pi SDK mock for wake-up tests.
   * When provided, sendUserMessage will be tracked for assertion.
   */
  pi?: { sendUserMessage: (msg: string, opts?: Record<string, unknown>) => void };
  /** Raw event object (for session_start reason detection) */
  event?: Record<string, unknown>;
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
    /** Session manager header override (for JOIN detection tests) */
    sessionHeader?: Record<string, unknown>;
    /** Session name override (for JOIN detection tests) */
    sessionName?: string;
    /** Session file override (for registry tests) */
    sessionFile?: string;
    /** Raw event override (for fork detection tests) */
    event?: Record<string, unknown>;
  },
) {
  const metadataUpdates: SessionMeta[] = [];
  const notifications: string[] = [];
  const statusCalls: { key: string; text: string | undefined }[] = [];

  const mock: MockCtx & { metadataUpdates: SessionMeta[]; notifications: string[]; statusCalls: { key: string; text: string | undefined }[] } = {
    session: {
      getMeta: () => meta,
      updateMeta: (patch: Partial<SessionMeta>) => {
        // Merge with current meta to match real session-state behavior
        const merged = { ...meta, ...patch };
        metadataUpdates.push(merged);
        Object.assign(meta, merged);
        return merged;
      },
      // 192 Phase 1: strict-capable commit with the SAME production
      // expectation comparison; simulates a healthy shared store.
      updateMetaVerified: (
        patch: Partial<SessionMeta>,
        expected: import("../core/session-state").MetaCommitExpectation,
      ): import("../types").ReliableMetaCommitResult => {
        const conflict = matchCommitExpectation(meta, expected);
        if (conflict) {
          return { status: "conflict", reason: conflict };
        }
        const merged = { ...meta, ...patch };
        metadataUpdates.push(merged);
        Object.assign(meta, merged);
        return { status: "persisted", meta };
      },
    },
    ui: {
      notify: (msg: string) => {
        notifications.push(msg);
      },
      setStatus: (key: string, text: string | undefined) => {
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
    _ctx: {
      sessionManager: {
        getBranch: () => [] as unknown[],
        getEntries: () => [] as unknown[],
        getHeader: opts?.sessionHeader ? () => opts.sessionHeader! : undefined,
        getSessionName: opts?.sessionName ? () => opts.sessionName! : undefined,
        getSessionFile: opts?.sessionFile ? () => opts.sessionFile! : undefined,
      },
    },
    metadataUpdates,
    notifications,
    statusCalls,
  };

  // 138: Forward pi mock if provided
  if (opts?.pi) {
    mock.pi = opts.pi;
  }

  // Forward event for session_start reason detection
  if (opts?.event) {
    mock.event = opts.event;
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
  statusCalls: { key: string; text: string | undefined }[];
};

/**
 * Reads the FINAL status text written for a key from a captured `setStatus`
 * call history.
 *
 * The move-to-end writer emits `setStatus(key, undefined)` followed by
 * `setStatus(key, message)`. Assertions that only care about the resulting text
 * (rather than the full call sequence) should use this helper instead of
 * `find`, which would return the leading delete call.
 *
 * @param calls - Captured setStatus calls in order
 * @param key - Status key to inspect
 * @returns The text of the last call for the key, or undefined when never called
 */
export function finalStatusText(
  calls: Array<{ key: string; text?: string }>,
  key: string,
): string | undefined {
  for (let i = calls.length - 1; i >= 0; i--) {
    if (calls[i].key === key) return calls[i].text;
  }
  return undefined;
}

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

/**
 * Phase 0 (189): Extracted mock EventBus factory for cross-file reuse.
 * Creates a programmable mock EventBus where handlers registered via on()
 * can be triggered manually for testing event-driven flows.
 *
 * @returns Mock EventBus with emit/on/off/trigger/emitted/handlers
 */
export function createMockEventBus() {
  const handlers = new Map<string, Array<(payload: unknown) => void>>();
  const emitted: Array<{ event: string; payload: Record<string, unknown> }> = [];

  return {
    emit(event: string, payload: Record<string, unknown>): void {
      emitted.push({ event, payload });
    },
    on(event: string, handler: (payload: unknown) => void): void {
      const list = handlers.get(event) || [];
      list.push(handler);
      handlers.set(event, list);
    },
    off(event: string, handler: (payload: unknown) => void): void {
      const list = handlers.get(event);
      if (list) {
        const idx = list.indexOf(handler);
        if (idx >= 0) list.splice(idx, 1);
      }
    },
    /** Trigger all handlers for a channel with a payload */
    trigger(event: string, payload: unknown): void {
      const list = handlers.get(event);
      if (list) {
        for (const h of [...list]) h(payload);
      }
    },
    /** Access emitted events for assertion */
    emitted,
    /** Access registered handlers */
    handlers,
  };
}
