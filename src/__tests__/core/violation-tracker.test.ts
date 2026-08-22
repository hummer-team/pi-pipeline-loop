import { describe, it, expect, beforeAll, beforeEach, afterEach } from "bun:test";
import { recordViolation, checkViolationBreaker } from "../../core/violation-tracker";
import { makeTestConfig, makeTestMeta } from "../helpers";
import { mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initAuditLog, getDateAuditFileName, __resetAuditDirPath } from "../../utils/auditLog";
import type { SessionMeta, ViolationItem } from "../../types";

const TMP = join(tmpdir(), "pi-violation-tracker-test-" + Date.now());

function createCtx(meta: SessionMeta) {
  const updates: SessionMeta[] = [];
  return {
    session: {
      getMeta: () => meta,
      updateMeta: (patch: Partial<SessionMeta>) => {
        const merged = { ...meta, ...patch };
        updates.push(merged);
        Object.assign(meta, merged);
        return merged;
      },
    },
    ui: {
      notify: (_msg: string) => {},
      select: async (_msg: string, _opts: string[]) => undefined,
    },
    updates,
  };
}

function makeViolation(type: ViolationItem["type"] = "tool_not_allowed"): Omit<ViolationItem, "timestamp"> {
  return { type, tool: "write", detail: `Test ${type} violation detail.` };
}

beforeAll(async () => {
  await mkdir(TMP, { recursive: true });
  await initAuditLog(makeTestConfig({ projectRoot: TMP }));
});

afterEach(() => {
  __resetAuditDirPath();
});

describe("recordViolation", () => {
  it("appends violation item to meta.violations", async () => {
    const config = makeTestConfig();
    const meta = makeTestMeta();
    const ctx = createCtx(meta);

    const item: ViolationItem = { ...makeViolation("tool_not_allowed"), timestamp: Date.now() };
    await recordViolation(ctx as any, meta, item);

    expect(meta.violations).toBeDefined();
    expect(meta.violations!.length).toBe(1);
    expect(meta.violations![0].type).toBe("tool_not_allowed");
    expect(meta.violations![0].tool).toBe("write");
  });

  it("appends multiple violations cumulatively", async () => {
    const config = makeTestConfig();
    const meta = makeTestMeta();
    const ctx = createCtx(meta);

    await recordViolation(ctx as any, meta, { ...makeViolation("tool_not_allowed"), timestamp: Date.now() });
    await recordViolation(ctx as any, meta, { ...makeViolation("bash_prefix"), timestamp: Date.now() });
    await recordViolation(ctx as any, meta, { ...makeViolation("write_protected"), timestamp: Date.now() });

    expect(meta.violations!.length).toBe(3);
    expect(meta.violations!.map(v => v.type)).toEqual(["tool_not_allowed", "bash_prefix", "write_protected"]);
  });

  it("handles undefined initial violations array", async () => {
    const config = makeTestConfig();
    const meta = makeTestMeta({ violations: undefined });
    const ctx = createCtx(meta);

    await recordViolation(ctx as any, meta, { ...makeViolation(), timestamp: Date.now() });

    expect(meta.violations!.length).toBe(1);
  });

  it("writes pipeline_violation audit entry with correct fields", async () => {
    const config = makeTestConfig({ projectRoot: TMP });
    const meta = makeTestMeta();
    const ctx = createCtx(meta);

    // Re-init audit log for this specific projectRoot
    await initAuditLog(config);

    const item: ViolationItem = {
      type: "bash_prefix",
      tool: "bash",
      detail: "Bash command not allowed.",
      timestamp: Date.now(),
    };
    await recordViolation(ctx as any, meta, item);

    const logPath = join(TMP, ".pi", "audit", getDateAuditFileName());
    const logContent = await readFile(logPath, "utf-8");
    expect(logContent).toContain("pipeline_violation");
    expect(logContent).toContain("bash_prefix");
    expect(logContent).toContain("Bash command not allowed.");
    expect(logContent).toContain("count=1");
  });
});

describe("checkViolationBreaker", () => {
  it("does NOT freeze when violations count < DEFAULT_MAX_VIOLATIONS", async () => {
    const config = makeTestConfig();
    const meta = makeTestMeta({ violations: [
      { type: "tool_not_allowed", tool: "write", detail: "d1", timestamp: Date.now() },
      { type: "bash_prefix", tool: "bash", detail: "d2", timestamp: Date.now() },
    ]});
    const ctx = createCtx(meta);

    await checkViolationBreaker(ctx as any, meta, config);

    // Should not freeze (only 2 violations, threshold is 3)
    expect(meta.flowState).not.toBe("blocked");
    expect(meta.blockedReason).not.toBe("violation_overflow");
  });

  it("freezes with violation_overflow when violations count >= DEFAULT_MAX_VIOLATIONS", async () => {
    const config = makeTestConfig();
    const meta = makeTestMeta({
      violations: [
        { type: "tool_not_allowed", tool: "write", detail: "d1", timestamp: Date.now() },
        { type: "bash_prefix", tool: "bash", detail: "d2", timestamp: Date.now() },
        { type: "write_protected", tool: "edit", detail: "d3", timestamp: Date.now() },
      ],
    });
    const ctx = createCtx(meta);

    await checkViolationBreaker(ctx as any, meta, config);

    expect(meta.flowState).toBe("blocked");
    expect(meta.blockedReason).toBe("violation_overflow");
  });

  it("is idempotent — second call does not re-freeze or re-audit", async () => {
    const config = makeTestConfig();
    const meta = makeTestMeta({
      violations: [
        { type: "tool_not_allowed", tool: "write", detail: "d1", timestamp: Date.now() },
        { type: "bash_prefix", tool: "bash", detail: "d2", timestamp: Date.now() },
        { type: "write_protected", tool: "edit", detail: "d3", timestamp: Date.now() },
      ],
    });
    const ctx = createCtx(meta);

    await checkViolationBreaker(ctx as any, meta, config);
    const updatesAfterFirst = ctx.updates.length;

    await checkViolationBreaker(ctx as any, meta, config);
    // freezeAndPrompt is idempotent: no additional state transitions
    expect(ctx.updates.length).toBe(updatesAfterFirst);
    expect(meta.flowState).toBe("blocked");
  });

  it("does NOT freeze when violations is undefined (no violations yet)", async () => {
    const config = makeTestConfig();
    const meta = makeTestMeta({ violations: undefined });
    const ctx = createCtx(meta);

    await checkViolationBreaker(ctx as any, meta, config);

    expect(meta.flowState).not.toBe("blocked");
  });
});

describe("violations lifecycle — cleared on transition", () => {
  it("resume clears violations (flow-state executeDecision)", async () => {
    const { executeDecision } = await import("../../core/flow-state");
    const config = makeTestConfig();
    const meta = makeTestMeta({
      flowState: "blocked",
      blockedReason: "violation_overflow",
      violations: [
        { type: "tool_not_allowed", tool: "write", detail: "d1", timestamp: Date.now() },
        { type: "bash_prefix", tool: "bash", detail: "d2", timestamp: Date.now() },
        { type: "write_protected", tool: "edit", detail: "d3", timestamp: Date.now() },
      ],
    });
    const ctx = createCtx(meta);

    await initAuditLog(config);
    await executeDecision(ctx as any, meta, "resume", config);

    expect(meta.flowState).toBe("running");
    expect(meta.violations).toEqual([]);
  });

  it("skip clears violations (flow-state executeDecision)", async () => {
    const { executeDecision } = await import("../../core/flow-state");
    const config = makeTestConfig();
    const meta = makeTestMeta({
      currentStage: "clarify",
      flowState: "blocked",
      blockedReason: "violation_overflow",
      violations: [
        { type: "tool_not_allowed", tool: "write", detail: "d1", timestamp: Date.now() },
        { type: "bash_prefix", tool: "bash", detail: "d2", timestamp: Date.now() },
        { type: "write_protected", tool: "edit", detail: "d3", timestamp: Date.now() },
      ],
    });
    const ctx = createCtx(meta);

    await initAuditLog(config);
    await executeDecision(ctx as any, meta, "skip", config);

    expect(meta.flowState).toBe("running");
    expect(meta.violations).toEqual([]);
    expect(meta.currentStage).toBe("plan"); // skipped clarify → plan
  });

  it("rollback clears violations (flow-state executeDecision)", async () => {
    const { executeDecision } = await import("../../core/flow-state");
    const config = makeTestConfig();
    const meta = makeTestMeta({
      currentStage: "develop",
      previousStage: "plan",
      flowState: "blocked",
      blockedReason: "violation_overflow",
      violations: [
        { type: "tool_not_allowed", tool: "write", detail: "d1", timestamp: Date.now() },
        { type: "bash_prefix", tool: "bash", detail: "d2", timestamp: Date.now() },
        { type: "write_protected", tool: "edit", detail: "d3", timestamp: Date.now() },
      ],
    });
    const ctx = createCtx(meta);

    await initAuditLog(config);
    await executeDecision(ctx as any, meta, "rollback", config);

    expect(meta.flowState).toBe("running");
    expect(meta.violations).toEqual([]);
    expect(meta.currentStage).toBe("plan"); // rolled back to plan
  });

  it("restart clears violations (flow-state executeDecision)", async () => {
    const { executeDecision } = await import("../../core/flow-state");
    const config = makeTestConfig();
    const meta = makeTestMeta({
      flowState: "blocked",
      blockedReason: "violation_overflow",
      violations: [
        { type: "tool_not_allowed", tool: "write", detail: "d1", timestamp: Date.now() },
        { type: "bash_prefix", tool: "bash", detail: "d2", timestamp: Date.now() },
        { type: "write_protected", tool: "edit", detail: "d3", timestamp: Date.now() },
      ],
    });
    const ctx = createCtx(meta);

    await initAuditLog(config);
    await executeDecision(ctx as any, meta, "restart", config);

    expect(meta.flowState).toBe("running");
    expect(meta.currentStage).toBe("clarify");
    expect(meta.violations).toEqual([]);
  });

  it("stage_advance clears violations (stage-advancer updateMeta)", async () => {
    const { applyVerifyPass } = await import("../../core/verify-advance");
    const config = makeTestConfig();
    const meta = makeTestMeta({
      currentStage: "clarify",
      violations: [
        { type: "tool_not_allowed", tool: "write", detail: "d1", timestamp: Date.now() },
      ],
    });
    const ctx = createCtx(meta);
    const pipelineUI = { notify: () => {}, setStatus: () => {}, transition: () => {}, clearStage: () => {} };

    await applyVerifyPass(
      ctx as any,
      meta,
      "clarify",
      "plan",
      { ruleMissing: [], verifyResult: { structured: { passed: true }, overallPassed: true } },
      { method: "rule", handleTerminal: false, returnResult: false, ui: pipelineUI as any },
    );

    expect(meta.violations).toEqual([]);
    expect(meta.currentStage).toBe("plan");
  });
});
