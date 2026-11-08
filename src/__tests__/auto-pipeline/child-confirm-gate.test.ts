/**
 * 227 Phase 1 (D-7): an auto-job CHILD never evaluates a confirm gate.
 *
 * The overlay flips the owner's stage to `auto`, but a gate can still exist
 * (`smart` + complex, or a stage the job left manual). The owner alone decides;
 * the child answers `no-gate` with ZERO side effects (no deferral stamp, no
 * re-ask counter, no marker write). A human-track child keeps the 181
 * suppression behaviour verbatim.
 */
import { describe, it, expect, beforeEach } from "bun:test";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { maybeHandleConfirmGate } from "../../core/stage-advancer";
import { initAuditLog } from "../../utils/auditLog";
import { makeTestConfig, makeTestMeta, createMockCtx, auditLogFileFor } from "../helpers";
import type { PipelineConfig } from "../../types";

let seq = 0;

function config(confirmMode: "manual" | "smart" | "auto"): PipelineConfig {
  const base = makeTestConfig();
  return {
    ...base,
    stages: {
      ...base.stages,
      plan: { ...base.stages.plan, confirm: { mode: confirmMode } },
    },
  };
}

const ui = { notify: () => {}, select: async () => undefined } as never;

const autoMeta = () =>
  makeTestMeta({
    currentStage: "plan",
    pipelineId: `pipe-227-child-gate-${Date.now()}-${++seq}`,
    requirementDoc: "docs/design/227_Bug.md",
    autoJob: { jobId: "childgate_loop", jobPath: "docs/jobs/childgate_loop.yaml", docIndex: 0, totalDocs: 1 },
  });

beforeEach(async () => {
  await mkdir(join(process.cwd(), ".pi", "audit"), { recursive: true });
});

describe("auto-job child confirm gate", () => {
  it("manual gate → no-gate with zero updateMeta", async () => {
    const cfg = config("manual");
    const meta = autoMeta();
    const ctx = createMockCtx(meta);

    const result = await maybeHandleConfirmGate(cfg, ctx as never, meta, ui, {
      mode: "manual",
      isChild: true,
      sessionFile: "child.jsonl",
    });

    expect(result.result).toBe("no-gate");
    expect(ctx.metadataUpdates).toHaveLength(0);
  });

  it("smart+complex gate → no-gate as well (the owner decides every non-auto gate)", async () => {
    const cfg = config("smart");
    const meta = autoMeta();
    const ctx = createMockCtx(meta);

    const result = await maybeHandleConfirmGate(cfg, ctx as never, meta, ui, {
      mode: "smart",
      needConfirm: true,
      isChild: true,
      sessionFile: "child.jsonl",
    });

    expect(result.result).toBe("no-gate");
    expect(ctx.metadataUpdates).toHaveLength(0);
  });
});

describe("human-track child confirm gate (regression)", () => {
  it("still suppresses the gate by writing the deferral stamp + audit", async () => {
    const cfg = config("manual");
    const meta = makeTestMeta({
      currentStage: "plan",
      pipelineId: `pipe-227-human-child-gate-${Date.now()}-${++seq}`,
      requirementDoc: "docs/design/227_Bug.md",
    });
    await initAuditLog(cfg);
    const ctx = createMockCtx(meta);

    const result = await maybeHandleConfirmGate(cfg, ctx as never, meta, ui, {
      mode: "manual",
      isChild: true,
      sessionFile: "human-child.jsonl",
    });

    expect(result.result).toBe("handled");
    expect(ctx.metadataUpdates.length).toBeGreaterThan(0);
    expect(meta.confirmGateDeferredAt?.stage).toBe("plan");

    const audit = await readFile(auditLogFileFor(join(cfg.projectRoot, ".pi", "audit"), meta.pipelineId), "utf-8");
    expect(audit).toContain("confirm_gate_suppressed_child");
  });
});
