/**
 * 194 Phase 1: the SHARED SNAPSHOT, DRIFT, WRITE-SCOPE and CUSTOM-TEMPLATE
 * surfaces of the standalone update receipt (contracts C1/C2/C4).
 *
 * Why this file sits next to `core/verifiers/design-review-standalone-update.test.ts`:
 * that suite pins the RECEIPT EVALUATOR (pure, no I/O). This one pins the layers
 * that feed it and the permissions around it, which the plan lists as
 * "单快照、漂移、symlink/只读冲突、YAML缺token":
 *  - ONE capture per deliverable, shared by the domain validator and the rule
 *    engine, with read failures recorded as evidence instead of retried;
 *  - an unprovable OUTPUT binding touches NO file at all (no "discovery");
 *  - the pre-advance drift check re-verifies exactly the bytes the READY verdict
 *    consumed (plan / consumed report / receipt);
 *  - the write policy is the single source of the EXACT writable list, guards
 *    match it by canonical path (a symlink twin is not a grant) and a
 *    pre-dispatch probe reports collisions before any visit or RPC;
 *  - a CUSTOM update YAML that cannot name the standalone receipt blocks the
 *    dispatch with its key and path instead of silently falling back.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";
import type {
  DesignReviewOperation,
  DesignReviewState,
  SessionMeta,
  StandaloneUpdateArtifact,
} from "../../types";
import {
  captureDesignReviewSnapshots,
  checkUpdateDeliverableDrift,
  evaluateUpdateSnapshots,
} from "../../core/design-review/verification-snapshot";
import type { TrustedDomainVerificationContext } from "../../core/design-review/verification-context";
import {
  computeBaselineSectionsHash,
  createStandaloneUpdateArtifact,
  deriveStandaloneReceiptPath,
  extractLegacyUpdateSections,
} from "../../core/design-review/update-artifact";
import {
  describeWriteScope,
  findWriteScopeConflicts,
  isPathWithinWriteScope,
  resolveDesignReviewWritePolicy,
} from "../../core/design-review/write-policy";
import {
  buildDesignReviewUpdatePrompt,
  DESIGN_REVIEW_UPDATE_PROMPT_KEY,
  DesignReviewUpdateConfigError,
} from "../../core/design-review/prompt";
import type { DesignReviewUpdatePromptParams } from "../../core/design-review/prompt";
import { resetPromptConfigCache } from "../../core/prompt-config";
import { computeHash, createInitialState } from "../../core/design-review/state";
import { validateDesignReviewUpdate } from "../../core/verifiers/design-review-update-verifier";
import type { DesignReviewUpdateValidationInput } from "../../core/verifiers/design-review-update-verifier";
import { loadGitignoreInfo } from "../../utils/gitignore";
import { resolveProtectConfig } from "../../utils/protect";
import { makeTestConfig, makeTestMeta, standaloneReceiptContent } from "../helpers";

type UpdateContext = Extract<TrustedDomainVerificationContext, { kind: "update" }>;
type ReviewContext = Extract<TrustedDomainVerificationContext, { kind: "review" }>;

const PIPELINE = "pipe-194-snap";
const REVIEW_OP = "11111111-1111-4111-8111-111111111111";
const UPDATE_OP = "22222222-2222-4222-8222-222222222222";
const HANDOFF_OP = "33333333-3333-4333-8333-333333333333";
const ROUND = 1;

const BASELINE_PLAN = "# Plan\n\n## Approach\n\nOriginal design.\n";
const REVISED_PLAN = "# Plan\n\n## Approach\n\nRevised design with rollback coverage.\n";

let root: string;
let planDoc: string;
let reportDoc: string;
let receiptDoc: string;
let baselineHash: string;
let reportHash: string;
let receiptHash: string;

/** The FAIL report whose issues this update disposes of. */
function reportBody(): string {
  return [
    "# Design Review Report",
    "",
    `**pipeline**: ${PIPELINE}`,
    `**plan**: ${planDoc}`,
    `**round**: ${ROUND}`,
    `**operation**: ${REVIEW_OP}`,
    `**input hash**: ${baselineHash}`,
    "",
    "## Summary",
    "",
    "Two gaps block development.",
    "",
    "## Issues",
    "",
    "1. Missing error handling",
    "2. Incomplete specification",
    "",
  ].join("\n");
}

/** The receipt document this update operation must produce. */
function receiptBody(): string {
  return standaloneReceiptContent({
    pipelineId: PIPELINE,
    planDoc,
    reviewOperationId: REVIEW_OP,
    reportDoc,
    round: ROUND,
    updateOperationId: UPDATE_OP,
    baselinePlanHash: baselineHash,
    dispositions: [
      { issueId: "1", text: "Missing error handling", disposition: "fixed", justification: "added the retry section" },
      { issueId: "2", text: "Incomplete specification", disposition: "fixed", justification: "expanded the contract" },
    ],
    changesMade: ["- Phase 1: added retry and contract sections."],
  });
}

function writeDeliverables(): void {
  fs.writeFileSync(planDoc, REVISED_PLAN, "utf-8");
  reportHash = computeHash(reportBody());
  fs.writeFileSync(reportDoc, reportBody(), "utf-8");
  fs.writeFileSync(receiptDoc, receiptBody(), "utf-8");
  receiptHash = computeHash(fs.readFileSync(receiptDoc, "utf-8"));
}

const BASELINE_SECTIONS_HASH = computeBaselineSectionsHash(extractLegacyUpdateSections(BASELINE_PLAN));

function updateCtx(overrides: Partial<UpdateContext> = {}): UpdateContext {
  return {
    kind: "update",
    planDoc,
    updateOperationId: UPDATE_OP,
    reportDoc,
    reportHash,
    baselinePlanHash: baselineHash,
    round: ROUND,
    reviewOperationId: REVIEW_OP,
    issueIds: ["1", "2"],
    output: { ok: true, kind: "standalone", receiptDoc, baselineSectionsHash: BASELINE_SECTIONS_HASH },
    pipelineId: PIPELINE,
    ...overrides,
  };
}

function reviewCtx(reportPath: string): ReviewContext {
  return {
    kind: "review",
    reportPath,
    planDoc,
    pipelineId: PIPELINE,
    round: ROUND,
    operationId: REVIEW_OP,
    inputHash: baselineHash,
  };
}

/** Narrow a validator input to its standalone output branch (fails otherwise). */
function standaloneBranch(input: DesignReviewUpdateValidationInput) {
  if (input.output === undefined || input.output.kind !== "standalone") {
    throw new Error("a standalone output binding is expected");
  }
  return input.output;
}

/** Minimal operation record (identity fields only — no dispatch evidence needed here). */
function operation(
  kind: DesignReviewOperation["kind"],
  operationId: string,
  extra: Partial<DesignReviewOperation> = {},
): DesignReviewOperation {
  return {
    operationId,
    kind,
    stageVisitId: 1000,
    attempt: 1,
    dispatchState: "dispatched",
    createdAt: 1,
    updatedAt: 1,
    ...extra,
  };
}

/** A persisted design-review state for the write-policy matrix. */
function stateFor(patch: Partial<DesignReviewState>): DesignReviewState {
  return {
    ...createInitialState(planDoc, "menu", baselineHash, undefined, { pipelineId: PIPELINE }),
    ...patch,
  };
}

/**
 * A descriptor the plugin would NEVER issue (unknown format). Persisted meta is
 * untrusted input, so the test injects the raw shape the narrowing must reject.
 */
function foreignArtifact(receipt: string): StandaloneUpdateArtifact {
  return {
    format: "standalone-v9",
    receiptDoc: receipt,
    baselineSectionsHash: "z".repeat(64),
  } as unknown as StandaloneUpdateArtifact;
}

function metaFor(state: DesignReviewState | undefined, currentStage: SessionMeta["currentStage"]): SessionMeta {
  return makeTestMeta({
    currentStage,
    pipelineId: PIPELINE,
    ...(state !== undefined ? { designReview: state } : {}),
  });
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(tmpdir(), "dr-snap-"));
  fs.mkdirSync(path.join(root, "docs"), { recursive: true });
  planDoc = path.join(root, "docs", "194_Feat_plan.md");
  reportDoc = path.join(root, "docs", "review-design-1-194_Feat_plan.md");
  receiptDoc = deriveStandaloneReceiptPath(planDoc, ROUND, UPDATE_OP)!;
  baselineHash = computeHash(BASELINE_PLAN);
  fs.writeFileSync(planDoc, BASELINE_PLAN, "utf-8");
  writeDeliverables();
});

afterEach(() => {
  resetPromptConfigCache();
  fs.rmSync(root, { recursive: true, force: true });
});

describe("194 Phase 1 (C2): one capture per deliverable, shared by every consumer", () => {
  it("a standalone update captures plan, consumed report and pinned receipt once each", async () => {
    const set = await captureDesignReviewSnapshots(updateCtx());
    expect(set.entries.map((e) => e.absPath)).toEqual([
      path.resolve(planDoc),
      path.resolve(reportDoc),
      path.resolve(receiptDoc),
    ]);
    expect(set.lookup(planDoc)).toBe(REVISED_PLAN);
    expect(set.lookup(receiptDoc)).toContain("## Design Review Update");
  });

  it("a review context captures only its current report", async () => {
    const set = await captureDesignReviewSnapshots(reviewCtx(reportDoc));
    expect(set.entries.map((e) => e.absPath)).toEqual([path.resolve(reportDoc)]);
  });

  it("the lookup serves the CAPTURED bytes after the file changes on disk", async () => {
    const set = await captureDesignReviewSnapshots(updateCtx());
    fs.writeFileSync(planDoc, "# Plan\n\nTampered after capture.\n", "utf-8");
    expect(set.lookup(planDoc)).toBe(REVISED_PLAN);
    // a FRESH pass sees the new bytes: the guarantee is per capture, not a cache
    const again = await captureDesignReviewSnapshots(updateCtx());
    expect(again.lookup(planDoc)).toContain("Tampered after capture");
  });

  it("a read failure is recorded as evidence once and the lookup fabricates no bytes", async () => {
    fs.rmSync(receiptDoc);
    const set = await captureDesignReviewSnapshots(updateCtx());
    const receipt = set.entries.find((e) => e.absPath === path.resolve(receiptDoc));
    expect(receipt?.content).toBeUndefined();
    expect(typeof receipt?.readError).toBe("string");
    // the failed capture yields undefined, so a rule may fall back to its own read
    expect(set.lookup(receiptDoc)).toBeUndefined();
    expect(set.lookup(planDoc)).toBe(REVISED_PLAN);
  });

  it("one deliverable bound twice is captured once", async () => {
    // Pathological context: the consumed report IS the plan file.
    const set = await captureDesignReviewSnapshots(
      updateCtx({ reportDoc: planDoc, output: { ok: true, kind: "legacy" } }),
    );
    expect(set.entries.length).toBe(1);
  });

  it("an unprovable output binding touches NO file at all", async () => {
    // A receipt exists on disk, yet an unprovable contract must not "discover" it.
    const set = await captureDesignReviewSnapshots(
      updateCtx({ output: { ok: false, reason: "update_artifact_unknown_format" } }),
    );
    expect(set.entries.length).toBe(0);
    expect(set.lookup(receiptDoc)).toBeUndefined();
  });

  it("a legacy operation captures plan and report and no receipt document", async () => {
    const set = await captureDesignReviewSnapshots(updateCtx({ output: { ok: true, kind: "legacy" } }));
    expect(set.entries.map((e) => path.basename(e.absPath))).toEqual([
      "194_Feat_plan.md",
      "review-design-1-194_Feat_plan.md",
    ]);
  });
});

describe("194 Phase 1 (C2): the snapshot set is the ONLY validator input source", () => {
  it("standalone: the verifier sees the captured bytes, not a second read", async () => {
    const set = await captureDesignReviewSnapshots(updateCtx());
    const evaluated = evaluateUpdateSnapshots(updateCtx(), set);
    if (!evaluated.ok) throw new Error(`unexpected: ${evaluated.failures.join(" | ")}`);
    const output = standaloneBranch(evaluated.input);
    expect(evaluated.input.planContent).toBe(REVISED_PLAN);
    expect(output.receiptDoc).toBe(path.resolve(receiptDoc));
    expect(output.receiptContent).toBe(fs.readFileSync(receiptDoc, "utf-8"));
    expect(output.baselineSectionsHash).toBe(BASELINE_SECTIONS_HASH);
    // mutating the disk afterwards cannot change what the validator will evaluate
    fs.writeFileSync(receiptDoc, "tampered\n", "utf-8");
    expect(output.receiptContent).toContain("## Design Review Update");
  });

  it("standalone: the assembled input yields the READY verdict carrying both hashes", async () => {
    const set = await captureDesignReviewSnapshots(updateCtx());
    const evaluated = evaluateUpdateSnapshots(updateCtx(), set);
    if (!evaluated.ok) throw new Error(`unexpected: ${evaluated.failures.join(" | ")}`);
    const verdict = validateDesignReviewUpdate(evaluated.input);
    expect(verdict.status).toBe("ready");
    if (verdict.status === "ready") {
      expect(verdict.newPlanHash).toBe(computeHash(REVISED_PLAN));
      expect(verdict.receiptHash).toBe(receiptHash);
      expect(verdict.disposedIssueIds).toEqual(["1", "2"]);
    }
  });

  it("a vanished receipt is handed over as read evidence and stays INVALID", async () => {
    fs.rmSync(receiptDoc);
    const set = await captureDesignReviewSnapshots(updateCtx());
    const evaluated = evaluateUpdateSnapshots(updateCtx(), set);
    if (!evaluated.ok) throw new Error("plan and report are still readable");
    const output = standaloneBranch(evaluated.input);
    expect(output.receiptContent).toBeUndefined();
    expect(typeof output.receiptReadError).toBe("string");
    expect(validateDesignReviewUpdate(evaluated.input).status).toBe("invalid");
  });

  it("an unreadable plan is a hard invalid before the verifier is consulted", async () => {
    fs.rmSync(planDoc);
    const set = await captureDesignReviewSnapshots(updateCtx());
    const evaluated = evaluateUpdateSnapshots(updateCtx(), set);
    expect(evaluated.ok).toBe(false);
    if (!evaluated.ok) expect(evaluated.failures.join(" ")).toContain("plan snapshot unreadable");
  });

  it("an unprovable binding fails closed and states the no-back-fill rule", () => {
    const evaluated = evaluateUpdateSnapshots(
      updateCtx({ output: { ok: false, reason: "update_artifact_receipt_path_drift" } }),
      { entries: [], lookup: () => undefined },
    );
    expect(evaluated.ok).toBe(false);
    if (!evaluated.ok) {
      expect(evaluated.failures.join(" ")).toContain("not provable");
      expect(evaluated.failures.join(" ")).toContain("never used as a receipt substitute");
    }
  });

  it("legacy input omits the output binding entirely (192 embedded contract)", async () => {
    const legacy = updateCtx({ output: { ok: true, kind: "legacy" } });
    const set = await captureDesignReviewSnapshots(legacy);
    const evaluated = evaluateUpdateSnapshots(legacy, set);
    if (!evaluated.ok) throw new Error("the legacy plan is readable");
    expect(evaluated.input.output).toBeUndefined();
    // the 192 contract still needs the embedded section, so this is invalid
    expect(validateDesignReviewUpdate(evaluated.input).status).toBe("invalid");
  });

  it("an unreadable consumed report is simply not passed as bytes", async () => {
    fs.rmSync(reportDoc);
    const set = await captureDesignReviewSnapshots(updateCtx());
    const evaluated = evaluateUpdateSnapshots(updateCtx(), set);
    if (!evaluated.ok) throw new Error("the plan is readable");
    expect(evaluated.input.reportContent).toBeUndefined();
    expect(evaluated.input.reportHash).toBe(reportHash);
  });
});

describe("194 Phase 1 (C2): the pre-advance drift check re-verifies the consumed bytes", () => {
  it("no drift → the fresh hashes equal the ones the READY verdict consumed", async () => {
    const result = await checkUpdateDeliverableDrift(updateCtx(), computeHash(REVISED_PLAN), receiptHash);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.planHash).toBe(computeHash(REVISED_PLAN));
      expect(result.receiptHash).toBe(receiptHash);
    }
  });

  it("plan edited after READY → plan_hash_drift", async () => {
    fs.writeFileSync(planDoc, "# Plan\n\nThird-party edit.\n", "utf-8");
    const result = await checkUpdateDeliverableDrift(updateCtx(), computeHash(REVISED_PLAN), receiptHash);
    expect(result).toEqual({ ok: false, reason: "plan_hash_drift" });
  });

  it("receipt edited after READY → receipt_hash_drift", async () => {
    fs.appendFileSync(receiptDoc, "\nExtra line.\n", "utf-8");
    const result = await checkUpdateDeliverableDrift(updateCtx(), computeHash(REVISED_PLAN), receiptHash);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("receipt_hash_drift");
  });

  it("receipt deleted after READY → receipt_unreadable", async () => {
    fs.rmSync(receiptDoc);
    const result = await checkUpdateDeliverableDrift(updateCtx(), computeHash(REVISED_PLAN), receiptHash);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("receipt_unreadable");
  });

  it("the consumed report replaced after READY → report_hash_drift", async () => {
    fs.writeFileSync(reportDoc, `${fs.readFileSync(reportDoc, "utf-8")}\nTampered.\n`, "utf-8");
    const result = await checkUpdateDeliverableDrift(updateCtx(), computeHash(REVISED_PLAN), receiptHash);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("report_hash_drift");
  });

  it("the consumed report vanished after READY → report_unreadable", async () => {
    fs.rmSync(reportDoc);
    const result = await checkUpdateDeliverableDrift(updateCtx(), computeHash(REVISED_PLAN), receiptHash);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("report_unreadable");
  });

  it("a legacy output carrying a receipt hash is a contradiction, not a pass", async () => {
    const legacy = updateCtx({ output: { ok: true, kind: "legacy" } });
    const withHash = await checkUpdateDeliverableDrift(legacy, computeHash(REVISED_PLAN), receiptHash);
    expect(withHash.ok).toBe(false);
    if (!withHash.ok) expect(withHash.reason).toBe("unexpected_receipt_hash_for_legacy_output");
    const clean = await checkUpdateDeliverableDrift(legacy, computeHash(REVISED_PLAN));
    expect(clean.ok).toBe(true);
    if (clean.ok) expect(clean.receiptHash).toBeUndefined();
  });

  it("an unprovable binding reports drift before reading anything", async () => {
    fs.rmSync(planDoc);
    fs.rmSync(receiptDoc);
    const result = await checkUpdateDeliverableDrift(
      updateCtx({ output: { ok: false, reason: "update_artifact_not_object" } }),
      computeHash(REVISED_PLAN),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("output_binding_unprovable");
      expect(result.detail).toBe("update_artifact_not_object");
    }
  });
});

describe("194 Phase 1 (C4): the write policy is the single source of the writable list", () => {
  it("no design-review loop keeps the original permission chain", () => {
    expect(resolveDesignReviewWritePolicy(makeTestMeta({ designReview: undefined }))).toEqual({
      mode: "ordinary",
      writable: [],
    });
  });

  it("a loop with no current operation is ordinary too (nothing is executing)", () => {
    const state = stateFor({ phase: "review_ready", operation: undefined });
    expect(resolveDesignReviewWritePolicy(metaFor(state, "design-review")).mode).toBe("ordinary");
  });

  it("an identity that cannot be proven is blocked and writes nothing", () => {
    const state = stateFor({
      phase: "review_running",
      authorizationId: "",
      operation: operation("review", REVIEW_OP),
    });
    const policy = resolveDesignReviewWritePolicy(metaFor(state, "design-review"));
    expect(policy.mode).toBe("blocked");
    expect(policy.writable).toEqual([]);
    expect(policy.reason).toBe("design_review_identity_incomplete");
    expect(describeWriteScope(policy)).toContain("cannot be proven");
  });

  it("a paused loop is read-only and names the pause reason", () => {
    const state = stateFor({
      phase: "paused",
      pauseReason: "decision-pending",
      operation: operation("review", REVIEW_OP),
    });
    const policy = resolveDesignReviewWritePolicy(metaFor(state, "design-review"));
    expect(policy.mode).toBe("readonly");
    expect(policy.writable).toEqual([]);
    expect(policy.reason).toBe("paused:decision-pending");
    expect(describeWriteScope(policy)).toContain("waiting for the owner");
  });

  it("a review may write exactly its current report", () => {
    const state = stateFor({
      phase: "review_running",
      reportDoc,
      operation: operation("review", REVIEW_OP),
    });
    const policy = resolveDesignReviewWritePolicy(metaFor(state, "design-review"));
    expect(policy.mode).toBe("scoped");
    expect(policy.writable).toEqual([path.resolve(reportDoc)]);
  });

  it("a review whose report path is not bound yet has NO writable file", () => {
    const state = stateFor({
      phase: "review_running",
      reportDoc: undefined,
      operation: operation("review", REVIEW_OP, { dispatchState: "pending" }),
    });
    const policy = resolveDesignReviewWritePolicy(metaFor(state, "design-review"));
    expect(policy.mode).toBe("scoped");
    expect(policy.writable).toEqual([]);
    expect(policy.reason).toBe("review_report_path_unbound");
  });

  it("a standalone update may write exactly the original plan and its own receipt", () => {
    const artifact = createStandaloneUpdateArtifact(planDoc, ROUND, UPDATE_OP, [])!;
    const state = stateFor({
      phase: "update_running",
      reportDoc,
      operation: operation("update", UPDATE_OP, { round: ROUND, updateArtifact: artifact }),
    });
    const policy = resolveDesignReviewWritePolicy(metaFor(state, "plan"));
    expect(policy.mode).toBe("scoped");
    expect(policy.writable).toEqual([path.resolve(planDoc), path.resolve(artifact.receiptDoc)]);
    expect(describeWriteScope(policy)).toContain("EXACTLY these files");
  });

  it("a pre-194 update keeps the plan-only grant (embedded receipt)", () => {
    const state = stateFor({
      phase: "update_running",
      reportDoc,
      operation: operation("update", UPDATE_OP, { round: ROUND }),
    });
    const policy = resolveDesignReviewWritePolicy(metaFor(state, "plan"));
    expect(policy.mode).toBe("scoped");
    expect(policy.writable).toEqual([path.resolve(planDoc)]);
  });

  it("a malformed descriptor blocks the run instead of downgrading to legacy", () => {
    const state = stateFor({
      phase: "update_running",
      reportDoc,
      operation: operation("update", UPDATE_OP, {
        round: ROUND,
        updateArtifact: foreignArtifact(receiptDoc),
      }),
    });
    const policy = resolveDesignReviewWritePolicy(metaFor(state, "plan"));
    expect(policy.mode).toBe("blocked");
    expect(policy.reason).toContain("update_output_unprovable:update_artifact_unknown_format");
    expect(policy.writable).toEqual([]);
  });

  it("a develop handoff writes nothing: the transition is plugin-owned", () => {
    const state = stateFor({
      phase: "pass_ready",
      reportDoc,
      operation: operation("develop-handoff", HANDOFF_OP),
    });
    const policy = resolveDesignReviewWritePolicy(metaFor(state, "develop"));
    expect(policy.mode).toBe("scoped");
    expect(policy.writable).toEqual([]);
    expect(policy.reason).toBe("handoff_is_plugin_owned");
  });
});

describe("194 Phase 1 (C4): scope membership is canonical-path exact", () => {
  function standaloneScope() {
    const artifact = createStandaloneUpdateArtifact(planDoc, ROUND, UPDATE_OP, [])!;
    const policy = resolveDesignReviewWritePolicy(
      metaFor(
        stateFor({
          phase: "update_running",
          reportDoc,
          operation: operation("update", UPDATE_OP, { round: ROUND, updateArtifact: artifact }),
        }),
        "plan",
      ),
    );
    return { policy, artifact };
  }

  it("the granted plan and receipt match; a sibling file or directory does not", () => {
    const { policy } = standaloneScope();
    expect(isPathWithinWriteScope(policy, root, planDoc)).toBe(true);
    expect(isPathWithinWriteScope(policy, root, path.join(root, "docs", "plan-update-1-other.md"))).toBe(false);
    expect(isPathWithinWriteScope(policy, root, path.join(root, "docs"))).toBe(false);
    expect(isPathWithinWriteScope(policy, root, path.join(root, "src", "index.ts"))).toBe(false);
  });

  it("a path outside the project root fails closed", () => {
    const { policy } = standaloneScope();
    expect(isPathWithinWriteScope(policy, root, path.join(tmpdir(), "dr-elsewhere", "plan.md"))).toBe(false);
  });

  it("a symlinked twin of a granted file is not writable through the grant", () => {
    const { policy, artifact } = standaloneScope();
    const realReceipt = path.join(root, "docs", "real-receipt.md");
    const link = path.resolve(artifact.receiptDoc);
    fs.writeFileSync(realReceipt, "original\n", "utf-8");
    // The receipt itself IS granted lexically...
    expect(isPathWithinWriteScope(policy, root, link)).toBe(true);
    // ...but a symlink standing in for it must not let the guard write its target.
    fs.rmSync(link);
    fs.symlinkSync(realReceipt, link);
    expect(isPathWithinWriteScope(policy, root, link)).toBe(true); // lexical identity
    expect(isPathWithinWriteScope(policy, root, fs.realpathSync(link))).toBe(false); // resolved target
  });

  it("non-scoped modes can never be matched", () => {
    const ordinary = resolveDesignReviewWritePolicy(makeTestMeta({ designReview: undefined }));
    expect(isPathWithinWriteScope(ordinary, root, planDoc)).toBe(false);
    const readonlyPolicy = resolveDesignReviewWritePolicy(
      metaFor(
        stateFor({ phase: "paused", pauseReason: "executor-failed", operation: operation("update", UPDATE_OP) }),
        "plan",
      ),
    );
    expect(readonlyPolicy.mode).toBe("readonly");
    expect(isPathWithinWriteScope(readonlyPolicy, root, planDoc)).toBe(false);
  });
});

describe("194 Phase 1 (C4): the pre-dispatch probe reports scope collisions", () => {
  it("a clean standalone scope produces no conflicts", () => {
    const config = makeTestConfig({ projectRoot: root });
    expect(findWriteScopeConflicts(config, "plan", root, [planDoc, receiptDoc], null)).toEqual([]);
  });

  it("a deliverable outside the project root is reported, not silently allowed", () => {
    const config = makeTestConfig({ projectRoot: root });
    const conflicts = findWriteScopeConflicts(
      config,
      "plan",
      root,
      [path.join(tmpdir(), "dr-foreign", "plan.md")],
      null,
    );
    expect(conflicts.length).toBe(1);
    expect(conflicts[0]?.reason).toBe("outside_project_root");
  });

  it("a receipt under the plugin anchor directory is hardcoded-protected", () => {
    const config = makeTestConfig({ projectRoot: root });
    const conflicts = findWriteScopeConflicts(
      config,
      "plan",
      root,
      [path.join(root, ".pi", "audit", "plan-update.md")],
      null,
    );
    expect(conflicts.length).toBe(1);
    expect(conflicts[0]?.reason).toBe("hardcoded_protected");
  });

  it("a stage read-only path collides with the same grant", () => {
    const config = makeTestConfig({ projectRoot: root });
    config.stages = {
      ...config.stages,
      plan: { ...config.stages.plan!, allowedReadOnlyPaths: ["docs/locked"] },
    };
    const conflicts = findWriteScopeConflicts(
      config,
      "plan",
      root,
      [path.join(root, "docs", "locked", "194_Feat_plan.md")],
      null,
    );
    expect(conflicts.length).toBe(1);
    expect(conflicts[0]?.reason).toBe("stage_read_only");
  });

  it("a gitignored deliverable is reported once the protection state carries it", async () => {
    fs.writeFileSync(path.join(root, ".gitignore"), "generated/\n", "utf-8");
    const config = makeTestConfig({ projectRoot: root });
    const gitignore = await loadGitignoreInfo(root);
    if (gitignore === null) throw new Error("fixture: .gitignore was not loaded");
    const conflicts = findWriteScopeConflicts(
      config,
      "plan",
      root,
      [path.join(root, "generated", "194_Feat_plan.md")],
      resolveProtectConfig(config, gitignore),
    );
    expect(conflicts.length).toBe(1);
    expect(conflicts[0]?.reason).toBe("gitignore_protected");
  });

  it("the probe reports conflicts but never widens what is writable", () => {
    const config = makeTestConfig({ projectRoot: root });
    // Source code is not a declared deliverable: probing it must not grant it.
    const src = path.join(root, "src", "index.ts");
    expect(findWriteScopeConflicts(config, "plan", root, [src], null)).toEqual([]);
    expect(isPathWithinWriteScope(resolveDesignReviewWritePolicy(makeTestMeta()), root, src)).toBe(false);
  });
});

describe("194 Phase 1 (C1): a custom update YAML must name the standalone receipt", () => {
  function promptParams(receipt: string): DesignReviewUpdatePromptParams {
    return {
      pipelineId: PIPELINE,
      planDoc,
      reviewDoc: reportDoc,
      round: ROUND,
      operationId: UPDATE_OP,
      baselinePlanHash: baselineHash,
      issues: ["Missing error handling", "Incomplete specification"],
      updateReceiptDoc: receipt,
    };
  }

  /** Ship a business-custom YAML whose body is indented exactly one step. */
  function writeCustomYaml(bodyLines: readonly string[]): void {
    const dir = path.join(root, ".pi", "references");
    fs.mkdirSync(dir, { recursive: true });
    const body = bodyLines.map((line) => `   ${line}`).join("\n");
    fs.writeFileSync(
      path.join(dir, "pipeline-stage-prompt.yml"),
      `${DESIGN_REVIEW_UPDATE_PROMPT_KEY}: |\n${body}\n`,
      "utf-8",
    );
    resetPromptConfigCache();
  }

  it("a custom template without {updateReceiptDoc} blocks with its key and path", async () => {
    writeCustomYaml(["Revise the plan and append `## Design Review Update` to the plan body."]);
    let caught: unknown;
    try {
      await buildDesignReviewUpdatePrompt(makeTestConfig({ projectRoot: root }), promptParams(receiptDoc));
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(DesignReviewUpdateConfigError);
    const error = caught as DesignReviewUpdateConfigError;
    expect(error.code).toBe("missing-token");
    expect(error.key).toBe(DESIGN_REVIEW_UPDATE_PROMPT_KEY);
    expect(String(error.filePath)).toContain("pipeline-stage-prompt.yml");
    expect(error.message).toContain("updateReceiptDoc");
  });

  it("a custom template that references the token renders the pinned path", async () => {
    writeCustomYaml([
      "Revise the plan in place.",
      "Write the receipt to {updateReceiptDoc} — never into the plan body.",
    ]);
    const { prompt, selection } = await buildDesignReviewUpdatePrompt(
      makeTestConfig({ projectRoot: root }),
      promptParams(receiptDoc),
    );
    expect(selection.source).toBe("yaml");
    expect(prompt).toContain(receiptDoc);
    expect(prompt).not.toContain("{updateReceiptDoc}");
  });

  it("the double-brace form is accepted as well", async () => {
    writeCustomYaml(["Write the receipt to {{updateReceiptDoc}}."]);
    const { prompt } = await buildDesignReviewUpdatePrompt(
      makeTestConfig({ projectRoot: root }),
      promptParams(receiptDoc),
    );
    expect(prompt).toContain(receiptDoc);
  });

  it("the built-in default carries the contract and needs no token check", async () => {
    fs.mkdirSync(path.join(root, ".pi", "references"), { recursive: true });
    resetPromptConfigCache();
    const { prompt, selection } = await buildDesignReviewUpdatePrompt(
      makeTestConfig({ projectRoot: root }),
      promptParams(receiptDoc),
    );
    expect(selection.source).toBe("default");
    expect(prompt).toContain(receiptDoc);
  });

  it("a missing receipt path is refused by the renderer before any dispatch", async () => {
    let caught: unknown;
    try {
      await buildDesignReviewUpdatePrompt(makeTestConfig({ projectRoot: root }), promptParams(""));
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(DesignReviewUpdateConfigError);
    expect((caught as DesignReviewUpdateConfigError).code).toBe("missing-param");
  });
});
