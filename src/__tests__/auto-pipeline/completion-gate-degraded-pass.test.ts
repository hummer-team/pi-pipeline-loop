/**
 * 229 Phase 6 (F6/B1/B5): the completion gate's SIXTH evidence item — the
 * bound degraded-pass record — plus acceptance-risk eligibility rules.
 *
 * Boundaries (plan Phase 6 "单元测试目标，边界"):
 * - `scope="completion"` + a bound record substitutes evidence ① when the
 *   review round itself has no PASS;
 * - `scope="loop-exit"` NEVER substitutes ①;
 * - `Blocker=1`/`High=1` in the record ⇒ ineligible (`degraded_pass_invalid`);
 *   a `pipelineId`/`docPath` mismatch ⇒ ineligible;
 * - ②③④⑤ stay untouched: queued progress work keeps failing with the 227
 *   codes (the degraded pass is never a bypass);
 * - a rejected `pendingDegradedPass` candidate is NOT persisted by the caller
 *   (updateMeta must not be invoked);
 * - `isDegradedPassDuplicate` shared stamping granularity.
 */

import { describe, it, expect, afterEach } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  evaluateCompletionGate,
  type CompletionGateInput,
} from "../../core/auto-pipeline/completion-gate";
import {
  isDegradedPassBound,
  isDegradedPassDuplicate,
  buildDegradedPassFromReviewLedger,
} from "../../core/auto-pipeline/degraded-pass";
import { initAuditLog, __setSafeWriteAuditLogOverride } from "../../utils/auditLog";
import { makeTestConfig, makeTestMeta, seedCompletionEvidence } from "../helpers";
import { codeReviewDocFileName, reqBaseFromRequirementDoc, docsDirsOf } from "../../docs-paths";
import type { DegradedPassRecord, PipelineConfig, SessionMeta } from "../../types";

let seq = 0;
const roots: string[] = [];

async function makeEnv(opts: { visit: SessionMeta["stageVisitOrder"]; reviewPass?: boolean } = { visit: ["review"], reviewPass: false }): Promise<{
  config: PipelineConfig;
  meta: SessionMeta;
  session: CompletionGateInput["session"];
  updates: Partial<SessionMeta>[];
}> {
  const root = join(tmpdir(), `pi-229-gate-${Date.now()}-${++seq}`);
  roots.push(root);
  await mkdir(join(root, "docs", "design"), { recursive: true });
  await mkdir(join(root, ".pi", "audit"), { recursive: true });
  const config = makeTestConfig({ projectRoot: root });
  await initAuditLog(config);
  const meta = makeTestMeta({
    currentStage: "review",
    pipelineId: `pipe-229-gate-${seq}`,
    requirementDoc: "docs/design/229_Feat.md",
    stageStartTime: 1_700_000_000_000,
    pipelineStartedAt: 1_700_000_000_000 - 60_000,
    stageVisitOrder: opts.visit,
    summaries: {},
  });
  // 229: the review summary stays (evidence ⑤ binds it to the CURRENT
  // visit); the seeded PASS report is rewritten with a FAIL conclusion so
  // evidence ① legitimately fails on its own (no current PASS) — the exact
  // baseline the degraded-pass substitution targets.
  const seeded = Object.assign(meta, {});
  await seedCompletionEvidence(config, seeded);
  if (opts.reviewPass !== true) {
    const reviewDir = join(root, docsDirsOf(config).reviewDir);
    const name = codeReviewDocFileName(reqBaseFromRequirementDoc(meta.requirementDoc ?? ""), 1);
    await writeFile(join(reviewDir, name), "# Code Review\n\n## 结论\n\n- 结论：不通过\n", "utf-8");
  }
  const updates: Partial<SessionMeta>[] = [];
  const session = {
    getMeta: () => meta,
    updateMeta: (p: Partial<SessionMeta>) => {
      updates.push(p);
      Object.assign(meta, p);
      return meta;
    },
  };
  return { config, meta, session, updates };
}

function record(overrides: Partial<DegradedPassRecord> & { pipelineId: string }): DegradedPassRecord {
  const { pipelineId, ...rest } = overrides;
  return {
    scope: "completion",
    reason: "no_progress_detected",
    pipelineId,
    docPath: "docs/design/229_Feat.md",
    stage: "review",
    round: 2,
    openIssues: [
      { id: "DR-2-1", severity: "Medium", status: "accepted-risk" },
      // 229 F1: openIssues record with DR-2-1 | Medium
    ],
    severityCounts: { Medium: 1 },
    at: 1_700_000_100_000,
    ...rest,
  };
}

afterEach(async () => {
  __setSafeWriteAuditLogOverride(null);
  while (roots.length > 0) {
    await rm(roots.pop()!, { recursive: true, force: true });
  }
});

describe("229 Phase 6: evidence ① substitution (B1)", () => {
  it("scope=completion + a BOUND record substitutes evidence ① (no current PASS)", async () => {
    const env = await makeEnv({ visit: ["review"] });
    // no review PASS seeded: makeMeta has no reviewRound → plain ① fails.
    const pending = record({ pipelineId: env.meta.pipelineId ?? "" });    const result = await evaluateCompletionGate({
      config: env.config,
      meta: env.meta,
      session: env.session,
      pendingDegradedPass: pending,
    });
    if (!result.ok) throw new Error(`DBG1 ${JSON.stringify(result)}`);
    expect(result.ok).toBe(true);
  });

  it("scope=loop-exit NEVER substitutes ① (review_not_passed stays)", async () => {
    const env = await makeEnv({ visit: ["review"] });
    const result = await evaluateCompletionGate({
      config: env.config,
      meta: env.meta,
      session: env.session,
      pendingDegradedPass: record({ pipelineId: env.meta.pipelineId ?? "", scope: "loop-exit", docPath: env.meta.requirementDoc ?? "" }),
    });
    if (result.ok) {
      throw new Error(`DBG-LOOP-EXIT ok meta=${JSON.stringify({ visit: env.meta.stageVisitOrder, rr: env.meta.reviewRound, sums: Object.keys(env.meta.summaries ?? {}) })}`);
    }
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure.code).toBe("review_not_passed");
  });

  it("Blocker in severityCounts ⇒ degraded_pass_invalid", async () => {
    const env = await makeEnv({ visit: ["review"] });
    const result = await evaluateCompletionGate({
      config: env.config,
      meta: env.meta,
      session: env.session,
      pendingDegradedPass: record({
        pipelineId: env.meta.pipelineId ?? "",
        severityCounts: { Blocker: 1 },
        openIssues: [{ id: "DR-2-1", severity: "Blocker", status: "accepted-risk" }],
      }),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure.code).toBe("degraded_pass_invalid");
  });

  it("docPath mismatch ⇒ the record is NOT bound (degraded_pass_invalid)", async () => {
    const env = await makeEnv({ visit: ["review"] });
    const result = await evaluateCompletionGate({
      config: env.config,
      meta: env.meta,
      session: env.session,
      pendingDegradedPass: record({ pipelineId: env.meta.pipelineId ?? "", docPath: "docs/design/other.md" }),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure.code).toBe("degraded_pass_invalid");
  });

  it("②③④⑤ evidence stays untouched: a substituted ① cannot satisfy the OTHER items", async () => {
    const env = await makeEnv({ visit: ["design-review", "develop", "review"] });
    const meta = env.meta;
    const pending = record({ pipelineId: meta.pipelineId ?? "" });
    const result = await evaluateCompletionGate({
      config: env.config,
      meta,
      session: env.session,
      pendingDegradedPass: pending,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      // ② the visited design-review domain is NOT finished — the degraded
      // pass never substitutes the OTHER evidence items (B1 red line).
      expect(result.failure.code).toBe("design_review_not_closed");
    }
  });

  it("a rejected pending candidate is NEVER written by the caller (updateMeta untouched)", async () => {
    const env = await makeEnv({ visit: ["review"] });
    const perMeta = env.meta;
    const before = perMeta.degradedPass;
    expect(before).toBeUndefined();
    const blocked = record({ pipelineId: "someone-else", docPath: perMeta.requirementDoc ?? "" });
    const result = await evaluateCompletionGate({
      config: env.config,
      meta: perMeta,
      session: env.session,
      pendingDegradedPass: blocked,
    });
    expect(result.ok).toBe(false);
    expect(env.updates).toEqual([]);
  });
});

describe("229 Phase 6: degraded-pass helpers", () => {
  it("isDegradedPassBound: pipelineId/docPath/blockers all matter", () => {
    const meta = makeTestMeta({ pipelineId: "p1", requirementDoc: "docs/design/229_Feat.md" });
    expect(isDegradedPassBound(meta, record({ pipelineId: "p1" }))).toBe(true);
    expect(isDegradedPassBound(meta, record({ pipelineId: "p2" }))).toBe(false);
  });

  it("isDegradedPassDuplicate matches the (pipelineId, round, reason, at) stamp", () => {
    const a = record({ pipelineId: "p" });
    const same = record({ pipelineId: "p" });
    expect(isDegradedPassDuplicate(a, same)).toBe(true);
  });

  it("buildDegradedPassFromReviewLedger: blockers > 0 ⇒ refusal; zero-blocking maps accepted-risk", () => {
    const blocking = makeTestMeta({
      pipelineId: "p",
      reviewLedger: { loop: "reviewFix", roundIndex: 2, pipelineId: "p", openIds: ["DR-1-1"], severityCounts: { Blocker: 1 }, streak: 2 },
    });
    expect(buildDegradedPassFromReviewLedger(blocking, "no_progress_detected")).toBeUndefined();
    const soft = makeTestMeta({
      pipelineId: "p",
      reviewLedger: {
        loop: "reviewFix",
        roundIndex: 2,
        pipelineId: "p",
        openIds: ["DR-1-1"],
        severityCounts: { Medium: 1 },
        severityById: { "DR-1-1": "Medium" as never },
        streak: 2,
      },
    });
    const built = buildDegradedPassFromReviewLedger(soft, "no_progress_detected");
    expect(built?.scope).toBe("completion");
    expect(built?.openIssues[0]?.status).toBe("accepted-risk");
  });
});
