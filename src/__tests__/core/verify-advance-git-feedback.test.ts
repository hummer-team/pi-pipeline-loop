/**
 * 225 Phase 1 (T4): verify-advance corrective wiring for git delivery failures.
 *
 * Contract points:
 * - a `commit_proof` failure activates the git corrective text and the
 *   `commit evidence invalid` fail label, plus the `git_delivery_feedback`
 *   audit (stage / ruleTypes / expectedDoc);
 * - documented precedence: report feedback > plan feedback > git feedback;
 * - non-git failures leave the existing labels and messages untouched.
 */

import { describe, it, expect, beforeEach, afterEach, afterAll } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { applyVerifyFail } from "../../core/verify-advance";
import { __setSafeWriteAuditLogOverride, __resetAuditDirPath } from "../../utils/auditLog";
import { makeTestConfig, makeTestMeta, createMockCtx } from "../helpers";
import { COMMIT_PROOF_GROUP } from "../../core/commit-proof";
import { DESIGN_REVIEW_REPORT_RULE_TYPE } from "../../core/design-review/report-feedback";
import { createInitialState, computeHash } from "../../core/design-review/state";
import { clearAllDecisionTimers } from "../../core/flow-state";
import type { PipelineStage, SessionMeta, VerifyFailureItem } from "../../types";

const PIPELINE_ID = "pipe-git-feedback-225";
const OP_ID = "op-git-feedback-1";

const audits: { event: string; fields: Record<string, string | boolean>; level?: string }[] = [];

afterEach(() => {
  __setSafeWriteAuditLogOverride(null);
  audits.length = 0;
});

afterAll(() => {
  clearAllDecisionTimers();
  __resetAuditDirPath();
});

function installAuditCapture(): void {
  audits.length = 0;
  __setSafeWriteAuditLogOverride(async (event, message, level) => {
    audits.push({ event, fields: (message ?? {}) as Record<string, string | boolean>, level });
  });
}

function gitFailure(ruleType: string, detail: string): VerifyFailureItem {
  return { ruleType, detail, group: COMMIT_PROOF_GROUP, timestamp: Date.now() };
}

function failure(ruleType: string, detail: string, group?: string): VerifyFailureItem {
  return { ruleType, detail, ...(group ? { group } : {}), timestamp: Date.now() };
}

let projectRoot: string;
let planDoc: string;
let planHash: string;

beforeEach(async () => {
  projectRoot = fs.mkdtempSync(path.join(tmpdir(), "git-feedback-"));
  fs.mkdirSync(path.join(projectRoot, "docs"), { recursive: true });
  planDoc = path.join(projectRoot, "docs", "225_Feat_Plan.md");
  fs.writeFileSync(planDoc, "# Plan\nv1\n", "utf-8");
  planHash = computeHash(fs.readFileSync(planDoc, "utf-8"));
});

interface Harness {
  meta: SessionMeta;
  result: { message?: string; success?: boolean };
}

async function runHarness(opts: {
  stage: PipelineStage;
  failures: VerifyFailureItem[];
  designReview?: boolean;
}): Promise<Harness> {
  const base: Partial<SessionMeta> = {
    currentStage: opts.stage,
    requirementDoc: "docs/225_Feat.md",
    verifyAttempts: 0,
  };
  if (opts.designReview) {
    const initialState = createInitialState(planDoc, "menu", planHash, "/tmp/owner.jsonl", {
      pipelineId: PIPELINE_ID,
    });
    base.designReview = {
      ...initialState,
      phase: "review_running",
      operation: {
        operationId: OP_ID,
        kind: "review",
        stageVisitId: 1000,
        attempt: 1,
        dispatchState: "dispatched",
        agentId: "agent-1",
        inputHash: planHash,
        round: 1,
        createdAt: 1,
        updatedAt: 1,
      },
    };
  }
  const meta = makeTestMeta({
    pipelineId: PIPELINE_ID,
    ...base,
  } as Partial<SessionMeta>);
  const ctx = createMockCtx(meta);
  const result = await applyVerifyFail(
    ctx as never,
    meta,
    opts.stage,
    {
      structuredResult: { failures: opts.failures },
      ruleMissing: [],
    } as never,
    "rule",
    undefined,
    makeTestConfig({ projectRoot, maxVerifyAttempts: 99 }),
  );
  return { meta, result };
}

describe("verify-advance git feedback wiring", () => {
  it("commit_exists failure → corrective message + commit evidence invalid label + audit", async () => {
    installAuditCapture();
    const { result } = await runHarness({
      stage: "fix",
      failures: [gitFailure("commit_exists", 'declared commit id "dead0001" failed (exit 128): bad')],
    });
    expect(result.message).toContain('Commit evidence invalid: declared id "dead0001"');
    const audit = audits.find((a) => a.event === "git_delivery_feedback");
    expect(audit).toBeDefined();
    expect(String(audit!.fields.ruleTypes)).toContain("commit_exists");
    expect(audit!.fields.stage).toBe("fix");
  });

  it("plan feedback keeps priority over git feedback when both could fire (plan stage)", async () => {
    installAuditCapture();
    const { result } = await runHarness({
      stage: "plan",
      failures: [
        failure("requiredFiles", "Missing files: docs/225_Feat_Plan.md"),
        gitFailure("commit_exists", 'declared commit id "dead0001" failed (exit 128): bad'),
      ],
    });
    // Plan correction wins; the git message is secondary.
    expect(String(result.message ?? "")).toContain("docs/225_Feat_Plan.md");
    expect(String(result.message ?? "")).not.toContain("Commit evidence invalid");
  });

  it("report feedback keeps priority over git feedback (design-review)", async () => {
    installAuditCapture();
    const { result } = await runHarness({
      stage: "design-review",
      failures: [
        failure(DESIGN_REVIEW_REPORT_RULE_TYPE, "Summary section has no content"),
        gitFailure("commit_exists", 'declared commit id "dead0001" failed (exit 128): bad'),
      ],
      designReview: true,
    });
    expect(String(result.message ?? "")).toContain("Identity");
    expect(String(result.message ?? "")).not.toContain("Commit evidence invalid");
  });

  it("non-git failures keep the baseline label and message", async () => {
    installAuditCapture();
    const { result } = await runHarness({
      stage: "fix",
      failures: [failure("requiredFiles", "Missing files: docs/225_Feat_Plan.md")],
    });
    expect(String(result.message ?? "")).not.toContain("Commit evidence invalid");
    expect(audits.some((a) => a.event === "git_delivery_feedback")).toBe(false);
  });
});
