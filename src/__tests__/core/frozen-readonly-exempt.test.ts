/**
 * @module frozen-readonly-exempt
 * 218 Phase 3 (T3.4, Q20-A / R7): read-only probes stay available while the
 * pipeline is `blocked` (the process is alive and the executor should be able
 * to self-diagnose the freeze), and ONLY in that state.
 *
 * Plan case table coverage:
 *  1. blocked → read/grep/glob/list pass + `frozen_read_allowed` (throttled:
 *     one audit per tool per window, the pass-through itself is NOT throttled);
 *  2. aborted → the exemption never applies (no `frozen_read_allowed`). NOTE:
 *     since 173 C3 an aborted pipeline is DORMANT and tool-guard is silent for
 *     it (precedent: tool-guard-frozen-git.test.ts "aborted frozen rejection is
 *     now dormant pass-through") — what T3.4 pins here is that the blocked-only
 *     read exemption does not leak into the aborted state;
 *  3. bash in blocked → still `tool_rejected_frozen` (write-capable tool, not
 *     on the read-only list);
 *  4. awaiting_human → unchanged (no blocked-flowState producer: the legacy
 *     freeze point keeps rejecting every tool as before);
 *  5. the pre-existing FROZEN_ABORT_EXEMPT_TOOLS probe channel
 *     (`tool_allowed_frozen_probe`) is unchanged while blocked.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createToolGuard } from "../../core/tool-guard";
import { __setSafeWriteAuditLogOverride, initAuditLog } from "../../utils/auditLog";
import { __resetMemoryThrottle } from "../../utils/audit-throttle";
import { makeTestConfig, makeTestMeta, createMockCtx } from "../helpers";
import type { SessionMeta } from "../../types";

type AuditRow = { event: string; message: Record<string, unknown> };

let audits: AuditRow[];
const tmpDirs: string[] = [];

async function makeTmpRoot(prefix: string): Promise<string> {
  const TMP = join(tmpdir(), prefix + Date.now());
  await mkdir(TMP, { recursive: true });
  tmpDirs.push(TMP);
  await initAuditLog(makeTestConfig({ projectRoot: TMP }));
  return TMP;
}

beforeEach(() => {
  audits = [];
  __setSafeWriteAuditLogOverride(async (event, message) => {
    audits.push({ event, message: (message ?? {}) as Record<string, unknown> });
  });
  __resetMemoryThrottle();
});

afterEach(async () => {
  __setSafeWriteAuditLogOverride(null);
  __resetMemoryThrottle();
  while (tmpDirs.length > 0) {
    const dir = tmpDirs.pop()!;
    await rm(dir, { recursive: true, force: true });
  }
});

/** Run one tool call through the guard with the given meta. */
async function runTool(
  TMP: string,
  meta: SessionMeta,
  toolName: string,
  args: Record<string, unknown>,
): Promise<{ block?: boolean; reason?: string } | undefined> {
  const config = makeTestConfig({ projectRoot: TMP });
  const ctx = createMockCtx(meta);
  ctx.toolCall = { name: toolName, arguments: args };
  const hook = createToolGuard(config);
  return (await hook.handler(ctx as never)) as
    | { block?: boolean; reason?: string }
    | undefined;
}

describe("218 T3.4: blocked keeps read-only probes alive", () => {
  // ── Case 1: every listed probe passes, throttled audit ───────────────────
  it("blocked → read/grep/glob/list all pass with a frozen_read_allowed audit", async () => {
    const TMP = await makeTmpRoot("pi-t34-blocked-");
    for (const toolName of ["read", "grep", "glob", "list"] as const) {
      const meta = makeTestMeta({
        pipelineId: `pipe-218-t34-${toolName}`,
        currentStage: "develop",
        flowState: "blocked",
        blockedReason: "loop_overflow",
      });
      const result = await runTool(TMP, meta, toolName, { path: "docs/req.md" });
      expect(result).toBeUndefined(); // pass-through
      const allowed = audits.filter(
        (a) => a.event === "frozen_read_allowed" && a.message.pipelineId === meta.pipelineId,
      );
      expect(allowed).toHaveLength(1);
      expect(allowed[0]?.message.tool).toBe(toolName);
      expect(allowed[0]?.message.flowState).toBe("blocked");
      expect(audits.some((a) => a.event === "tool_rejected_frozen")).toBe(false);
    }
  });

  it("repeat call within the window: still passes, but only ONE audit (throttle)", async () => {
    const TMP = await makeTmpRoot("pi-t34-throttle-");
    const meta = makeTestMeta({
      pipelineId: "pipe-218-t34-thr",
      currentStage: "develop",
      flowState: "blocked",
      blockedReason: "loop_overflow",
    });
    expect(await runTool(TMP, meta, "read", { path: "a.md" })).toBeUndefined();
    expect(await runTool(TMP, meta, "read", { path: "b.md" })).toBeUndefined();
    expect(audits.filter((a) => a.event === "frozen_read_allowed")).toHaveLength(1);
  });

  it("different tool names use different throttle keys (read then grep → two audits)", async () => {
    const TMP = await makeTmpRoot("pi-t34-keys-");
    const meta = makeTestMeta({
      pipelineId: "pipe-218-t34-keys",
      currentStage: "develop",
      flowState: "blocked",
      blockedReason: "loop_overflow",
    });
    expect(await runTool(TMP, meta, "read", { path: "a.md" })).toBeUndefined();
    expect(await runTool(TMP, meta, "grep", { pattern: "x" })).toBeUndefined();
    expect(audits.filter((a) => a.event === "frozen_read_allowed")).toHaveLength(2);
  });

  // ── Case 2: aborted never uses the exemption ─────────────────────────────
  it("aborted → no frozen_read_allowed (the blocked-only exemption does not leak)", async () => {
    const TMP = await makeTmpRoot("pi-t34-aborted-");
    const meta = makeTestMeta({
      pipelineId: "pipe-218-t34-ab",
      currentStage: "develop",
      flowState: "aborted",
      terminateReason: "user_abort",
    });
    await runTool(TMP, meta, "read", { path: "a.md" });
    expect(audits.some((a) => a.event === "frozen_read_allowed")).toBe(false);
  });

  // ── Case 3: bash stays blocked ────────────────────────────────────────────
  it("bash in blocked → still tool_rejected_frozen (not a read-only probe)", async () => {
    const TMP = await makeTmpRoot("pi-t34-bash-");
    const meta = makeTestMeta({
      pipelineId: "pipe-218-t34-bash",
      currentStage: "develop",
      flowState: "blocked",
      blockedReason: "loop_overflow",
    });
    const result = await runTool(TMP, meta, "bash", { command: "echo hi" });
    expect(result?.block).toBe(true);
    expect(result?.reason).toContain("Pipeline frozen");
    expect(audits.some((a) => a.event === "tool_rejected_frozen")).toBe(true);
    expect(audits.some((a) => a.event === "frozen_read_allowed")).toBe(false);
  });

  // ── Case 4: awaiting_human behavior unchanged ────────────────────────────
  it("awaiting_human (no blocked-flowState producer) → read still rejected as before", async () => {
    const TMP = await makeTmpRoot("pi-t34-ah-");
    const meta = makeTestMeta({
      pipelineId: "pipe-218-t34-ah",
      currentStage: "awaiting_human",
    });
    const result = await runTool(TMP, meta, "read", { path: "a.md" });
    expect(result?.block).toBe(true);
    expect(result?.reason).toContain("Contact the user");
    expect(audits.some((a) => a.event === "frozen_read_allowed")).toBe(false);
  });

  // ── Case 5: the pre-existing probe exemption channel is untouched ────────
  it("blocked + pipeline_state → tool_allowed_frozen_probe (existing channel unchanged)", async () => {
    const TMP = await makeTmpRoot("pi-t34-probe-");
    const meta = makeTestMeta({
      pipelineId: "pipe-218-t34-probe",
      currentStage: "develop",
      flowState: "blocked",
      blockedReason: "loop_overflow",
    });
    expect(await runTool(TMP, meta, "pipeline_state", {})).toBeUndefined();
    expect(audits.some((a) => a.event === "tool_allowed_frozen_probe")).toBe(true);
    expect(audits.some((a) => a.event === "frozen_read_allowed")).toBe(false);
  });
});
