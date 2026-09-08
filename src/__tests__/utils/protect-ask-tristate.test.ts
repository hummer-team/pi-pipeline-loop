/**
 * @module protect-ask-tristate.test
 * Phase 4 (173) C11 — Tri-state protect-ask outcomes with dismiss counting and overflow guardrail.
 *
 * Test plan (per docs/design/173_E2E_Bug_plan.md §Phase 4):
 *   - Three states: dismissed (fast < 1500ms), canceled (slow ≥ 1500ms), denied (follow_default)
 *   - dismissed: block but NO violation, increment dismissCount
 *   - canceled: block + violation (genuine user Esc)
 *   - denied: block + violation (explicit follow_default)
 *   - dismissCount ≥ 5 → freezeAndPrompt("dismiss_overflow")
 *   - allow_once / allow_session paths unchanged
 *   - Audit fields: elapsedMs included
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { askProtectDecision, askCommandDecision } from "../../utils/protect-ask";
import { freezeAndPrompt, clearAllDecisionTimers } from "../../core/flow-state";
import type { SessionMeta, PipelineConfig } from "../../types";
import { makeTestConfig, makeTestMeta, createMockCtx } from "../helpers";
import { initAuditLog, getDateAuditFileName } from "../../utils/auditLog";
import { DEFAULT_MAX_DISMISS_COUNT, PROTECT_ASK_DISMISS_MS } from "../../constants";
import { readFile, rm, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

let TMP: string;
let config: PipelineConfig;

async function setupTmp(label: string): Promise<void> {
  TMP = join(tmpdir(), `pi-ask-tristate-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await mkdir(TMP, { recursive: true });
  config = makeTestConfig({ projectRoot: TMP });
  await initAuditLog(config);
}

afterEach(async () => {
  clearAllDecisionTimers();
  if (TMP) {
    await rm(TMP, { recursive: true, force: true }).catch(() => {});
  }
});

// ─── Constants ────────────────────────────────────────────────────────────────

describe("Phase 4 (173) C11: constants", () => {
  it("PROTECT_ASK_DISMISS_MS = 1500", () => {
    expect(PROTECT_ASK_DISMISS_MS).toBe(1500);
  });

  it("DEFAULT_MAX_DISMISS_COUNT = 5", () => {
    expect(DEFAULT_MAX_DISMISS_COUNT).toBe(5);
  });
});

// ─── Three-state classification ──────────────────────────────────────────────

describe("Phase 4 (173) C11: tri-state classification", () => {
  it("fast undefined (< 1500ms) → dismissed (block, no violation)", async () => {
    await setupTmp("dismissed");
    const meta = makeTestMeta();
    const ctx = createMockCtx(meta);
    // Mock select that returns immediately (fast dismiss)
    ctx.ui.select = async () => {
      return undefined;
    };

    const outcome = await askProtectDecision(ctx, meta, "test/file.md", config);

    expect(outcome.decision).toBe("block");
    expect(outcome.action).toBe("dismissed");
    // dismissCount should be incremented
    expect(meta.dismissCount).toBe(1);
  });

  it("slow undefined (≥ 1500ms) → canceled (block, violation)", async () => {
    await setupTmp("canceled");
    const meta = makeTestMeta();
    const ctx = createMockCtx(meta);
    // Mock select that delays >= 1500ms (genuine user Esc)
    ctx.ui.select = async () => {
      await new Promise((r) => setTimeout(r, 1600));
      return undefined;
    };

    const outcome = await askProtectDecision(ctx, meta, "test/file.md", config);

    expect(outcome.decision).toBe("block");
    expect(outcome.action).toBe("canceled");
    // dismissCount should NOT be incremented
    expect(meta.dismissCount).toBeUndefined();
  });

  it("follow_default selection → denied (block, violation)", async () => {
    await setupTmp("denied");
    const meta = makeTestMeta();
    const ctx = createMockCtx(meta);
    ctx.ui.select = async () => "Follow plugin default rules (default)";

    const outcome = await askProtectDecision(ctx, meta, "test/file.md", config);

    expect(outcome.decision).toBe("block");
    expect(outcome.action).toBe("denied");
    // dismissCount should NOT be incremented
    expect(meta.dismissCount).toBeUndefined();
  });

  it("allow_once selection → allow (no dismissCount change)", async () => {
    await setupTmp("allow-once");
    const meta = makeTestMeta();
    const ctx = createMockCtx(meta);
    ctx.ui.select = async () => "Allow this edit only";

    const outcome = await askProtectDecision(ctx, meta, "test/file.md", config);

    expect(outcome.decision).toBe("allow");
    expect(outcome.action).toBe("allow_once");
  });

  it("allow_session selection → allow + adds to sessionAllowedWritePaths", async () => {
    await setupTmp("allow-session");
    const meta = makeTestMeta();
    const ctx = createMockCtx(meta);
    ctx.ui.select = async () => "Allow edits for this session";

    const outcome = await askProtectDecision(ctx, meta, "test/file.md", config);

    expect(outcome.decision).toBe("allow");
    expect(outcome.action).toBe("allow_session");
    expect(meta.sessionAllowedWritePaths).toContain("test/file.md");
  });
});

// ─── dismissCount overflow guardrail ─────────────────────────────────────────

describe("Phase 4 (173) C11: dismissCount overflow guardrail", () => {
  it("dismissCount accumulates on each dismissed action", async () => {
    await setupTmp("accumulate");
    const meta = makeTestMeta({ dismissCount: 0 });
    const ctx = createMockCtx(meta);
    ctx.ui.select = async () => undefined; // fast dismiss

    // First dismiss
    await askProtectDecision(ctx, meta, "file1.md", config);
    expect(meta.dismissCount).toBe(1);

    // Second dismiss
    await askProtectDecision(ctx, meta, "file2.md", config);
    expect(meta.dismissCount).toBe(2);

    // Third dismiss
    await askProtectDecision(ctx, meta, "file3.md", config);
    expect(meta.dismissCount).toBe(3);
  });

  it("dismissCount ≥ 5 triggers freezeAndPrompt('dismiss_overflow')", async () => {
    await setupTmp("overflow");
    // Start at 4, one more dismiss should trigger overflow
    const meta = makeTestMeta({ dismissCount: 4 });
    const ctx = createMockCtx(meta);
    ctx.ui.select = async () => undefined; // fast dismiss

    const outcome = await askProtectDecision(ctx, meta, "file.md", config);

    expect(outcome.decision).toBe("block");
    expect(outcome.action).toBe("dismissed");
    // dismissCount should be 5 now
    expect(meta.dismissCount).toBe(5);
    // Pipeline should be frozen with dismiss_overflow reason
    expect(meta.flowState).toBe("blocked");
    expect(meta.blockedReason).toBe("dismiss_overflow");
  });

  it("dismissCount = 4 does NOT trigger freeze (boundary test)", async () => {
    await setupTmp("boundary");
    const meta = makeTestMeta({ dismissCount: 3 });
    const ctx = createMockCtx(meta);
    ctx.ui.select = async () => undefined; // fast dismiss

    const outcome = await askProtectDecision(ctx, meta, "file.md", config);

    expect(outcome.decision).toBe("block");
    expect(outcome.action).toBe("dismissed");
    expect(meta.dismissCount).toBe(4);
    // Pipeline should NOT be frozen
    expect(meta.flowState).not.toBe("blocked");
  });

  it("6th dismiss does NOT trigger freeze again (idempotent via freezeAndPrompt guard)", async () => {
    await setupTmp("idempotent");
    const meta = makeTestMeta({ dismissCount: 5, flowState: "blocked", blockedReason: "dismiss_overflow" });
    const ctx = createMockCtx(meta);
    ctx.ui.select = async () => undefined; // fast dismiss

    const outcome = await askProtectDecision(ctx, meta, "file.md", config);

    expect(outcome.action).toBe("dismissed");
    expect(meta.dismissCount).toBe(6);
    // freezeAndPrompt is idempotent — already blocked, no re-freeze
    expect(meta.flowState).toBe("blocked");
    expect(meta.blockedReason).toBe("dismiss_overflow");
  });
});

// ─── askCommandDecision tri-state ────────────────────────────────────────────

describe("Phase 4 (173) C11: askCommandDecision tri-state", () => {
  it("fast undefined → dismissed", async () => {
    await setupTmp("cmd-dismissed");
    const meta = makeTestMeta();
    const ctx = createMockCtx(meta);
    ctx.ui.select = async () => undefined;

    const outcome = await askCommandDecision(ctx, meta, "rm -rf /", config);

    expect(outcome.decision).toBe("block");
    expect(outcome.action).toBe("dismissed");
    expect(meta.dismissCount).toBe(1);
  });

  it("allow_session adds to sessionAllowedCommands", async () => {
    await setupTmp("cmd-allow-session");
    const meta = makeTestMeta();
    const ctx = createMockCtx(meta);
    ctx.ui.select = async () => "Allow this command for session";

    const outcome = await askCommandDecision(ctx, meta, "rm -rf /tmp/test", config);

    expect(outcome.decision).toBe("allow");
    expect(outcome.action).toBe("allow_session");
    expect(meta.sessionAllowedCommands).toContain("rm -rf /tmp/test");
  });
});

// ─── Audit enrichment ────────────────────────────────────────────────────────

describe("Phase 4 (173) C11: audit enrichment", () => {
  it("pipeline_protect_ask includes elapsedMs field", async () => {
    await setupTmp("audit-elapsed");
    const meta = makeTestMeta();
    const ctx = createMockCtx(meta);
    ctx.ui.select = async () => undefined;

    await askProtectDecision(ctx, meta, "test/file.md", config);

    const logPath = join(TMP, ".pi", "audit", getDateAuditFileName());
    const logContent = await readFile(logPath, "utf-8");
    expect(logContent).toContain("pipeline_protect_ask");
    expect(logContent).toContain("elapsedMs=");
    expect(logContent).toContain("action=dismissed");
  });

  it("pipeline_command_ask includes elapsedMs field", async () => {
    await setupTmp("cmd-audit-elapsed");
    const meta = makeTestMeta();
    const ctx = createMockCtx(meta);
    ctx.ui.select = async () => undefined;

    await askCommandDecision(ctx, meta, "rm -rf /", config);

    const logPath = join(TMP, ".pi", "audit", getDateAuditFileName());
    const logContent = await readFile(logPath, "utf-8");
    expect(logContent).toContain("pipeline_command_ask");
    expect(logContent).toContain("elapsedMs=");
  });
});
