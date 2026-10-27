/**
 * 213 Phase 3: `/pipeline-resume` dispatch locks.
 *
 * Sealed behaviors (plan P3):
 * - `buildResumeMenu` per-state rows (default FIRST with "(default)", every
 *   kind ends in Cancel) and `resolveResumeMenuIntent` resolving BY INDEX —
 *   `undefined` (Esc) and unknown labels both map to `cancel`, and a
 *   "(default)"-suffixed label never fails a lookup (the doc-menu lesson);
 * - the `authorized` coordinator result matrix (7 rows): only a genuinely
 *   pending human decision ends the run with the exit sentence; `not-applicable`
 *   and a "pending" WITHOUT a menu to open continue to the lifecycle skeleton
 *   (D10 row 6 — acceptance row 4);
 * - `menuCapable` (D18) decided ONCE from the host-declared `hasUI`: a declared
 *   false wins over a present select (honest no-UI exit), a declared true
 *   without a select still fails closed inside the executor;
 * - the frozen channel and the confirm-gate priority are NOT rerouted here
 *   (covered by pipeline-resume.test.ts / pipeline-resume-menu.test.ts).
 *
 * Coordinator seam: `mock.module` wraps `coordinateDesignReview` behind a
 * delegating stub. The ORIGINAL function is captured BEFORE mocking — the
 * namespace binding is live, so reading it after `mock.module()` would return
 * the wrapper itself (self-recursion). With no stub installed the wrapper
 * delegates to the real coordinator, and `afterAll` reinstalls the captured
 * original, so other test files in the shared process see the untouched module.
 */
import { describe, it, expect, beforeEach, afterEach, afterAll, mock } from "bun:test";
import * as coordinatorReal from "../../core/design-review/coordinator";
import type { CoordinatorContext, CoordinatorResult } from "../../core/design-review/coordinator";
import { createPipelineResumeCommand } from "../../commands/pipeline-resume";
import {
  buildResumeMenu,
  resolveResumeMenuIntent,
  runningStatusMessage,
} from "../../commands/pipeline-resume-menu";
import { __setSafeWriteAuditLogOverride } from "../../utils/auditLog";
import { makeTestConfig, makeTestMeta, createMockCtx } from "../helpers";
import type { DesignReviewState, SessionMeta } from "../../types";

// ─── coordinator seam (see header) ───────────────────────────────────────────

const REAL_COORDINATOR = coordinatorReal.coordinateDesignReview;

type CoordinatorStub = (
  ctx: CoordinatorContext,
  meta: SessionMeta,
  trigger: "settle" | "advance" | "verify" | "handoff",
) => Promise<CoordinatorResult>;

let coordinatorStub: CoordinatorStub | null = null;

mock.module("../../core/design-review/coordinator", () => ({
  ...coordinatorReal,
  coordinateDesignReview: (
    ctx: CoordinatorContext,
    meta: SessionMeta,
    trigger: "settle" | "advance" | "verify" | "handoff",
  ): Promise<CoordinatorResult> =>
    coordinatorStub ? coordinatorStub(ctx, meta, trigger) : REAL_COORDINATOR(ctx, meta, trigger),
}));

afterAll(() => {
  coordinatorStub = null;
  mock.module("../../core/design-review/coordinator", () => ({
    ...coordinatorReal,
    coordinateDesignReview: REAL_COORDINATOR,
  }));
});

// ─── fixtures ────────────────────────────────────────────────────────────────

interface AuditRec {
  event: string;
  message: Record<string, unknown>;
}

interface MenuCall {
  title: string;
  options: string[];
}

let audits: AuditRec[] = [];

beforeEach(() => {
  audits = [];
  coordinatorStub = null;
  __setSafeWriteAuditLogOverride(async (event, message) => {
    audits.push({ event, message: (message ?? {}) as Record<string, unknown> });
  });
});

afterEach(() => {
  coordinatorStub = null;
  __setSafeWriteAuditLogOverride(null);
});

/** Identity-complete, authorization-valid design-review loop (classify ⇒ authorized). */
function authorizedDrState(overrides: Partial<DesignReviewState> = {}): DesignReviewState {
  return {
    schemaVersion: 1,
    planDoc: "/tmp/213-dispatch-plan.md",
    planHash: "ph-213",
    round: 1,
    authorizationId: "auth-213-dispatch",
    authorizationSource: "menu",
    phase: "review_running",
    authorizedAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_001,
    ...overrides,
  };
}

function makeDispatchMeta(overrides?: Partial<SessionMeta>): SessionMeta {
  return makeTestMeta({
    currentStage: "design-review",
    pipelineId: "pipe-213-dispatch",
    designReview: authorizedDrState(),
    ...overrides,
  });
}

/** Menu-answering context: records every presented dialog, answers from a queue. */
function makeRecordingCtx(meta: SessionMeta, answers: Array<string | undefined> = []) {
  const ctx = createMockCtx(meta);
  const calls: MenuCall[] = [];
  let idx = 0;
  ctx.ui.select = async (title: string, options: string[]) => {
    calls.push({ title, options: [...options] });
    const answer = idx < answers.length ? answers[idx] : undefined;
    idx++;
    return answer;
  };
  const notifications: string[] = [];
  ctx.ui.notify = (msg: string) => { notifications.push(msg); };
  return { ctx, calls, notifications };
}

function resultMessage(result: unknown): string {
  const message = (result as { message?: unknown }).message;
  return typeof message === "string" ? message : "";
}

// ─── pure menu construction + index resolution ──────────────────────────────

describe("213 P3: buildResumeMenu rows per lifecycle state", () => {
  const meta = makeTestMeta({ currentStage: "develop", pipelineId: "pipe-menu-1" });

  it("aborted + readable doc: restore default FIRST, new-pipeline row, Cancel last", () => {
    const menu = buildResumeMenu("aborted", meta, "docs/design/213_Req.md");
    expect(menu.options).toEqual([
      'Restore stage "develop" with "docs/design/213_Req.md" (default)',
      "Start a new pipeline at a chosen stage…",
      "Cancel",
    ]);
    expect(menu.intents.map((i) => i.kind)).toEqual([
      "restore-current-stage",
      "recreate-with-selection",
      "cancel",
    ]);
  });

  it("aborted without a resolvable doc: the default row degrades instead of inventing one", () => {
    const menu = buildResumeMenu("aborted", meta, undefined);
    expect(menu.options[0]).toBe('Restore stage "develop" (no default document)');
  });

  it("running: Continue current stage (default) / new pipeline / Cancel with matching intents", () => {
    const menu = buildResumeMenu("running", meta);
    expect(menu.options).toEqual([
      'Continue current stage "develop" (default)',
      "Start a new pipeline at a chosen stage…",
      "Cancel",
    ]);
    expect(menu.intents.map((i) => i.kind)).toEqual([
      "continue-current",
      "recreate-with-selection",
      "cancel",
    ]);
  });

  it("identity-incomplete: BOTH forward rows carry recreate — the executor distinguishes them by index", () => {
    const menu = buildResumeMenu("identity-incomplete", meta, "docs/design/213_Req.md");
    expect(menu.options[0]).toBe('Rebuild from "develop" with "docs/design/213_Req.md" (default)');
    expect(menu.options[1]).toBe("Choose another stage or document…");
    expect(menu.options[2]).toBe("Cancel");
    expect(menu.intents.map((i) => i.kind)).toEqual([
      "recreate-with-selection",
      "recreate-with-selection",
      "cancel",
    ]);
  });

  it("resolveResumeMenuIntent: undefined (Esc) and unknown labels both resolve to cancel", () => {
    const menu = buildResumeMenu("running", meta);
    expect(resolveResumeMenuIntent(menu, undefined)).toEqual({ kind: "cancel" });
    expect(resolveResumeMenuIntent(menu, "Totally unknown label")).toEqual({ kind: "cancel" });
  });

  it("resolveResumeMenuIntent maps by INDEX — a suffixed \"(default)\" label resolves, never via string equality on the bare path", () => {
    const menu = buildResumeMenu("aborted", meta, "docs/design/213_Req.md");
    // The displayed label is `… "docs/design/213_Req.md" (default)`; the bare
    // relPath is NOT an option, and selecting the suffixed row still yields
    // the restore intent (the doc-menu lesson, D14).
    expect(resolveResumeMenuIntent(menu, "docs/design/213_Req.md")).toEqual({ kind: "cancel" });
    expect(resolveResumeMenuIntent(menu, menu.options[0])).toEqual({ kind: "restore-current-stage" });
    expect(resolveResumeMenuIntent(menu, menu.options[1])).toEqual({ kind: "recreate-with-selection" });
    expect(resolveResumeMenuIntent(menu, menu.options[2])).toEqual({ kind: "cancel" });
  });

  it("runningStatusMessage is byte-identical to the pre-213 read-only notice (D4)", () => {
    const m = makeTestMeta({ currentStage: "develop", pipelineId: "pipe-status-1" });
    expect(runningStatusMessage(m)).toBe(
      "Pipeline is running (pipelineId: pipe-status-1, stage: develop, flowState: running). No resume needed.",
    );
  });
});

// ─── authorized result matrix (7 rows) ───────────────────────────────────────

describe("213 P3: authorized coordinator result matrix", () => {
  /** Runs /pipeline-resume with an authorized-loop meta + the given stub. */
  async function runMatrix(
    result: CoordinatorResult | null,
    meta: SessionMeta,
    answers: Array<string | undefined> = [],
  ): Promise<{ message: string; calls: MenuCall[]; ctx: ReturnType<typeof createMockCtx> }> {
    if (result !== null) {
      coordinatorStub = async () => result;
    }
    const h = makeRecordingCtx(meta, answers);
    const cmd = createPipelineResumeCommand(makeTestConfig());
    const out = await cmd.execute({}, h.ctx as never);
    return { message: resultMessage(out), calls: h.calls, ctx: h.ctx };
  }

  it("row 1 not-applicable ⇒ continues the lifecycle dispatch (running skeleton)", async () => {
    const r = await runMatrix({ status: "not-applicable" }, makeDispatchMeta());
    expect(r.calls[0]?.title).toContain('Pipeline is running at "design-review"');
    expect(r.message).toContain("Resume cancelled");
    expect(r.ctx.metadataUpdates.length).toBe(0);
  });

  it("row 2 advanced ⇒ existing return, no skeleton", async () => {
    const r = await runMatrix({ status: "handled", action: "advanced", toStage: "develop" }, makeDispatchMeta());
    expect(r.message).toBe('Design-review recovered: advanced to "develop".');
    expect(r.calls.length).toBe(0);
  });

  it("row 2 routed ⇒ existing return, no skeleton", async () => {
    const r = await runMatrix({ status: "handled", action: "routed", toStage: "plan" }, makeDispatchMeta());
    expect(r.message).toBe('Design-review recovered: routed to "plan".');
    expect(r.calls.length).toBe(0);
  });

  it("row 3 verify_failed ⇒ the ONE shared consumption returns, no skeleton fallthrough", async () => {
    const r = await runMatrix(
      {
        status: "handled",
        action: "verify_failed",
        failures: [{ ruleType: "designReviewReport", detail: "213 matrix probe", timestamp: Date.now() }],
      },
      makeDispatchMeta(),
    );
    expect(r.message.length).toBeGreaterThan(0);
    expect(r.calls.length).toBe(0);
    expect(r.message).not.toContain("Resume cancelled");
  });

  it("row 4 frozen ⇒ existing return (D11 budget chain untouched), no skeleton", async () => {
    const r = await runMatrix({ status: "handled", action: "frozen", reason: "budget_exceeded" }, makeDispatchMeta());
    expect(r.message).toBe("Design-review frozen: budget_exceeded");
    expect(r.calls.length).toBe(0);
  });

  it("row 5 pending WITH a decision menu ⇒ exit sentence only, no second menu (D10)", async () => {
    const meta = makeDispatchMeta({
      designReview: authorizedDrState({ phase: "paused", pauseReason: "decision-pending" }),
    });
    const snapshot = JSON.parse(JSON.stringify(meta));
    const r = await runMatrix({ status: "handled", action: "pending", reason: "decision_pending" }, meta);
    expect(r.message).toContain("Run /pipeline-resume again to take over this decision");
    expect(r.calls.length).toBe(0); // declines stay zero-write and open NO skeleton (D10)
    expect(r.ctx.metadataUpdates.length).toBe(0);
    expect(r.ctx.session.getMeta()).toEqual(snapshot);
  });

  it("row 6 pending WITHOUT a decision menu ⇒ continues to the running skeleton (stub)", async () => {
    const meta = makeDispatchMeta();
    const snapshot = JSON.parse(JSON.stringify(meta));
    const r = await runMatrix({ status: "handled", action: "pending", reason: "review_running" }, meta);
    expect(r.calls[0]?.options[0]).toBe('Continue current stage "design-review" (default)');
    expect(r.message).toContain("Resume cancelled");
    // The skeleton opens with ZERO writes; a cancelled menu changes nothing.
    expect(r.ctx.session.getMeta()).toEqual(snapshot);
  });

  it("row 6 with the REAL coordinator (valid auth + review_running) ⇒ acceptance row 4: skeleton, first row Continue, meta field-by-field unchanged", async () => {
    const meta = makeDispatchMeta();
    const snapshot = JSON.parse(JSON.stringify(meta));
    // No stub ⇒ the wrapper delegates to the real coordinator: review_running
    // with no trusted verification outcome stays pending without any write.
    const r = await runMatrix(null, meta);
    expect(r.calls[0]?.options[0]).toBe('Continue current stage "design-review" (default)');
    expect(r.message).toContain("Resume cancelled");
    expect(r.ctx.metadataUpdates.length).toBe(0);
    expect(r.ctx.session.getMeta()).toEqual(snapshot);
    // The honest pending reason is recorded by the coordinator itself.
    expect(audits.some((a) => a.event === "design_review_coordinator")).toBe(true);
  });

  it("row 7 unrecognized handled action ⇒ defensive return, never a skeleton", async () => {
    const r = await runMatrix(
      { status: "handled", action: "quantum_leap", reason: "x" } as unknown as CoordinatorResult,
      makeDispatchMeta(),
    );
    expect(r.message).toBe("Design-review recovery: unrecognized handled action.");
    expect(r.calls.length).toBe(0);
  });
});

// ─── identity-incomplete (D6) + capability gate (D18) ───────────────────────

describe("213 P3: identity-incomplete rebuild menu and the hasUI gate", () => {
  /** Identity-INCOMPLETE state (no authorizationId) ⇒ classify blocked. */
  function blockedMeta(): SessionMeta {
    return makeTestMeta({
      currentStage: "design-review",
      pipelineId: "pipe-213-blocked",
      designReview: {
        schemaVersion: 1,
        round: 1,
        phase: "review_running",
      } as unknown as DesignReviewState,
    });
  }

  it("blocked identity-incomplete + menuCapable ⇒ takeover audit gains menu_presented + rebuild skeleton", async () => {
    const meta = blockedMeta();
    const h = makeRecordingCtx(meta); // Esc ⇒ cancel
    const cmd = createPipelineResumeCommand(makeTestConfig());
    const out = await cmd.execute({}, h.ctx as never);

    const takeover = audits.find((a) => a.event === "design_review_blocked_takeover");
    expect(takeover).toBeDefined();
    expect(takeover?.message?.["reason"]).toBe("identity_incomplete");
    expect(takeover?.message?.["action"]).toBe("menu_presented");

    expect(h.calls[0]?.title).toContain('Design-review identity incomplete at "design-review"');
    expect(h.calls[0]?.options[1]).toBe("Choose another stage or document…");
    expect(resultMessage(out)).toContain("Resume cancelled");
    expect(h.ctx.metadataUpdates.length).toBe(0);
  });

  it("blocked identity-incomplete + declared hasUI false ⇒ honest no-UI exit, audit names the branch, no menu_presented", async () => {
    const meta = blockedMeta();
    const ctx = createMockCtx(meta);
    (ctx as { hasUI?: boolean }).hasUI = false; // declared capability WINS
    let selectUsed = false;
    ctx.ui.select = async () => { selectUsed = true; return undefined; };
    const cmd = createPipelineResumeCommand(makeTestConfig());
    const out = await cmd.execute({}, ctx as never);

    expect(resultMessage(out)).toContain("No interactive UI");
    expect(resultMessage(out)).toContain("/pipeline-start");
    expect(selectUsed).toBe(false);

    const takeover = audits.find((a) => a.event === "design_review_blocked_takeover");
    expect(takeover).toBeDefined();
    expect(takeover?.message?.["action"]).toBeUndefined();
    const skip = audits.find((a) => a.event === "resume_skipped_no_menu");
    expect(skip?.message?.["reason"]).toBe("no_ui");
    expect(skip?.message?.["branch"]).toBe("identity-incomplete");
    expect(ctx.metadataUpdates.length).toBe(0);
  });

  it("running + declared hasUI false ⇒ noUiExit(\"running\") even though select exists (declared wins, D18)", async () => {
    const meta = makeTestMeta({ currentStage: "develop", pipelineId: "pipe-213-declared" });
    const ctx = createMockCtx(meta);
    (ctx as { hasUI?: boolean }).hasUI = false;
    let selectUsed = false;
    ctx.ui.select = async () => { selectUsed = true; return undefined; };
    const cmd = createPipelineResumeCommand(makeTestConfig());
    const out = await cmd.execute({}, ctx as never);

    expect(resultMessage(out)).toContain("No interactive UI");
    expect(selectUsed).toBe(false);
    const skip = audits.find((a) => a.event === "resume_skipped_no_menu");
    expect(skip?.message?.["branch"]).toBe("running");
    expect(ctx.metadataUpdates.length).toBe(0);
  });

  it("running + declared hasUI true but NO select ⇒ the executor still fails closed to the no-UI exit", async () => {
    const meta = makeTestMeta({ currentStage: "develop", pipelineId: "pipe-213-noselect" });
    const ctx = createMockCtx(meta);
    (ctx as { hasUI?: boolean }).hasUI = true;
    ctx.ui.select = undefined; // declares a UI it cannot actually use
    const cmd = createPipelineResumeCommand(makeTestConfig());
    const out = await cmd.execute({}, ctx as never);

    expect(resultMessage(out)).toContain("No interactive UI");
    const skip = audits.find((a) => a.event === "resume_skipped_no_menu");
    expect(skip?.message?.["reason"]).toBe("no_ui");
    expect(skip?.message?.["branch"]).toBe("running");
    expect(ctx.metadataUpdates.length).toBe(0);
  });
});
