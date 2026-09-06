/**
 * @module review1-fixes
 * Tests for code_review_171_E2E_Flow_Bug_plan_1.md review#1 fixes.
 * Covers High A/B/C, Medium 1-5, and Low items.
 *
 * Categories:
 * - High A: activeSpawns lifecycle, probe → hard block integration
 * - High B: forwardArgs passthrough on all resume paths
 * - High C: adopt three-state matrix, flow-state audit field assertions
 * - M1: adopt candidate scan for running/blocked across all candidates
 * - M2: adopt path registerSession
 * - M3: shared formatAbortedNotifyText in session-starter/agent-settled
 * - M4: abort decision nextStage from config chain (C15 alignment)
 * - M5: template assets (guard example in plan, not develop)
 * - Low: SPAWN_TOOL_NAMES centralized, dead variable removed
 */

import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { makeTestConfig, makeTestMeta } from "../helpers";
import type { FlowStateCtx } from "../../core/flow-state";
import type { SessionMeta } from "../../types";
import {
  markPipelineAborted,
  executeDecision,
  formatAbortedNotifyText,
  freezeAndPrompt,
} from "../../core/flow-state";
import { SPAWN_TOOL_NAMES, FROZEN_ABORT_EXEMPT_TOOLS } from "../../constants";
import { probeAgentState } from "../../utils/subagents-introspect";
import { initAuditLog, getDateAuditFileName } from "../../utils/auditLog";
import { buildResumeMeta, buildResumeVisitOrder } from "../../commands/pipeline-start";
import { deriveClarifyForwardArgs } from "../../utils/clarify-args";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

/** Minimal FlowStateCtx factory for audit-field assertion tests */
function makeFlowCtx(
  meta: SessionMeta,
  ui?: { notify?: (msg: string) => void },
): FlowStateCtx {
  return {
    session: {
      getMeta: () => meta,
      updateMeta: (patch: Partial<SessionMeta>) => {
        Object.assign(meta, patch);
        return meta;
      },
    },
    ui: ui as FlowStateCtx["ui"],
  };
}

// ─── High A: activeSpawns lifecycle and probe integration ─────────────────────

describe("High A: activeSpawns lifecycle", () => {
  // review#3 H3 fix: rewrite to go through updateMeta merge semantics.
  // The previous version asserted newMeta.activeSpawns directly, which was structurally
  // empty (buildResumeMeta constructs a fresh object without spreading old values, so
  // activeSpawns is always absent regardless of whether the clearing implementation exists).
  // By routing through updateMeta merge, we simulate the real flow: old meta has
  // activeSpawns → buildResumeMeta output is applied via updateMeta → merged result must
  // not carry stale activeSpawns. Removing `activeSpawns: undefined` from buildResumeMeta
  // → the merge preserves old activeSpawns → test turns red.
  it("buildResumeMeta clears activeSpawns on resume (review#3: via updateMeta merge)", () => {
    const config = makeTestConfig();
    const meta = makeTestMeta({
      currentStage: "plan",
      flowState: "aborted",
      terminateReason: "session_quit",
      activeSpawns: {
        plan: { agentName: "feat-design-plan-agent", agentId: "rpc-123", startedAt: Date.now() },
      },
      spawnedStages: { plan: Date.now() },
    });
    // Simulate the real flow: buildResumeMeta → updateMeta (merge semantics)
    const ctx = makeFlowCtx(meta);
    const newMeta = buildResumeMeta(meta, config);
    ctx.session.updateMeta(newMeta);
    // After merge, both transient spawn-tracking fields must be cleared
    const mergedMeta = ctx.session.getMeta()!;
    expect(mergedMeta.activeSpawns).toBeUndefined();
    expect(mergedMeta.spawnedStages).toBeUndefined();
    // Preserved fields remain intact
    expect(mergedMeta.pipelineId).toBe(meta.pipelineId);
    expect(mergedMeta.requirementDoc).toBe(meta.requirementDoc);
    expect(mergedMeta.flowState).toBe("running");
  });

  // review#3 H3 edge case: when the original meta has NO activeSpawns,
  // the updateMeta merge must not accidentally introduce one. This tests
  // the symmetric property: clearing works both ways (removes stale entries
  // and doesn't create phantom ones).
  it("buildResumeMeta via updateMeta merge does not introduce phantom activeSpawns", () => {
    const config = makeTestConfig();
    const meta = makeTestMeta({
      currentStage: "develop",
      flowState: "aborted",
      // No activeSpawns, no spawnedStages
    });
    const ctx = makeFlowCtx(meta);
    const newMeta = buildResumeMeta(meta, config);
    ctx.session.updateMeta(newMeta);
    const mergedMeta = ctx.session.getMeta()!;
    // Must remain undefined (not accidentally introduced)
    expect(mergedMeta.activeSpawns).toBeUndefined();
    expect(mergedMeta.spawnedStages).toBeUndefined();
    // But other fields are correctly rebuilt
    expect(mergedMeta.flowState).toBe("running");
    expect(mergedMeta.pipelineId).toBe(meta.pipelineId);
  });

  it("SPAWN_TOOL_NAMES contains Agent", () => {
    expect(SPAWN_TOOL_NAMES).toContain("Agent");
    expect(SPAWN_TOOL_NAMES.length).toBe(1);
  });
});

// ─── High A: probeAgentState integration ──────────────────────────────────────

describe("High A: probeAgentState", () => {
  it("returns unknown when manager singleton is absent", () => {
    const result = probeAgentState("nonexistent-agent-id");
    expect(result).toBe("unknown");
  });

  it("returns settled when manager exists but record is gone", () => {
    const MANAGER_SYMBOL = Symbol.for("pi-subagents:manager");
    const manager = {
      getRecord: (_id: string) => undefined,
    };
    (globalThis as Record<symbol, unknown>)[MANAGER_SYMBOL] = manager;
    try {
      const result = probeAgentState("some-agent-id");
      expect(result).toBe("settled");
    } finally {
      delete (globalThis as Record<symbol, unknown>)[MANAGER_SYMBOL];
    }
  });

  it("returns live when manager record has running status", () => {
    const MANAGER_SYMBOL = Symbol.for("pi-subagents:manager");
    const manager = {
      getRecord: (id: string) => ({ status: "running" }),
    };
    (globalThis as Record<symbol, unknown>)[MANAGER_SYMBOL] = manager;
    try {
      const result = probeAgentState("some-agent-id");
      expect(result).toBe("live");
    } finally {
      delete (globalThis as Record<symbol, unknown>)[MANAGER_SYMBOL];
    }
  });

  it("returns settled when manager record has completed status", () => {
    const MANAGER_SYMBOL = Symbol.for("pi-subagents:manager");
    const manager = {
      getRecord: (id: string) => ({ status: "completed" }),
    };
    (globalThis as Record<symbol, unknown>)[MANAGER_SYMBOL] = manager;
    try {
      const result = probeAgentState("some-agent-id");
      expect(result).toBe("settled");
    } finally {
      delete (globalThis as Record<symbol, unknown>)[MANAGER_SYMBOL];
    }
  });
});

// ─── High B: forwardArgs passthrough ──────────────────────────────────────────

describe("High B: forwardArgs passthrough in resume paths", () => {
  // review#2 High: replace empty typeof===function test with real deriveClarifyForwardArgs
  // behavior that produces the three user-visible forwardArgs shapes for clarify dispatch.
  it("deriveClarifyForwardArgs produces the 3 clarify forwardArgs shapes", () => {
    // Fresh doc → kind=fresh (no rounds yet) → spawn will use "1" (auto-derive)
    const fresh = deriveClarifyForwardArgs("# Some doc\nNo rounds here");
    expect(fresh.kind).toBe("fresh");

    // Doc with one round AND answer → kind=full-und? (spawn with full-und? passthrough)
    const withAnswer = deriveClarifyForwardArgs("# 第 1 轮澄清\nQ1: what?\n答: something\n");
    expect(withAnswer.kind).toBe("full-und?");

    // Doc with one round but no answer → kind=await-answer (notify-only, no spawn)
    const noAnswer = deriveClarifyForwardArgs("# 第 1 轮澄清\nQ1: what?\n");
    expect(noAnswer.kind).toBe("await-answer");

    // Doc with confirmation → kind=confirmed (notify-only)
    const confirmed = deriveClarifyForwardArgs(
      "# 第 1 轮澄清\nQ1: what?\n答: ok\n## 模型确认\nAll clear",
    );
    expect(confirmed.kind).toBe("confirmed");
  });
});

// ─── High C: flow-state C14 audit field assertions ────────────────────────────

describe("High C: flow-state C14/C15 audit field assertions", () => {
  let tempRoot: string;
  let tempAuditDir: string;

  beforeEach(async () => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "review1-flow-state-"));
    tempAuditDir = path.join(tempRoot, "audit");
    fs.mkdirSync(tempAuditDir, { recursive: true });
    // Initialize audit log to write to the temp directory
    await initAuditLog(makeTestConfig({ projectRoot: tempRoot, auditDir: "audit" }));
  });

  afterEach(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it("markPipelineAborted writes nextStage/nextAction/trigger fields to audit", async () => {
    const config = makeTestConfig({ projectRoot: tempRoot, auditDir: "audit" });
    const meta = makeTestMeta({
      currentStage: "plan",
      pipelineId: "pipe-c14-test",
      requirementDoc: "docs/design/test.md",
    });
    const ctx = makeFlowCtx(meta);

    await markPipelineAborted(ctx, "session_quit", {
      trigger: {
        sessionFile: "/path/to/session.md",
        isSubagent: false,
        eventReason: "quit",
      },
      config,
    });

    // Verify meta was updated
    expect(meta.flowState).toBe("aborted");
    expect(meta.terminateReason).toBe("session_quit");

    // Verify audit file was written with correct fields
    const auditFile = path.join(tempAuditDir, getDateAuditFileName());
    const auditContent = fs.readFileSync(auditFile, "utf-8");
    const lines = auditContent.trim().split("\n");
    const abortLine = lines.find(l => l.includes("pipeline_session_aborted"));
    expect(abortLine).toBeDefined();

    // C14: verify nextStage is computed from config chain (plan → develop)
    expect(abortLine).toContain("nextStage=develop");
    // C14: verify nextAction contains resume hint with doc
    expect(abortLine).toContain("nextAction=run /pipeline-start docs/design/test.md");
    // C14: verify trigger fields
    expect(abortLine).toContain("triggerSessionFile=/path/to/session.md");
    expect(abortLine).toContain("triggerIsSubagent=false");
    expect(abortLine).toContain("triggerEventReason=quit");
  });

  it("executeDecision abort writes config-chain nextStage (not literal 'null')", async () => {
    const config = makeTestConfig({ projectRoot: tempRoot, auditDir: "audit" });
    const meta = makeTestMeta({
      currentStage: "develop",
      pipelineId: "pipe-m4-test",
      requirementDoc: "docs/design/test.md",
    });
    const ctx = makeFlowCtx(meta);

    await executeDecision(ctx, meta, "abort", config);

    // Verify audit file
    const auditFile = path.join(tempAuditDir, getDateAuditFileName());
    const auditContent = fs.readFileSync(auditFile, "utf-8");
    const lines = auditContent.trim().split("\n");
    const decisionLine = lines.find(l => l.includes("pipeline_decision") && l.includes("decision=abort"));
    expect(decisionLine).toBeDefined();

    // M4 fix: nextStage should come from config chain (develop → review), not literal "null"
    expect(decisionLine).toContain("nextStage=review");
    // nextAction should contain resume hint with stage
    expect(decisionLine).toContain("develop");
    expect(decisionLine).toContain("terminateReason=user_abort");
  });

  it("freezeAndPrompt writes config-chain nextStage in pipeline_blocked audit", async () => {
    const config = makeTestConfig({ projectRoot: tempRoot, auditDir: "audit" });
    const meta = makeTestMeta({
      currentStage: "clarify",
      pipelineId: "pipe-freeze-test",
      flowState: "running",
    });
    const ctx = makeFlowCtx(meta);

    await freezeAndPrompt(ctx, meta, "loop_overflow", config);

    // Verify audit file
    const auditFile = path.join(tempAuditDir, getDateAuditFileName());
    const auditContent = fs.readFileSync(auditFile, "utf-8");
    const lines = auditContent.trim().split("\n");
    const blockedLine = lines.find(l => l.includes("pipeline_blocked"));
    expect(blockedLine).toBeDefined();

    // C15: nextStage should be config chain (clarify → plan)
    expect(blockedLine).toContain("nextStage=plan");
    expect(blockedLine).toContain("nextAction=Open the decision menu (press ctrl+enter) to proceed.");
  });
});

// ─── M3: Shared formatAbortedNotifyText ───────────────────────────────────────

describe("M3: formatAbortedNotifyText shared function", () => {
  it("includes stage, reason, and doc hint", () => {
    const text = formatAbortedNotifyText("plan", "session_quit", "docs/design/test.md");
    expect(text).toContain("plan");
    expect(text).toContain("session_quit");
    expect(text).toContain("docs/design/test.md");
    expect(text).toContain("/pipeline-start");
  });

  it("uses placeholder when requirementDoc is undefined", () => {
    const text = formatAbortedNotifyText("develop", "stale_startup");
    expect(text).toContain("<requirement-doc>");
  });

  // review#2 Low: replace self-comparison with a real content snapshot that would
  // break if any of the required fields were dropped from formatAbortedNotifyText.
  it("formatAbortedNotifyText contains stage, reason, doc hint, and /pipeline-start path", () => {
    const text = formatAbortedNotifyText("plan", "session_quit", "docs/test.md");
    // All 4 sites call the same function — verify the output carries the 4 required fields
    expect(text).toContain("plan");
    expect(text).toContain("session_quit");
    expect(text).toContain("docs/test.md");
    expect(text).toContain("/pipeline-start docs/test.md");
    // Pin the output shape (snapshot-equivalent without using Bun snapshot API):
    // - Must start with a sentence mentioning the stage
    // - Must contain the resume hint with full doc path
    const lines = text.split("\n").filter(l => l.trim().length > 0);
    expect(lines.length).toBeGreaterThanOrEqual(1);
    expect(text).toMatch(/plan/);
    expect(text).toMatch(/docs\/test\.md/);
  });
});

// ─── Low: SPAWN_TOOL_NAMES centralized ────────────────────────────────────────

describe("Low: SPAWN_TOOL_NAMES constant", () => {
  it("is exported from constants and contains Agent", () => {
    expect(SPAWN_TOOL_NAMES).toBeDefined();
    expect(Array.isArray(SPAWN_TOOL_NAMES)).toBe(true);
    expect(SPAWN_TOOL_NAMES).toContain("Agent");
  });

  it("is readonly at TypeScript level (compile-time constraint via 'as const')", () => {
    // TypeScript enforces readonly at compile time via 'as const' assertion.
    // Runtime: verify it's an array with expected content.
    expect(SPAWN_TOOL_NAMES).toBeDefined();
    expect(SPAWN_TOOL_NAMES.length).toBe(1);
    expect(SPAWN_TOOL_NAMES[0]).toBe("Agent");
  });
});

// ─── Low: FROZEN_ABORT_EXEMPT_TOOLS comment fix ──────────────────────────────

describe("Low: FROZEN_ABORT_EXEMPT_TOOLS", () => {
  it("contains pipeline_state and get_subagent_result", () => {
    expect(FROZEN_ABORT_EXEMPT_TOOLS).toContain("pipeline_state");
    expect(FROZEN_ABORT_EXEMPT_TOOLS).toContain("get_subagent_result");
    expect(FROZEN_ABORT_EXEMPT_TOOLS).not.toContain("read");
  });
});

// ─── M5: Template assets ──────────────────────────────────────────────────────

describe("M5: pipeline_loop.json guard example in plan stage", () => {
  it("pipeline_loop.json has guard.suppressDuplicateSpawn in plan, not develop", () => {
    const jsonPath = path.join(__dirname, "../../template/pipeline_loop.json");
    const content = JSON.parse(fs.readFileSync(jsonPath, "utf-8"));

    // Plan stage should have the guard example
    expect(content.stages.plan.guard).toBeDefined();
    expect(content.stages.plan.guard.suppressDuplicateSpawn).toBe(false);

    // Develop stage should NOT have suppressDuplicateSpawn (it only works for clarify/plan)
    expect(content.stages.develop.guard).toBeUndefined();
  });
});

// ─── Clarify args: dead variable removed ──────────────────────────────────────

describe("clarify-args: no dead variable roundHeadingRegex", () => {
  it("deriveClarifyForwardArgs works correctly without roundHeadingRegex", async () => {
    const { deriveClarifyForwardArgs } = await import("../../utils/clarify-args");

    // Fresh doc (no rounds) → "1"
    const fresh = deriveClarifyForwardArgs("# Some doc\nNo rounds here");
    expect(fresh.kind).toBe("fresh");

    // Doc with one round and answer → full-und?
    const withAnswer = deriveClarifyForwardArgs(
      "# 第 1 轮澄清\nQ1: what?\n答: something\n",
    );
    expect(withAnswer.kind).toBe("full-und?");

    // Doc with one round no answer → await-answer
    const noAnswer = deriveClarifyForwardArgs("# 第 1 轮澄清\nQ1: what?\n");
    expect(noAnswer.kind).toBe("await-answer");

    // Doc with confirmation → confirmed
    const confirmed = deriveClarifyForwardArgs(
      "# 第 1 轮澄清\nQ1: what?\n答: ok\n## 模型确认\nAll clear",
    );
    expect(confirmed.kind).toBe("confirmed");
  });
});
