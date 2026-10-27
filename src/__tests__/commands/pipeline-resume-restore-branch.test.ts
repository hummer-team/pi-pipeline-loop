/**
 * 213_Bug code review round 1 (issue 1, High): `runRestoreBranch` sub-branch
 * coverage — Plan Phase 3 acceptance item 4 ("授权门拒绝 ⇒ meta 逐字段不变")
 * and unit-boundary item 1 ("RESUMABLE_STAGES 外的 aborted ⇒ 走新建骨架").
 *
 * The previously ZERO-covered arms (grep `runRestoreBranch | Cannot restore
 * design-review | gate_commit_failed` found no test):
 *  ① real authorisation gate REFUSAL ⇒ "Cannot restore design-review: …" and
 *    the meta byte-for-byte unchanged (deep-equal);
 *  ② gate GRANTED ⇒ ONE strict commit (designReview rebound, designReviewRecheck
 *    cleared) and `resumePipeline` entered with reason `resume_menu_restore`;
 *  ③ granted but the strict commit CONFLICTS ⇒ error-level
 *    `design_review_authorisation{action:"gate_commit_failed",
 *    source:"resume_menu_restore"}` and ZERO restore (no resumePipeline);
 *  ④ `completed` (outside RESUMABLE_STAGES) + aborted ⇒ degrades to the
 *    new-pipeline branch (the stage menu opens first; cancel ⇒ zero writes).
 *
 * Seam policy (the established 213 P3/P4 pattern): `designReviewAuthorisationGate`
 * and `resumePipeline` are wrapped by `mock.module` delegators — the ORIGINALS
 * are captured BEFORE mocking (namespace bindings are live; reading them after
 * `mock.module()` would return the wrapper itself), no stub installed ⇒ the REAL
 * implementation runs, and `afterAll` reinstalls the captured originals so other
 * test files in the shared process see untouched modules.
 *
 * Case ① deliberately uses the REAL gate: `requirement_doc_missing` is its
 * zero-UI fast arm, so the refusal + zero-side-effect claim is verified against
 * production code, not a stub.
 */
import { describe, it, expect, beforeEach, afterEach, afterAll, mock } from "bun:test";
import * as authorizationReal from "../../core/design-review/authorization";
import type { AuthorisationGateResult } from "../../core/design-review/authorization";
import * as pipelineStartReal from "../../commands/pipeline-start";
import {
  runRestoreBranch,
  type ResumeExecContext,
  type ResumeMenuDeps,
} from "../../commands/pipeline-resume-menu";
import type { RuntimeCtx } from "../../core/runtime-ctx";
import { createPipelineUI } from "../../core/pipeline-ui";
import { matchCommitExpectation } from "../../core/session-state";
import type { MetaCommitExpectation } from "../../core/session-state";
import { __setSafeWriteAuditLogOverride } from "../../utils/auditLog";
import { makeTestConfig, makeTestMeta } from "../helpers";
import type {
  DesignReviewState,
  PipelineConfig,
  ReliableMetaCommitResult,
  SessionMeta,
} from "../../types";

// Captured BEFORE any mock.module() call (see header).
const REAL_GATE = authorizationReal.designReviewAuthorisationGate;
const REAL_RESUME_PIPELINE = pipelineStartReal.resumePipeline;

// ─── seams ───────────────────────────────────────────────────────────────────

type GateStub = (
  ctx: RuntimeCtx,
  config: PipelineConfig,
  meta: SessionMeta,
) => Promise<AuthorisationGateResult>;

let gateStub: GateStub | null = null;

interface ResumeCall {
  file: string;
  reason: string;
}
let resumeCalls: ResumeCall[] = [];

mock.module("../../core/design-review/authorization", () => ({
  ...authorizationReal,
  designReviewAuthorisationGate: (
    ctx: RuntimeCtx,
    config: PipelineConfig,
    meta: SessionMeta,
  ): Promise<AuthorisationGateResult> =>
    gateStub ? gateStub(ctx, config, meta) : REAL_GATE(ctx, config, meta),
}));

mock.module("../../commands/pipeline-start", () => ({
  ...pipelineStartReal,
  resumePipeline: (
    ctx: unknown,
    meta: SessionMeta,
    config: PipelineConfig,
    ui: ReturnType<typeof createPipelineUI>,
    file: string,
    reason: string,
    forwardArgs?: string,
  ) => {
    // The RESTORE branch is the only production caller exercised here; the
    // recorder stands in for the real execution unit so the resumed dispatch
    // chain never runs. `file`/`reason` are the fields under test.
    void ctx;
    void config;
    void ui;
    void forwardArgs;
    resumeCalls.push({ file, reason });
    return Promise.resolve({
      success: true,
      message: "stubbed resume executed",
      pipelineId: meta.pipelineId,
      currentStage: meta.currentStage,
    });
  },
}));

afterAll(() => {
  // Reinstall the captured originals for the shared process (dispatch-file pattern).
  mock.module("../../core/design-review/authorization", () => ({
    ...authorizationReal,
    designReviewAuthorisationGate: REAL_GATE,
  }));
  mock.module("../../commands/pipeline-start", () => ({
    ...pipelineStartReal,
    resumePipeline: REAL_RESUME_PIPELINE,
  }));
});

// ─── audit capture ───────────────────────────────────────────────────────────

interface AuditRec {
  event: string;
  message: Record<string, unknown>;
  level: string | undefined;
}

let audits: AuditRec[] = [];

beforeEach(() => {
  audits = [];
  resumeCalls = [];
  gateStub = null;
  __setSafeWriteAuditLogOverride(async (event, message, level) => {
    audits.push({ event, message: (message ?? {}) as Record<string, unknown>, level });
  });
});

afterEach(() => {
  __setSafeWriteAuditLogOverride(null);
});

// ─── harness (in-place strict session, the 213 P3 new-branch pattern) ────────

interface MenuCall {
  title: string;
  options: string[];
}

function makeHarness(
  meta: SessionMeta,
  config: PipelineConfig,
  answers: Array<string | undefined> = [],
  opts: { verifyConflict?: string } = {},
) {
  const calls: MenuCall[] = [];
  const updates: Array<Partial<SessionMeta>> = [];
  const notifications: string[] = [];
  let idx = 0;

  const session = {
    getMeta: (): SessionMeta => meta,
    updateMeta: (patch: Partial<SessionMeta>): SessionMeta => {
      Object.assign(meta, patch);
      updates.push({ ...patch });
      return meta;
    },
    updateMetaVerified: (
      patch: Partial<SessionMeta>,
      expected: MetaCommitExpectation,
    ): ReliableMetaCommitResult => {
      if (opts.verifyConflict !== undefined) {
        return { status: "conflict", reason: opts.verifyConflict };
      }
      // Healthy store: the SAME production comparison (makeStrictSession lesson).
      const conflict = matchCommitExpectation(meta, expected);
      if (conflict) return { status: "conflict", reason: conflict };
      Object.assign(meta, patch);
      updates.push({ ...patch });
      return { status: "persisted", meta };
    },
  };

  const ctx: ResumeExecContext = {
    session,
    ui: {
      notify: (msg: string) => {
        notifications.push(msg);
      },
      setStatus: () => {},
      select: async (title: string, options: string[]) => {
        calls.push({ title, options: [...options] });
        const answer = idx < answers.length ? answers[idx] : undefined;
        idx++;
        return answer;
      },
    },
    _ctx: { sessionManager: { getSessionFile: () => undefined } },
  };

  return {
    deps: { ctx, config, ui: createPipelineUI(config), meta } as ResumeMenuDeps,
    calls,
    updates,
    notifications,
    current: () => meta,
  };
}

/** A valid-ish granted state for the gate stub — identity fields only. */
const AUTH_STATE: DesignReviewState = {
  schemaVersion: 1,
  planDoc: "/abs/docs/design/213_Plan.md",
  authorizationId: "auth-restore-branch-test",
  authorizationSource: "menu",
  round: 1,
  phase: "review_ready",
  authorizedAt: 1_700_000_000_000,
  updatedAt: 1_700_000_000_000,
};

// ─── ① real gate refusal: zero-side-effect, byte-identical meta ─────────────

describe("213 review issue 1: runRestoreBranch — design-review authorisation gate", () => {
  it("REAL gate refusal (requirement_doc_missing): 'Cannot restore design-review' sentence and the meta byte-for-byte unchanged", async () => {
    const config = makeTestConfig();
    const meta = makeTestMeta({
      currentStage: "design-review",
      previousStage: "plan",
      pipelineId: "pipe-213-rb-refuse",
      flowState: "aborted",
      terminateReason: "session_quit",
      // no requirementDoc ⇒ the gate's zero-UI fast arm rejects
    });
    const snapshot = JSON.parse(JSON.stringify(meta));
    const h = makeHarness(meta, config);

    const result = await runRestoreBranch(h.deps);

    expect(result.changed).toBe(false);
    expect(result.message).toContain("Cannot restore design-review:");
    expect(result.message).toContain("requirement_doc_missing");
    expect(result.message).toContain("Nothing was changed");
    // Deep-equal proof: NOTHING moved — no strict commit, no resume execution.
    expect(JSON.parse(JSON.stringify(h.current()))).toEqual(snapshot);
    expect(h.updates.length).toBe(0);
    expect(resumeCalls.length).toBe(0);
    expect(h.calls.length).toBe(0); // no dialog was ever opened
    // The real gate's own honest rejection is in the log (fact, not stub).
    expect(
      audits.some(
        (a) =>
          a.event === "design_review_authorisation_gate" &&
          a.message.result === "rejected_no_requirement_doc",
      ),
    ).toBe(true);
  });
});

// ─── ② granted: ONE strict commit + resume with the restore reason ──────────

describe("213 review issue 1: runRestoreBranch — granted gate enters the strict commit + restore", () => {
  it("gate granted: ONE strict commit rebinds designReview / clears designReviewRecheck, then resumePipeline runs with reason resume_menu_restore", async () => {
    const config = makeTestConfig();
    const meta = makeTestMeta({
      currentStage: "design-review",
      previousStage: "plan",
      pipelineId: "pipe-213-rb-grant",
      flowState: "aborted",
      terminateReason: "session_quit",
      requirementDoc: "docs/design/213_Req.md",
      designReviewRecheck: { round: 1, reason: "plan_hash_drift" } as never,
    });
    gateStub = async () => ({ ok: true, state: AUTH_STATE });
    const h = makeHarness(meta, config);

    const result = await runRestoreBranch(h.deps);

    // ONE strict commit — exactly the two anchored fields, nothing else.
    expect(h.updates.length).toBe(1);
    expect(Object.keys(h.updates[0]!).sort()).toEqual(["designReview", "designReviewRecheck"]);
    expect(h.current().designReview).toEqual(AUTH_STATE);
    expect(h.current().designReviewRecheck).toBeUndefined();
    // Execution entered the shared resume unit with the honest restore reason
    // and the RECORDED doc (not a fresh selection).
    expect(resumeCalls.length).toBe(1);
    expect(resumeCalls[0]!.reason).toBe("resume_menu_restore");
    expect(resumeCalls[0]!.file).toBe("docs/design/213_Req.md");
    expect(result.changed).toBe(true);
    expect(result.message).toContain("stubbed resume executed");
    // No contradictory failure audit was produced on the happy path.
    expect(
      audits.some(
        (a) =>
          a.event === "design_review_authorisation" &&
          a.message.action === "gate_commit_failed",
      ),
    ).toBe(false);
  });
});

// ─── ③ granted but commit conflicts: error audit + zero restore ─────────────

describe("213 review issue 1: runRestoreBranch — granted gate with a FAILED strict commit", () => {
  it("strict commit conflict: error-level gate_commit_failed audit (source resume_menu_restore) and resumePipeline NEVER runs", async () => {
    const config = makeTestConfig();
    const meta = makeTestMeta({
      currentStage: "design-review",
      previousStage: "plan",
      pipelineId: "pipe-213-rb-conflict",
      flowState: "aborted",
      terminateReason: "session_quit",
      requirementDoc: "docs/design/213_Req.md",
    });
    const beforeJson = JSON.stringify(meta.designReview);
    gateStub = async () => ({ ok: true, state: AUTH_STATE });
    const h = makeHarness(meta, config, [], { verifyConflict: "state_drifted" });

    const result = await runRestoreBranch(h.deps);

    expect(result.changed).toBe(false);
    expect(result.message).toContain("Design-review authorization commit failed: conflict (state_drifted)");
    expect(result.message).toContain("Nothing was resumed");
    // Zero restore: the shared unit was never invoked, nothing was written.
    expect(resumeCalls.length).toBe(0);
    expect(h.updates.length).toBe(0);
    expect(JSON.stringify(h.current().designReview)).toBe(beforeJson);
    // The ERROR-level honest line with the full identity of the lost commit.
    const failed = audits.filter(
      (a) =>
        a.event === "design_review_authorisation" &&
        a.message.action === "gate_commit_failed",
    );
    expect(failed.length).toBe(1);
    expect(failed[0]!.level).toBe("error");
    expect(failed[0]!.message).toMatchObject({
      pipelineId: "pipe-213-rb-conflict",
      status: "conflict",
      reason: "state_drifted",
      authorizationId: AUTH_STATE.authorizationId,
      source: "resume_menu_restore",
    });
  });
});

// ─── ④ non-RESUMABLE stage aborted: degrade to the new-pipeline branch ──────

describe("213 review issue 1: runRestoreBranch — aborted stage outside RESUMABLE_STAGES", () => {
  it("completed + aborted degrades into the new-pipeline branch (stage menu opens first; cancel ⇒ zero writes, no gate, no resume)", async () => {
    const config = makeTestConfig();
    const meta = makeTestMeta({
      currentStage: "completed",
      previousStage: "awaiting_human",
      pipelineId: "pipe-213-rb-completed",
      flowState: "aborted",
      terminateReason: "user_quit",
    });
    const snapshot = JSON.parse(JSON.stringify(meta));
    // A tripwire gate: the degraded path must NOT consult the design-review
    // authorisation (the RESUMABLE guard returns before the gate).
    let gateTouched = 0;
    gateStub = async () => {
      gateTouched++;
      return { ok: false, reason: "unreachable_on_degraded_path" };
    };
    const h = makeHarness(meta, config); // no answers ⇒ Esc at the stage menu

    const result = await runRestoreBranch(h.deps);

    expect(result.changed).toBe(false);
    expect(result.message).toContain("Nothing was started");
    // The new-pipeline branch opened EXACTLY the stage menu first (D13 order).
    expect(h.calls.length).toBe(1);
    expect(h.calls[0]!.title).toBe("Start the new pipeline at which stage:");
    expect(gateTouched).toBe(0);
    expect(resumeCalls.length).toBe(0);
    expect(h.updates.length).toBe(0);
    expect(JSON.parse(JSON.stringify(h.current()))).toEqual(snapshot);
  });
});
