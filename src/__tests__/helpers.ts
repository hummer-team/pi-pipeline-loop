import type { PipelineConfig, SessionMeta, PipelineStage, DesignReviewState } from "../types";
import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { deriveStandaloneReceiptPath } from "../core/design-review/update-artifact";
import type { RuntimeCtx } from "../core/runtime-ctx";
import { matchCommitExpectation } from "../core/session-state";
import { CONFIG_DIR_NAME, PROTECTED_PATHS } from "../constants";
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

/**
 * 194 Phase 2: deploy the assets a real `/pipeline-init` project ships and
 * the dispatch resource preflight checks — stage agent definitions, stage
 * skill files and the design-review report template — into a harness
 * projectRoot. Real-adapter tests exercise the production preflight path,
 * so they must ship the same resources. Files already written by the
 * harness are left untouched (write-if-absent).
 */
export function deployDispatchAssets(config: PipelineConfig): void {
  const root = config.projectRoot;
  const piWorkDir = config.piWorkDir ?? CONFIG_DIR_NAME;
  const agentContent = "---\nname: test-agent\ntools: read, grep, find, ls, write, edit\n---\ntest agent body\n";
  for (const stageConfig of Object.values(config.stages ?? {})) {
    const agentPath = (stageConfig as { agentPath?: unknown } | undefined)?.agentPath;
    if (typeof agentPath === "string" && agentPath.length > 0) {
      const abs = path.join(root, agentPath);
      if (!existsSync(abs)) {
        mkdirSync(path.dirname(abs), { recursive: true });
        writeFileSync(abs, agentContent, "utf8");
      }
    }
    const skillPath = (stageConfig as { skillPath?: unknown } | undefined)?.skillPath;
    if (typeof skillPath === "string" && skillPath.length > 0) {
      const abs = path.join(root, piWorkDir, "skills", skillPath);
      if (!existsSync(abs)) {
        mkdirSync(path.dirname(abs), { recursive: true });
        writeFileSync(abs, "# test skill\n", "utf8");
      }
    }
  }
  const templateAbs = path.join(root, piWorkDir, "references", "design_review_report_template.md");
  if (!existsSync(templateAbs)) {
    mkdirSync(path.dirname(templateAbs), { recursive: true });
    writeFileSync(templateAbs, "# design review report template\n", "utf8");
  }
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

// ─── 192 Phase 3: bound design-review report fixtures ─────────────────────────

/**
 * Build a design-review report content that satisfies the CURRENT trusted
 * identity contract (pipeline/plan/round/operation/input-hash rows + anchored
 * verdict + Issues section). Used by coordinator tests so fixtures deliver
 * the same contract the production verifier enforces.
 */
export function reviewReportContent(opts: {
  pipelineId: string;
  planDoc: string;
  round?: number;
  operationId: string;
  inputHash: string;
  verdict: "PASS" | "FAIL";
  /** Issue bullet lines (used for FAIL); for PASS use [] with noIssuesSentinel */
  issues?: string[];
  /** Set false to produce a structurally invalid report */
  includeIssuesSection?: boolean;
  /** Override the verdict row (e.g. omit to simulate no conclusion) */
  verdictRow?: string | null;
  /** 193 Phase 0: set false to omit the Summary section (structural negative case) */
  includeSummarySection?: boolean;
  /** 193 Phase 0: set false to omit the Recommendations section */
  includeRecommendationsSection?: boolean;
}): string {
  const round = opts.round ?? 1;
  const lines = [
    "# Design Review Report",
    "",
    `**pipeline**: ${opts.pipelineId}`,
    `**plan**: ${opts.planDoc}`,
    `**round**: ${round}`,
    `**operation**: ${opts.operationId}`,
    `**input hash**: ${opts.inputHash}`,
    "",
  ];
  // 193 Phase 0: the shared fixture produces a COMPLETE report (all four
  // contract sections) so existing behaviour tests keep exercising valid input.
  if (opts.includeSummarySection !== false) {
    lines.push(
      "## Summary",
      "",
      "Reviewed the plan against the requirement document; phase split, acceptance",
      "criteria and regression coverage are all addressed.",
      "",
    );
  }
  lines.push("## Verdict", "");
  if (opts.verdictRow !== null) {
    lines.push(opts.verdictRow ?? `**Design Review: ${opts.verdict}**`);
  }
  if (opts.includeIssuesSection !== false) {
    lines.push("", "## Issues");
    if (opts.verdict === "PASS" || (opts.issues ?? []).length === 0) {
      lines.push("None");
    } else {
      for (const [i, issue] of (opts.issues ?? []).entries()) {
        lines.push(`${i + 1}. ${issue}`);
      }
    }
  }
  if (opts.includeRecommendationsSection !== false) {
    lines.push(
      "",
      "## Recommendations",
      "",
      "Proceed with the plan as written; keep the per-phase acceptance criteria as",
      "the regression checklist.",
    );
  }
  lines.push("");
  return lines.join("\n");
}

/**
 * 194 Phase 1: a STANDALONE update receipt document body satisfying the C2
 * contract — exactly one `## Design Review Update` section with the seven
 * identity rows, `### Issue Dispositions` (one table row per issue) and
 * `### Changes Made` (entries carry a plan Phase marker so `fixed` rows pass).
 * The receipt lives OUTSIDE the plan body (the plan freezes its protocol
 * sections); tests write these bytes to the operation's pinned `receiptDoc`.
 */
export function standaloneReceiptContent(opts: {
  pipelineId: string;
  planDoc: string;
  reviewOperationId: string;
  reportDoc: string;
  round: number;
  updateOperationId: string;
  baselinePlanHash: string;
  /** One entry per consumed issue; ids are the report ordinals ("1", "2", ...) */
  dispositions: Array<{
    issueId: string;
    text?: string;
    disposition: "fixed" | "deferred" | "rejected" | "new-decision" | "unfixable";
    justification?: string;
  }>;
  /** `### Changes Made` entries (default cites Phase 2 for every fixed row) */
  changesMade?: string[];
}): string {
  const lines = [
    "# Design Review Update Receipt",
    "",
    "## Design Review Update",
    "",
    `**Pipeline**: ${opts.pipelineId}`,
    `**Plan**: ${opts.planDoc}`,
    `**Review Operation**: ${opts.reviewOperationId}`,
    `**Report**: ${opts.reportDoc}`,
    `**Round**: ${opts.round}`,
    `**Operation**: ${opts.updateOperationId}`,
    `**Baseline Hash**: ${opts.baselinePlanHash}`,
    "",
    "### Issue Dispositions",
    "",
    "| # | Issue | Disposition | Justification |",
    "|---|-------|-------------|---------------|",
  ];
  for (const d of opts.dispositions) {
    lines.push(
      `| ${d.issueId} | ${d.text ?? `issue ${d.issueId}`} | ${d.disposition} | ${d.justification ?? "addressed in the plan"} |`,
    );
  }
  lines.push("", "### Changes Made", "");
  const changes = opts.changesMade ?? opts.dispositions.map((d) => `- Issue ${d.issueId}: addressed in Phase 2 of the plan.`);
  for (const c of changes) lines.push(c);
  lines.push("");
  return lines.join("\n");
}
export function boundReviewOperation(operationId: string, inputHash: string, round?: number) {
  const now = Date.now();
  return {
    operationId,
    kind: "review" as const,
    stageVisitId: now,
    attempt: 1,
    dispatchState: "dispatched" as const,
    agentId: "agent-fixture-review",
    inputHash,
    round: round ?? 1,
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * 194 Phase 1: write BOTH deliverables a standalone-contract update produces —
 * the revised plan body (WITHOUT any protocol section) and the bounded receipt
 * at the plugin-derived path pinned by the CURRENT update operation.
 *
 * Tests that drive the real FAIL → update → settle chain call this instead of
 * hand-writing an embedded `## Design Review Update` section, which since 194
 * is a plan-body protocol violation for every new operation.
 */
export function writeStandaloneUpdateDeliverables(opts: {
  /** Absolute plan document path (the operation's bound plan) */
  planDoc: string;
  /** Persisted state holding the CURRENT update operation + input receipt */
  state: DesignReviewState;
  /** Pipeline identity row the receipt must carry */
  pipelineId: string;
  /** Revised plan body (defaults to a short, section-free revision) */
  planBody?: string;
  /** Optional per-issue label / justification builders */
  issueText?: (issueId: string) => string;
  justification?: (issueId: string) => string;
  /** `### Changes Made` entries (default: one Phase-1 line per issue) */
  changesMade?: string[];
}): { receiptDoc: string; planContent: string } {
  const updateOp = opts.state.operation;
  const receipt = opts.state.reviewInputReceipt;
  if (!updateOp || !receipt) {
    throw new Error("writeStandaloneUpdateDeliverables requires an update operation and a consumed review receipt");
  }
  const planContent =
    opts.planBody ??
    [
      "# Plan",
      "",
      "## Approach",
      "",
      `Revised design content for round ${String(opts.state.round)} (${updateOp.operationId})`,
      "addressing every listed defect.",
      "",
    ].join("\n");
  writeFileSync(opts.planDoc, planContent, "utf-8");

  const receiptDoc = deriveStandaloneReceiptPath(opts.planDoc, opts.state.round, updateOp.operationId);
  if (receiptDoc === null) {
    throw new Error(`cannot derive the standalone receipt path for round ${String(opts.state.round)}`);
  }
  writeFileSync(
    receiptDoc,
    standaloneReceiptContent({
      pipelineId: opts.pipelineId,
      planDoc: opts.planDoc,
      reviewOperationId: receipt.reviewIdentity.operationId,
      reportDoc: receipt.reportDoc,
      round: opts.state.round,
      updateOperationId: updateOp.operationId,
      baselinePlanHash: receipt.inputPlanHash,
      dispositions: receipt.issueIds.map((issueId) => ({
        issueId,
        ...(opts.issueText !== undefined ? { text: opts.issueText(issueId) } : {}),
        disposition: "fixed" as const,
        ...(opts.justification !== undefined
          ? { justification: opts.justification(issueId) }
          : {}),
      })),
      changesMade:
        opts.changesMade ??
        receipt.issueIds.map((issueId) => `- Phase 1: amended the section for defect ${issueId}.`),
    }),
    "utf-8",
  );
  return { receiptDoc, planContent };
}
