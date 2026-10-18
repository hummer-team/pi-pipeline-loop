/**
 * 192 Phase 0: design-review identity contract tests.
 *
 * Covers:
 * - Full identity tuple comparison (kind / round / same-millisecond visit
 *   differences are NEVER equal)
 * - Safe runtime narrowing of legacy meta missing fields (compat read, no
 *   guessing a valid authorization)
 * - finished / authorization-lost terminal classification
 * - classifyDesignReviewFlow: ordinary vs authorized vs blocked, including an
 *   unfinished develop-handoff while currentStage=develop
 * - Pure round allocation from caller-provided history (allocateNextRoundSafe)
 * - entry.ts shared extraction (stage assets, docs, strict-named round scan)
 * - createInitialState attribution fields
 *
 * No mock.module() used — writeAuditLog is safe (returns early without auditDir).
 */

import { describe, it, expect } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type {
  SessionMeta,
  DesignReviewState,
  DesignReviewIdentity,
  DesignReviewOperation,
} from "../../types";
import {
  hasCompleteDesignReviewIdentity,
  identityEquals,
  buildDesignReviewIdentity,
  isAuthorizedCurrentRun,
  isDevelopHandoffOperation,
  classifyDesignReviewFlow,
  allocateNextRoundSafe,
  isAuthorizationValid,
  createInitialState,
  deriveReportPath,
  generateUUID,
} from "../../core/design-review/state";
import {
  narrowDesignReviewState,
  narrowDesignReviewOperationContext,
} from "../../core/design-review/verification-context";
import {
  validateDesignReviewStageAssets,
  resolveDesignReviewEntryDocs,
  collectExistingReviewRounds,
  pickSafeNextRound,
} from "../../core/design-review/entry";
import { makeTestConfig, makeTestMeta } from "../helpers";

function makeOperation(overrides?: Partial<DesignReviewOperation>): DesignReviewOperation {
  const now = Date.now();
  return {
    operationId: generateUUID(),
    kind: "review",
    stageVisitId: now,
    attempt: 1,
    dispatchState: "pending",
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function makeState(overrides?: Partial<DesignReviewState>): DesignReviewState {
  const now = Date.now();
  return {
    schemaVersion: 1,
    planDoc: path.resolve("/tmp/project/docs/190_Feat_plan.md"),
    authorizationId: generateUUID(),
    authorizationSource: "menu",
    round: 1,
    reportDoc: deriveReportPath(path.resolve("/tmp/project/docs/190_Feat_plan.md"), 1),
    planHash: "a".repeat(64),
    phase: "review_ready",
    authorizedAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function makeIdentity(overrides?: Partial<DesignReviewIdentity>): DesignReviewIdentity {
  const state = makeState();
  const op = makeOperation();
  return {
    pipelineId: "pipe-test-001",
    planDoc: state.planDoc,
    authorizationId: state.authorizationId,
    round: state.round,
    kind: op.kind,
    operationId: op.operationId,
    stageVisitId: op.stageVisitId,
    ...overrides,
  };
}

describe("192 Phase 0: hasCompleteDesignReviewIdentity (runtime narrowing)", () => {
  it("accepts a fully-formed state", () => {
    expect(hasCompleteDesignReviewIdentity(makeState())).toBe(true);
  });

  it("rejects non-object inputs", () => {
    expect(hasCompleteDesignReviewIdentity(undefined)).toBe(false);
    expect(hasCompleteDesignReviewIdentity(null)).toBe(false);
    expect(hasCompleteDesignReviewIdentity("string")).toBe(false);
  });

  it("rejects states missing authorizationId (legacy field gaps are compat-read only)", () => {
    const s = makeState();
    delete (s as Partial<DesignReviewState>).authorizationId;
    expect(hasCompleteDesignReviewIdentity(s)).toBe(false);
  });

  it("rejects states missing planDoc", () => {
    const s = makeState();
    delete (s as Partial<DesignReviewState>).planDoc;
    expect(hasCompleteDesignReviewIdentity(s)).toBe(false);
  });

  it("rejects invalid round values (0, fractional, negative, missing)", () => {
    for (const bad of [0, -1, 1.5, undefined]) {
      const s = makeState({ round: bad as number });
      if (bad === undefined) delete (s as Partial<DesignReviewState>).round;
      expect(hasCompleteDesignReviewIdentity(s)).toBe(false);
    }
  });

  it("rejects unknown phase tokens", () => {
    const s = makeState({ phase: "bogus_phase" as DesignReviewState["phase"] });
    expect(hasCompleteDesignReviewIdentity(s)).toBe(false);
  });

  it("validity is NOT decided by the numeric schemaVersion", () => {
    // schemaVersion 1 with a missing authorizationId is still invalid,
    // and schemaVersion 1 with all fields is valid: version number guessing
    // is never used for validity.
    const withVersion = makeState();
    expect(hasCompleteDesignReviewIdentity(withVersion)).toBe(true);
    const staleVersioned = { ...makeState(), authorizationId: "" };
    expect(hasCompleteDesignReviewIdentity(staleVersioned)).toBe(false);
  });
});

describe("192 Phase 0: identityEquals (full tuple comparison)", () => {
  it("equal identities with every field matching compare true", () => {
    const base = makeIdentity();
    const same: DesignReviewIdentity = { ...base };
    expect(identityEquals(base, same)).toBe(true);
  });

  it("different kind is NOT equal (review vs update vs develop-handoff)", () => {
    const base = makeIdentity();
    expect(identityEquals(base, { ...base, kind: "update" })).toBe(false);
    expect(identityEquals(base, { ...base, kind: "develop-handoff" })).toBe(false);
  });

  it("different round is NOT equal", () => {
    const base = makeIdentity();
    expect(identityEquals(base, { ...base, round: base.round + 1 })).toBe(false);
  });

  it("different stageVisitId is NOT equal even for the SAME millisecond otherwise identical tuple", () => {
    const t = Date.now(); // same millisecond for both visits
    const a = makeIdentity({ stageVisitId: t });
    const b: DesignReviewIdentity = { ...a, stageVisitId: t + 1 };
    // Same-millisecond distinct visits must not be conflated: stageVisitId is
    // part of the tuple, so a new visit at (effectively) the same instant is
    // a different identity.
    expect(identityEquals(a, b)).toBe(false);
  });

  it("different operationId, authorizationId, pipelineId, planDoc, inputHash or requirementDoc are NOT equal", () => {
    const base = makeIdentity({ inputHash: "h1", requirementDoc: "/tmp/project/docs/190_Feat.md" });
    expect(identityEquals(base, { ...base, operationId: generateUUID() })).toBe(false);
    expect(identityEquals(base, { ...base, authorizationId: generateUUID() })).toBe(false);
    expect(identityEquals(base, { ...base, pipelineId: "other" })).toBe(false);
    expect(identityEquals(base, { ...base, planDoc: "/tmp/project/docs/OTHER_plan.md" })).toBe(false);
    expect(identityEquals(base, { ...base, inputHash: "h2" })).toBe(false);
    expect(identityEquals(base, { ...base, requirementDoc: undefined })).toBe(false);
    // undefined vs undefined matches
    const noReq: DesignReviewIdentity = { ...base, requirementDoc: undefined };
    expect(identityEquals(noReq, { ...noReq })).toBe(true);
  });

  it("undefined identity is never equal to a defined one", () => {
    expect(identityEquals(undefined, makeIdentity())).toBe(false);
    expect(identityEquals(makeIdentity(), undefined)).toBe(false);
    expect(identityEquals(undefined, undefined)).toBe(false);
  });

  it("planDoc comparison is path-canonical (trailing segments normalized)", () => {
    const base = makeIdentity({ planDoc: "/tmp/project/docs/190_Feat_plan.md" });
    const alt: DesignReviewIdentity = { ...base, planDoc: "/tmp/project/docs/sub/../190_Feat_plan.md" };
    expect(identityEquals(base, alt)).toBe(true);
  });
});

describe("192 Phase 0: buildDesignReviewIdentity / isAuthorizedCurrentRun", () => {
  it("builds identity from meta + state + current operation", () => {
    const op = makeOperation({ inputHash: "abc" });
    const state = makeState({ operation: op, pipelineId: "pipe-test-001" });
    const meta = makeTestMeta({ pipelineId: "pipe-test-001", designReview: state });
    const identity = buildDesignReviewIdentity(meta, state);
    expect(identity).toBeDefined();
    expect(identity!.operationId).toBe(op.operationId);
    expect(identity!.kind).toBe("review");
    expect(identity!.stageVisitId).toBe(op.stageVisitId);
    expect(identity!.inputHash).toBe("abc");
    expect(identity!.authorizationId).toBe(state.authorizationId);
    expect(identity!.round).toBe(state.round);
    expect(identity!.pipelineId).toBe("pipe-test-001");
  });

  it("returns undefined when no operation is bound", () => {
    const state = makeState();
    const meta = makeTestMeta({ designReview: state });
    expect(buildDesignReviewIdentity(meta, state)).toBeUndefined();
  });

  it("isAuthorizedCurrentRun accepts ONLY the exact current operation tuple", () => {
    const op = makeOperation();
    const state = makeState({ operation: op });
    const meta = makeTestMeta({ designReview: state });
    const current = buildDesignReviewIdentity(meta, state)!;
    expect(isAuthorizedCurrentRun(meta, state, current)).toBe(true);
    // A stale prior-round operation with the same visit timestamp is rejected.
    const stale: DesignReviewIdentity = { ...current, round: current.round + 1 };
    expect(isAuthorizedCurrentRun(meta, state, stale)).toBe(false);
    // A different kind at same round/visit is rejected (F01 wrong-kind guard).
    const wrongKind: DesignReviewIdentity = { ...current, kind: "update" };
    expect(isAuthorizedCurrentRun(meta, state, wrongKind)).toBe(false);
  });

  it("isAuthorizedCurrentRun with no current operation authorizes nothing", () => {
    const state = makeState(); // no operation
    const meta = makeTestMeta({ designReview: state });
    expect(isAuthorizedCurrentRun(meta, state, makeIdentity())).toBe(false);
  });
});

describe("192 Phase 0: classifyDesignReviewFlow", () => {
  it("no designReview state at all → ordinary", () => {
    expect(classifyDesignReviewFlow(makeTestMeta({ designReview: undefined })).kind).toBe("ordinary");
    expect(classifyDesignReviewFlow(undefined).kind).toBe("ordinary");
  });

  it("active authorized phases → authorized", () => {
    for (const phase of ["review_ready", "review_running", "update_ready", "update_running", "pass_ready"] as const) {
      const meta = makeTestMeta({ designReview: makeState({ phase }) });
      expect(classifyDesignReviewFlow(meta).kind).toBe("authorized");
    }
  });

  it("paused without authorization-lost → authorized (recovery pending, never ordinary)", () => {
    const meta = makeTestMeta({ designReview: makeState({ phase: "paused", pauseReason: "drift" }) });
    expect(classifyDesignReviewFlow(meta).kind).toBe("authorized");
  });

  it("identity-incomplete state → blocked, not ordinary", () => {
    const broken = makeState();
    delete (broken as Partial<DesignReviewState>).authorizationId;
    const meta = makeTestMeta({ designReview: broken });
    const classified = classifyDesignReviewFlow(meta);
    expect(classified.kind).toBe("blocked");
    expect(classified.reason).toBe("identity_incomplete");
  });

  it("finished → ordinary release; authorization-lost → ordinary release", () => {
    const finished = makeTestMeta({ designReview: makeState({ phase: "finished" }) });
    expect(classifyDesignReviewFlow(finished).kind).toBe("ordinary");
    const lost = makeTestMeta({
      designReview: makeState({ phase: "paused", pauseReason: "authorization-lost" }),
    });
    expect(classifyDesignReviewFlow(lost).kind).toBe("ordinary");
    // Both remain authorization-invalid per isAuthorizationValid
    expect(isAuthorizationValid(finished.designReview!)).toBe(false);
    expect(isAuthorizationValid(lost.designReview!)).toBe(false);
  });

  it("pass_ready + develop-handoff while currentStage=develop stays authorized (never ordinary)", () => {
    const handoffOp = makeOperation({ kind: "develop-handoff", dispatchState: "pending" });
    const state = makeState({ phase: "pass_ready", operation: handoffOp });
    const meta = makeTestMeta({ currentStage: "develop", designReview: state });
    expect(classifyDesignReviewFlow(meta).kind).toBe("authorized");
    expect(isDevelopHandoffOperation(meta)).toBe(true);
  });

  it("develop-handoff marked completed is no longer an unfinished handoff", () => {
    const handoffOp = makeOperation({ kind: "develop-handoff", dispatchState: "completed" });
    const state = makeState({ phase: "pass_ready", operation: handoffOp });
    const meta = makeTestMeta({ currentStage: "develop", designReview: state });
    expect(isDevelopHandoffOperation(meta)).toBe(false);
  });
});

describe("192 Phase 0: allocateNextRoundSafe (pure, no directory scan)", () => {
  it("empty history starts at round 1", () => {
    expect(allocateNextRoundSafe([])).toBe(1);
  });

  it("takes one past the maximum occupied round", () => {
    expect(allocateNextRoundSafe([1, 2, 5])).toBe(6);
    expect(allocateNextRoundSafe([3])).toBe(4);
  });

  it("ignores non-integer/negative noise", () => {
    expect(allocateNextRoundSafe([0, -3, 1.5, 2, Number.NaN])).toBe(3);
  });
});

describe("192 Phase 0: verification-context narrowing", () => {
  it("narrowDesignReviewState: absent → ok:false absent", () => {
    expect(narrowDesignReviewState(undefined)).toEqual({ ok: false, reason: "absent" });
    expect(narrowDesignReviewState(makeTestMeta({ designReview: undefined }))).toEqual({
      ok: false,
      reason: "absent",
    });
  });

  it("narrowDesignReviewState: incomplete identity is rejected at runtime", () => {
    const broken = makeState({ round: 0 });
    expect(narrowDesignReviewState(makeTestMeta({ designReview: broken }))).toEqual({
      ok: false,
      reason: "identity_incomplete",
    });
  });

  it("narrowDesignReviewOperationContext: requires an operation and expected kind", () => {
    const op = makeOperation({ kind: "update" });
    const state = makeState({ phase: "update_ready", operation: op });
    const meta = makeTestMeta({ designReview: state });
    const res = narrowDesignReviewOperationContext(meta, "update");
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.ctx.operation.operationId).toBe(op.operationId);
      expect(res.ctx.identity.kind).toBe("update");
      expect(res.ctx.identity.operationId).toBe(op.operationId);
    }
    // Wrong expected kind must not narrow (prevents review/update confusion)
    expect(narrowDesignReviewOperationContext(meta, "review").ok).toBe(false);
    // No operation at all
    const noOp = makeTestMeta({ designReview: makeState() });
    expect(narrowDesignReviewOperationContext(noOp)).toEqual({
      ok: false,
      reason: "no_operation",
    });
  });
});

describe("192 Phase 0: entry.ts shared extraction", () => {
  it("validateDesignReviewStageAssets: enabled stage with agent+skill passes", () => {
    const config = makeTestConfig();
    const res = validateDesignReviewStageAssets(config);
    expect(res.ok).toBe(true);
  });

  it("validateDesignReviewStageAssets: disabled stage → design_review_disabled", () => {
    const config = makeTestConfig();
    config.stages["design-review"] = { ...config.stages["design-review"], disabled: true } as never;
    const res = validateDesignReviewStageAssets(config);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe("design_review_disabled");
  });

  it("validateDesignReviewStageAssets: missing agent/skill → design_review_config_invalid", () => {
    const config = makeTestConfig();
    const stage = { ...config.stages["design-review"] } as Record<string, unknown>;
    delete stage.agentPath;
    config.stages["design-review"] = stage as never;
    const res = validateDesignReviewStageAssets(config);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe("design_review_config_invalid");
  });

  it("resolveDesignReviewEntryDocs: derives _Plan.md absolute path and existence flags", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dr-entry-"));
    try {
      const reqDoc = path.join(tmp, "docs", "190_Feat.md");
      const planDoc = path.join(tmp, "docs", "190_Feat_Plan.md");
      fs.mkdirSync(path.join(tmp, "docs"), { recursive: true });
      fs.writeFileSync(reqDoc, "# Requirement\n");
      fs.writeFileSync(planDoc, "# Plan\n");
      const config = makeTestConfig({ projectRoot: tmp });
      const meta = makeTestMeta({ requirementDoc: "docs/190_Feat.md" });
      const docs = resolveDesignReviewEntryDocs(config, meta);
      expect(docs.requirementDoc).toBe(path.resolve(reqDoc));
      expect(docs.planDoc).toBe(path.resolve(planDoc));
      expect(docs.requirementExists).toBe(true);
      expect(docs.planExists).toBe(true);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("resolveDesignReviewEntryDocs: missing docs reported, no crash", () => {
    const config = makeTestConfig();
    const meta = makeTestMeta({ requirementDoc: "docs/absent_Feat.md" });
    const docs = resolveDesignReviewEntryDocs(config, meta);
    expect(docs.requirementExists).toBe(false);
    expect(docs.planExists).toBe(false);
  });

  it("collectExistingReviewRounds: strict pattern only, per-plan isolation", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dr-rounds-"));
    try {
      fs.writeFileSync(path.join(tmp, "X_plan.md"), "# plan\n");
      fs.writeFileSync(path.join(tmp, "review-design-1-X_plan.md"), "r1");
      fs.writeFileSync(path.join(tmp, "review-design-2-X_plan.md"), "r2");
      // Not matching the strict pattern for X_plan.md:
      fs.writeFileSync(path.join(tmp, "review-design-7-Y_plan.md"), "other plan");
      fs.writeFileSync(path.join(tmp, "review-design-ab-X_plan.md"), "bad round");
      fs.writeFileSync(path.join(tmp, "review-design-0-X_plan.md"), "round zero rejected");
      const rounds = collectExistingReviewRounds(path.join(tmp, "X_plan.md")).sort();
      expect(rounds).toEqual([1, 2]);
      expect(pickSafeNextRound(path.join(tmp, "X_plan.md"))).toBe(3);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("pickSafeNextRound on unreadable directory falls back to round 1", () => {
    expect(pickSafeNextRound(path.join(os.tmpdir(), "definitely-missing-dir-192", "Z_plan.md"))).toBe(1);
  });
});

describe("192 Phase 0: createInitialState attribution", () => {
  it("records pipelineId and requirementDoc attribution (canonical absolute)", () => {
    const state = createInitialState(
      "/tmp/project/docs/190_Feat_plan.md",
      "menu",
      "b".repeat(64),
      "/tmp/session.jsonl",
      { pipelineId: "pipe-9", requirementDoc: "docs/190_Feat.md", round: 4 },
    );
    expect(state.pipelineId).toBe("pipe-9");
    expect(state.requirementDoc).toBe(path.resolve("docs/190_Feat.md"));
    expect(state.round).toBe(4);
    expect(state.reportDoc).toBe(deriveReportPath(state.planDoc, 4));
  });

  it("without attribution keeps legacy shape (round 1, optional fields absent)", () => {
    const state = createInitialState("/tmp/p_plan.md", "menu", "c".repeat(64));
    expect(state.round).toBe(1);
    expect("pipelineId" in state).toBe(false);
    expect("requirementDoc" in state).toBe(false);
  });
});
