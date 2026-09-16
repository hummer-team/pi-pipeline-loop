/**
 * @module issue180-confirm-gate-timeline.test
 * Issue 180 end-to-end audit-timeline replay for the manual confirm gate.
 *
 * Replays the real incident chain:
 *   1. plan verify passes while the plan subagent is still live → the gate
 *      defers (`confirm_gate_deferred`), no popup.
 *   2. the subagent settles → the gate pops, but the dialog is dismissed in
 *      <1500ms (collateral cancel) → `confirm_gate_dismiss_interrupted`.
 *   3. the user reloads and runs `/pipeline-resume` → the pending-gate predicate
 *      hits → the EXISTING dialog is re-presented (`ctx.ui.select` called again).
 *
 * The session-starter reload status-bar segment is covered by the Phase 0
 * cases in `core/session-starter.test.ts` (owner reload/resume restore).
 */

import { describe, it, expect, afterEach } from "bun:test";
import { mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createAgentSettled } from "../core/agent-settled";
import { createPipelineResumeCommand } from "../commands/pipeline-resume";
import { makeTestConfig, makeTestMeta, createMockCtx } from "./helpers";
import { initAuditLog, getDateAuditFileName } from "../utils/auditLog";
import type { PipelineConfig } from "../types";

const MANAGER_SYMBOL = Symbol.for("pi-subagents:manager");

describe("Issue 180: confirm-gate recovery timeline", () => {
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

  it("verify → subagent-live defer → collateral dismiss → /pipeline-resume re-opens the dialog", async () => {
    TMP = join(tmpdir(), "pi-issue180-timeline-" + Date.now());
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

    // Plan doc + verify.md (requiredFiles rule passes → verification reaches the gate).
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
      pipelineId: "pipe-issue180-timeline",
    });

    const selectMessages: string[] = [];
    const ctx = createMockCtx(meta);
    ctx.ui.select = async (msg: string) => {
      selectMessages.push(msg);
      return undefined; // immediate collateral dismiss
    };

    const settled = createAgentSettled(config);

    // ── Step 1: plan subagent still live → gate defers, no popup ─────────────
    setManagerRunning(true);
    await settled.handler(ctx as any);

    expect(selectMessages.length).toBe(0);
    expect(meta.confirmGateDeferredAt?.stage).toBe("plan");

    let audit = await readFile(join(TMP, ".pi", "audit", getDateAuditFileName()), "utf-8");
    expect(audit).toContain("confirm_gate_deferred");

    // ── Step 2: subagent settles → popup presented, immediately dismissed ────
    setManagerRunning(false);
    await settled.handler(ctx as any);

    expect(selectMessages.length).toBe(1);
    expect(meta.confirmGateReask).toEqual({ stage: "plan", count: 1 });

    audit = await readFile(join(TMP, ".pi", "audit", getDateAuditFileName()), "utf-8");
    expect(audit).toContain("confirm_gate_dismiss_interrupted");

    // ── Step 3: reload → /pipeline-resume → predicate hits → dialog reappears ─
    let resumeSelectCalls = 0;
    ctx.ui.select = async () => {
      resumeSelectCalls++;
      return undefined;
    };

    const cmd = createPipelineResumeCommand(config);
    const result = await cmd.execute({}, ctx as any);

    // The dialog was re-presented (the incident's missing recovery path).
    expect(resumeSelectCalls).toBe(1);
    // Pending → the running status text is returned.
    expect((result as any).message).toContain("No resume needed");

    audit = await readFile(join(TMP, ".pi", "audit", getDateAuditFileName()), "utf-8");
    // The resume-triggered dismiss is attributed to the resume source.
    expect(audit).toContain("source=resume");
  });
});
