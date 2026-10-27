/**
 * 210 Phase 5 tests — `/pipeline-status` running / terminal views.
 *
 * Plan acceptance:
 * - every running field appears and never renders `undefined` (missing → N/A);
 * - `completed` and `aborted` return the Last Run terminal view with the REAL
 *   audit directory (fs.existsSync proof);
 * - cleared meta (post `/pipeline-quit`) still returns the DORMANT message
 *   BYTE-IDENTICAL to the baseline;
 * - 210 review issue 12 (requirement 5.6): a pending decision additionally
 *   states WHO is waiting (human) and the `/pipeline-resume` action, while an
 *   idle pipeline keeps the bare `none`.
 */

import { describe, it, expect } from "bun:test";
import * as fs from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPipelineStatusCommand, renderRunningStatus } from "../../commands/pipeline-status";
import { initAuditLog, auditLogDirForPipeline, safeWriteAuditLog } from "../../utils/auditLog";
import { makeTestConfig, makeTestMeta } from "../helpers";
import { DORMANT_NO_PIPELINE_MESSAGE } from "../../core/dormancy";
import type { PipelineStage, SessionMeta } from "../../types";

async function statusContent(config: ReturnType<typeof makeTestConfig>, meta: SessionMeta | undefined): Promise<string> {
  const cmd = createPipelineStatusCommand(config);
  const ctx = { session: { getMeta: () => meta } };
  const result = (await cmd.execute({}, ctx as any)) as { success: boolean; content: string };
  expect(result.success).toBe(true);
  return result.content;
}

/** Extract the value after "- <label>: " from rendered content. */
function lineValue(content: string, label: string): string {
  const line = content.split("\n").find((l) => l.startsWith(`- ${label}:`));
  return line ? line.slice(label.length + 3).trim() : "";
}

describe("210 Phase 5: running view fields", () => {
  it("shows every decision-debt field with real values (no undefined anywhere)", async () => {
    const config = makeTestConfig();
    const meta = makeTestMeta({
      currentStage: "develop",
      pipelineId: `pipe-210-status-run-${Date.now()}`,
      requirementDoc: "docs/design/77_Config.md",
      stageStartTime: Date.now() - 90_000,
      pipelineStartedAt: Date.now() - 300_000,
      verifyAttempts: 1,
      confirmRejections: 2,
      loopCycleCount: 1,
      stageVisitOrder: ["clarify", "plan", "develop"],
    });

    const content = await statusContent(config, meta);

    expect(content).not.toContain("undefined");
    // Baseline lines stay (byte-for-byte contract with existing consumers).
    expect(content).toContain("- ID: pipe-210-status-run-");
    expect(content).toContain("- Loop: 0/3 (Step: 0)");
    // New Phase 5 lines.
    expect(lineValue(content, "Requirement")).toBe("docs/design/77_Config.md");
    expect(lineValue(content, "Stage started")).not.toBe("N/A");
    expect(lineValue(content, "Stage started")).toContain("ago");
    expect(lineValue(content, "Elapsed")).toMatch(/\dm \d\ds/); // ~5m
    expect(lineValue(content, "Verify attempts")).toBe("1 / 3");
    expect(lineValue(content, "Confirm rejections")).toBe("2 / 5"); // default cap 5
    expect(lineValue(content, "Loop budget")).toContain("1/5"); // DEFAULT_MAX_LOOP_CYCLES
    expect(lineValue(content, "Pending decision")).toBe("none");
    // The fixed order from the plan is preserved.
    const order = ["Requirement", "Stage started", "Elapsed", "Verify attempts", "Confirm rejections", "Loop budget", "Pending decision", "Audit"];
    let last = -1;
    for (const label of order) {
      const idx = content.indexOf(`- ${label}:`);
      expect(idx).toBeGreaterThan(last);
      last = idx;
    }
  });

  it("missing values render N/A, never undefined", async () => {
    const config = makeTestConfig();
    const meta = makeTestMeta({
      currentStage: "clarify",
      pipelineId: `pipe-210-status-na-${Date.now()}`,
      requirementDoc: undefined,
      stageStartTime: undefined,
      pipelineStartedAt: undefined,
    });

    const content = await statusContent(config, meta);

    expect(content).not.toContain("undefined");
    expect(lineValue(content, "Requirement")).toBe("N/A");
    expect(lineValue(content, "Stage started")).toBe("N/A");
    expect(lineValue(content, "Elapsed")).toBe("N/A");
  });

  it("pending decision merges blocked / reask / deferral stamps", async () => {
    const config = makeTestConfig();
    const meta = makeTestMeta({
      currentStage: "plan",
      pipelineId: `pipe-210-status-pd-${Date.now()}`,
      flowState: "blocked" as SessionMeta["flowState"],
      blockedReason: "verify_attempt_overflow",
      confirmGateReask: { stage: "plan", count: 2 },
    });

    const content = await statusContent(config, meta);
    const pd = lineValue(content, "Pending decision");
    expect(pd).toContain("blocked (verify_attempt_overflow)");
    expect(pd).toContain("confirm pending @plan (reprompt 2/3)");
    expect(pd).toContain("[human confirm]");
  });

  it("audit anchor points at the per-pipeline audit directory", async () => {
    const root = join(tmpdir(), `pi-210-status-audit-${Date.now()}`);
    await mkdir(join(root, ".pi", "audit"), { recursive: true });
    const config = makeTestConfig({ projectRoot: root });
    await initAuditLog(config);
    const meta = makeTestMeta({
      currentStage: "develop",
      pipelineId: `pipe-210-status-anchor-${Date.now()}`,
    });

    // An audit write creates the directory lazily (initAuditLog never mkdirs).
    await safeWriteAuditLog("phase5_probe", { pipelineId: meta.pipelineId });

    const content = await statusContent(config, meta);
    const anchor = lineValue(content, "Audit");
    expect(anchor).toBe(auditLogDirForPipeline(meta.pipelineId) ?? "N/A");
    expect(fs.existsSync(anchor)).toBe(true);

    await rm(root, { recursive: true, force: true });
  });
});

describe("210 Phase 5: terminal view", () => {
  it("completed pipeline renders the Last Run view (not the dormant message)", async () => {
    const config = makeTestConfig();
    const meta = makeTestMeta({
      currentStage: "completed",
      pipelineId: `pipe-210-status-done-${Date.now()}`,
      requirementDoc: "docs/design/77_Config.md",
      stageVisitOrder: ["clarify", "plan", "develop", "completed"],
      stageStats: {
        clarify: { durationMs: 125_000, verifyAttempts: 0, confirmRejections: 0 },
        develop: { durationMs: 60_000, verifyAttempts: 2, confirmRejections: 1 },
      },
      confirmRejections: 1,
      summaries: { develop: { path: "/tmp/dev-summary.md", hash: "h", status: "valid" } },
    });

    const content = await statusContent(config, meta);

    expect(content).toContain("## Last Run (terminal)");
    expect(content).not.toContain("No active pipeline");
    expect(lineValue(content, "Flow state")).toBe("completed");
    expect(lineValue(content, "Stage")).toBe("completed");
    expect(lineValue(content, "Stage visits")).toBe("clarify → plan → develop → completed");
    expect(lineValue(content, "Stage stats")).toContain("clarify 2m 05s (verify 0, confirm 0)");
    expect(lineValue(content, "Stage stats")).toContain("develop 1m 00s (verify 2, confirm 1)");
    expect(lineValue(content, "Requirement")).toBe("docs/design/77_Config.md");
    expect(lineValue(content, "Summaries")).toBe("develop: /tmp/dev-summary.md");
    expect(content).toContain("most recent run of the CURRENT session only");
  });

  it("aborted pipeline renders the Last Run view with the abort reason", async () => {
    const config = makeTestConfig();
    const meta = makeTestMeta({
      currentStage: "develop" as PipelineStage,
      pipelineId: `pipe-210-status-abort-${Date.now()}`,
      flowState: "aborted",
      terminateReason: "session_quit",
    });

    const content = await statusContent(config, meta);

    expect(content).toContain("## Last Run (terminal)");
    expect(lineValue(content, "Flow state")).toBe("aborted (reason: session_quit)");
    expect(lineValue(content, "Stage")).toBe("develop");
    // Empty accumulators degrade to N/A (never undefined).
    expect(lineValue(content, "Stage stats")).toBe("N/A");
    expect(lineValue(content, "Summaries")).toBe("N/A");
    expect(content).not.toContain("undefined");
  });
});

describe("210 Phase 5: dormant contracts preserved", () => {
  it("cleared meta (post /pipeline-quit) returns the baseline dormant message verbatim", async () => {
    const config = makeTestConfig();
    const content = await statusContent(config, undefined);
    expect(content).toBe(DORMANT_NO_PIPELINE_MESSAGE);
  });

  it("meta without pipelineId (never started) returns the dormant message verbatim", async () => {
    const config = makeTestConfig();
    const content = await statusContent(config, makeTestMeta({ pipelineId: "" }));
    expect(content).toBe(DORMANT_NO_PIPELINE_MESSAGE);
  });

  it("existing running-view consumers keep their lines (baseline header intact)", async () => {
    const config = makeTestConfig();
    const meta = makeTestMeta({
      currentStage: "develop",
      pipelineId: `pipe-210-status-base-${Date.now()}`,
      currentModel: { provider: "openai", modelId: "deepseek-v4" },
    });
    const content = await statusContent(config, meta);
    expect(content.startsWith("# Pipeline Status\n- ID: pipe-210-status-base-")).toBe(true);
    expect(content).toContain("- Model: deepseek-v4");
    expect(content).toContain("- Domain: general@latest");
  });
});

// ─── 210 review issue 12 (requirement 5.6): actionable pending-decision view ─

describe("210 review issue 12: pending decision states who waits + resume action", () => {
  it("a frozen pipeline names the waiting party and points at /pipeline-resume", async () => {
    const config = makeTestConfig();
    const meta = makeTestMeta({
      currentStage: "review",
      pipelineId: `pipe-210-status-hint-${Date.now()}`,
      flowState: "blocked" as SessionMeta["flowState"],
      blockedReason: "decision_timeout",
    });

    const pd = lineValue(await statusContent(config, meta), "Pending decision");
    // WHO is waiting: a human, never an automatic next step (requirement 5.6).
    expect(pd).toContain("waiting on: human");
    expect(pd).toContain("[human decision]");
    // HOW to unblock: the shared decision-menu hint (single source of truth).
    expect(pd).toContain("/pipeline-resume");
    expect(pd).toContain("--force-resume");
  });

  it("a confirm-gate reask names the human confirm as the waiting party", async () => {
    const config = makeTestConfig();
    const meta = makeTestMeta({
      currentStage: "plan",
      pipelineId: `pipe-210-status-confirm-${Date.now()}`,
      confirmGateReask: { stage: "plan", count: 1 },
    });

    const pd = lineValue(await statusContent(config, meta), "Pending decision");
    expect(pd).toContain("confirm pending @plan (reprompt 1/3)");
    expect(pd).toContain("[human confirm]");
    expect(pd).toContain("/pipeline-resume");
  });

  it("nothing pending stays a bare 'none' (no misleading resume guidance)", async () => {
    const config = makeTestConfig();
    const meta = makeTestMeta({
      currentStage: "develop",
      pipelineId: `pipe-210-status-none-${Date.now()}`,
    });

    const pd = lineValue(await statusContent(config, meta), "Pending decision");
    expect(pd).toBe("none");
  });
});

// ─── 211 Phase 2: one actionable line for both confirm-gate traces ──────────

describe("211 Phase 2: merged confirm-pending pending-decision line", () => {
  it("defer stamp only still renders the [human confirm] tag with reprompt 0/3 (review observation 4)", async () => {
    const config = makeTestConfig();
    const meta = makeTestMeta({
      currentStage: "plan",
      pipelineId: `pipe-211-status-defer-${Date.now()}`,
      confirmGateDeferredAt: { stage: "plan", at: Date.now() - 5_000 },
    });

    const pd = lineValue(await statusContent(config, meta), "Pending decision");
    expect(pd).toContain("confirm pending @plan (reprompt 0/3)");
    expect(pd).toContain("[human confirm]");
    expect(pd).toContain("/pipeline-resume");
  });

  it("reask only renders the merged line with the live reask count", async () => {
    const config = makeTestConfig();
    const meta = makeTestMeta({
      currentStage: "plan",
      pipelineId: `pipe-211-status-reask-${Date.now()}`,
      confirmGateReask: { stage: "plan", count: 2 },
    });

    const pd = lineValue(await statusContent(config, meta), "Pending decision");
    expect(pd).toContain("confirm pending @plan (reprompt 2/3)");
    expect(pd).toContain("[human confirm]");
  });

  it("defer + reask coexisting renders exactly one confirm line (no double bits)", async () => {
    const config = makeTestConfig();
    const meta = makeTestMeta({
      currentStage: "plan",
      pipelineId: `pipe-211-status-both-${Date.now()}`,
      confirmGateDeferredAt: { stage: "plan", at: Date.now() - 5_000 },
      confirmGateReask: { stage: "plan", count: 1 },
    });

    const pd = lineValue(await statusContent(config, meta), "Pending decision");
    expect((pd.match(/confirm pending/g) ?? []).length).toBe(1);
    expect(pd).toContain("confirm pending @plan (reprompt 1/3)");
  });

  it("no pending traces keeps the bare 'none' (no misleading hint)", async () => {
    const config = makeTestConfig();
    const meta = makeTestMeta({
      currentStage: "develop",
      pipelineId: `pipe-211-status-clean-${Date.now()}`,
    });

    const pd = lineValue(await statusContent(config, meta), "Pending decision");
    expect(pd).toBe("none");
  });
});

// ─── 213 Phase 0 (D17-③): the optional caller identity on the running view ──

describe("213 P0: renderRunningStatus owner-evidence rows via the optional actor", () => {
  /** A decision-pending meta with recorded owner evidence at OWNER_FILE. */
  const OWNER_FILE = "/tmp/213-owner-session.jsonl";
  function pendingReviewMeta(): SessionMeta {
    const now = Date.now();
    return makeTestMeta({
      currentStage: "design-review" as PipelineStage,
      designReview: {
        schemaVersion: 1,
        planDoc: "/tmp/plan.md",
        planHash: "hash-plan",
        round: 1,
        authorizationId: "auth-213",
        authorizationSource: "menu",
        reportDoc: "/tmp/report.md",
        phase: "paused",
        pauseReason: "decision-pending",
        authorizedAt: now,
        updatedAt: now,
        decision: {
          state: "pending",
          decisionId: "dec-213",
          reviewIdentity: {
            pipelineId: "pipe-213",
            planDoc: "/tmp/plan.md",
            authorizationId: "auth-213",
            round: 1,
            operationId: "op-213",
            stageVisitId: 1000,
          },
          reportDoc: "/tmp/report.md",
          reportHash: "h",
          planHash: "hash-plan",
          issues: [],
          mode: "manual",
          ownerSessionFile: OWNER_FILE,
          createdAt: now,
        },
      },
    });
  }

  function running(meta: SessionMeta, actor?: Parameters<typeof renderRunningStatus>[4]): string {
    return renderRunningStatus(meta, makeTestConfig(), "", "N/A", actor);
  }

  it("WITHOUT the actor (the 212 shape) the rows keep the unknown-identity sentence — backward compatible", () => {
    const content = running(pendingReviewMeta());
    expect(content).toContain(
      `owner evidence recorded at ${OWNER_FILE} — answerable only in that session, or by an explicit takeover in an interactive session`,
    );
    // No child sentence leaks into an unknown-identity render.
    expect(content).not.toContain("a subagent session cannot");
  });

  it("non-child caller of ANOTHER session ⇒ recorded_unprovable row on BOTH lines (merged Pending decision + 193 Decision block)", () => {
    const content = running(pendingReviewMeta(), { isChild: false, sessionFile: "/tmp/other.jsonl" });
    const hits = content.split("\n").filter((l) => l.includes("not this session — run /pipeline-resume here to take over"));
    expect(hits.length).toBe(2);
  });

  it("child caller ⇒ recorded row with the dedicated child sentence, never the takeover promise", () => {
    const content = running(pendingReviewMeta(), { isChild: true, sessionFile: "/tmp/child.jsonl", parentSessionFile: OWNER_FILE });
    expect(content).toContain("a subagent session cannot answer or take over; ask the parent session");
    expect(content).not.toContain("run /pipeline-resume here to take over");
  });

  it("the command surface resolves the identity itself: a sessionManager ctx of ANOTHER file renders the unprovable row", async () => {
    const config = makeTestConfig();
    const meta = pendingReviewMeta();
    const cmd = createPipelineStatusCommand(config);
    const ctx = {
      session: { getMeta: () => meta },
      _ctx: { sessionManager: { getSessionFile: () => "/tmp/foreign.jsonl", getSessionName: () => "main", getHeader: () => undefined } },
    };
    const result = (await cmd.execute({}, ctx as any)) as { success: boolean; content: string };
    expect(result.success).toBe(true);
    expect(result.content).toContain(
      `owner evidence recorded at ${OWNER_FILE}, not this session — run /pipeline-resume here to take over`,
    );
  });
});
