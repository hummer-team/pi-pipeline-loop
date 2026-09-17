/**
 * @module issue181-confirm-gate-timeline.test
 * Issue 181 end-to-end timeline replay for the owner-only confirm gate.
 *
 * Replays the real incident chain:
 *   1. plan verify passes while a subagent is still live → the owner gate
 *      defers and persists a `confirmGateDeferredAt` stamp (`confirm_gate_deferred`).
 *   2. a CHILD session settles and reaches the gate → the gate is suppressed
 *      (`confirm_gate_suppressed_child`): no popup, no meta write, and the
 *      owner's pending stamp is preserved.
 *   3. the user reloads and runs `/pipeline-resume` → the pending predicate
 *      hits and the owner dialog is re-presented with the three plan options.
 *   4. Approve advances to develop; Reject routes back to clarify.
 */

import { describe, it, expect, afterEach } from "bun:test";
import { mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createAgentSettled } from "../core/agent-settled";
import { createPipelineResumeCommand } from "../commands/pipeline-resume";
import { makeTestConfig, makeTestMeta, createMockCtx } from "./helpers";
import { initAuditLog, getDateAuditFileName } from "../utils/auditLog";
import type { PipelineConfig, SessionMeta } from "../types";

const MANAGER_SYMBOL = Symbol.for("pi-subagents:manager");

describe("Issue 181: owner-only confirm gate recovery timeline", () => {
  let TMP: string;

  afterEach(async () => {
    delete (globalThis as Record<symbol, unknown>)[MANAGER_SYMBOL];
    if (TMP) {
      await rm(TMP, { recursive: true, force: true }).catch(() => {});
    }
  });

  function setManagerRunning(running: boolean): void {
    (globalThis as Record<symbol, unknown>)[MANAGER_SYMBOL] = {
      getRecord: () => undefined,
      hasRunning: () => running,
    };
  }

  /**
   * Builds the manual-plan timeline fixture and returns the shared meta.
   * Step 1 (owner defer) and step 2 (child suppression) are shared across the
   * Approve and Reject cases.
   */
  async function setupAndRunThroughChild(label: string): Promise<{ config: PipelineConfig; meta: SessionMeta }> {
    TMP = join(tmpdir(), `pi-issue181-${label}-` + Date.now());
    await mkdir(TMP, { recursive: true });

    const base = makeTestConfig({ projectRoot: TMP });
    const planStage = {
      ...base.stages.plan,
      nextStage: "develop" as const,
      verify: { require: true },
      allowedWritePaths: ["docs/"],
      confirm: { mode: "manual" as const },
    };
    const config = {
      ...base,
      stages: { ...base.stages, plan: planStage as typeof base.stages.plan },
    } as PipelineConfig;
    await initAuditLog(config);

    const docsDir = join(TMP, "docs", "design");
    await mkdir(docsDir, { recursive: true });
    await writeFile(join(docsDir, "77_Config_plan.md"), "# Plan\nplan content here\n", "utf-8");
    const refDir = join(TMP, ".pi", "references", "plan_spec");
    await mkdir(refDir, { recursive: true });
    await writeFile(
      join(refDir, "verify.md"),
      "---\nrequiredFiles:\n  - \"docs/design/77_Config_plan.md\"\n---\nVerify plan.",
      "utf-8",
    );

    const meta = makeTestMeta({
      currentStage: "plan",
      flowState: "running",
      requirementDoc: "docs/design/77_Config.md",
      pipelineId: `pipe-issue181-${label}`,
    });

    // ── Step 1: owner settle while a subagent is live → defer, stamp persisted ──
    let ownerSelectCalls = 0;
    const ownerCtx = createMockCtx(meta);
    ownerCtx.ui.select = async () => { ownerSelectCalls++; return "Approve & Advance"; };
    setManagerRunning(true);

    await createAgentSettled(config).handler(ownerCtx as any);

    expect(ownerSelectCalls).toBe(0);
    expect(meta.confirmGateDeferredAt?.stage).toBe("plan");
    const deferredAt = meta.confirmGateDeferredAt!.at;

    // ── Step 2: child settle reaches the gate → suppressed, stamp preserved ────
    let childSelectCalls = 0;
    const childCtx = createMockCtx(meta, {
      sessionHeader: { parentSession: "/tmp/parent.jsonl" },
      sessionFile: "/tmp/child.jsonl",
    });
    childCtx.ui.select = async () => { childSelectCalls++; return "Approve & Advance"; };

    await createAgentSettled(config).handler(childCtx as any);

    expect(childSelectCalls).toBe(0);
    expect(meta.confirmGateDeferredAt).toEqual({ stage: "plan", at: deferredAt });
    expect(meta.currentStage).toBe("plan");

    const audit = await readFile(join(TMP, ".pi", "audit", getDateAuditFileName()), "utf-8");
    expect(audit).toContain("confirm_gate_deferred");
    expect(audit).toContain("confirm_gate_suppressed_child");
    expect(audit).not.toContain("confirm_gate_dismissed");

    return { config, meta };
  }

  it("owner defer → child suppressed → reload → /pipeline-resume → Approve advances to develop", async () => {
    const { config, meta } = await setupAndRunThroughChild("approve");

    // ── Step 3: reload → owner /pipeline-resume re-opens the dialog ────────────
    setManagerRunning(false);
    let capturedOptions: string[] = [];
    const resumeCtx = createMockCtx(meta);
    resumeCtx.ui.select = async (_msg: string, options: string[]) => {
      capturedOptions = options;
      return "Approve & Advance";
    };

    const result = await createPipelineResumeCommand(config).execute({}, resumeCtx as any);

    // Owner dialog presented with the three plan options.
    expect(capturedOptions).toEqual([
      "Approve & Advance",
      "Reject & Rework (back to clarify)",
      "Cancel",
    ]);
    // ── Step 4: Approve → develop, pending traces cleared ─────────────────────
    expect((result as any).message).toContain('advanced to "develop"');
    expect(meta.currentStage).toBe("develop");
    expect(meta.confirmGateDeferredAt).toBeUndefined();
  });

  it("owner defer → child suppressed → reload → /pipeline-resume → Reject routes to clarify", async () => {
    const { config, meta } = await setupAndRunThroughChild("reject");

    setManagerRunning(false);
    let capturedOptions: string[] = [];
    const resumeCtx = createMockCtx(meta);
    resumeCtx.ui.select = async (_msg: string, options: string[]) => {
      capturedOptions = options;
      return "Reject & Rework (back to clarify)";
    };

    const result = await createPipelineResumeCommand(config).execute({}, resumeCtx as any);

    expect(capturedOptions).toContain("Reject & Rework (back to clarify)");
    // ── Step 4: Reject → clarify (180 routing semantics preserved) ────────────
    expect((result as any).message).toContain('"clarify"');
    expect(meta.currentStage).toBe("clarify");
    expect(meta.confirmGateDeferredAt).toBeUndefined();
  });
});
