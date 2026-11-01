/**
 * 219 Phase 5 §1: the shared session-resource release.
 *
 * Key behaviors:
 * - Clears EXACTLY the pre-refactor `/pipeline-quit` field list (table below).
 * - Never writes `flowState` / `terminateReason` — attribution is the caller's.
 * - Critical steps (authorization, executor binding) surface `criticalFailed`;
 *   non-critical failures only warn + land in `failedSteps` (never throws).
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { makeTestConfig, makeTestMeta } from "../helpers";
import { releaseSessionResources } from "../../core/auto-pipeline/cleanup";
import { __setSafeWriteAuditLogOverride } from "../../utils/auditLog";
import type { SessionMeta } from "../../types";

/** The exact clear-patch the pre-refactor quit wrote. */
const EXPECTED_CLEARED_KEYS = [
  "sessionAllowedCommands",
  "sessionAllowedWritePaths",
  "verifyAttempts",
  "verifyFailures",
  "stageExitRefusal",
  "pendingOwnerApprovals",
  "blockedReason",
].sort();

let diagnosticActions: string[];

beforeEach(() => {
  diagnosticActions = [];
  // Review round 2 (issue 6): diagnostics go to the AUDIT LOG, never console.
  __setSafeWriteAuditLogOverride(async (stage, message) => {
    if (stage !== "pipeline_auto_diagnostic") return;
    diagnosticActions.push(String((message as { action?: string } | undefined)?.action ?? ""));
  });
});

afterEach(() => {
  __setSafeWriteAuditLogOverride(null);
});

function makeCtx(overrides?: {
  meta?: SessionMeta | null;
  getMetaThrows?: boolean;
  updateMetaThrows?: boolean;
}) {
  const patches: Array<Partial<SessionMeta>> = [];
  const statusWrites: unknown[] = [];
  return {
    patches,
    statusWrites,
    ctx: {
      session: {
        getMeta: () => {
          if (overrides?.getMetaThrows) throw new Error("meta unreadable");
          return overrides?.meta === null ? undefined : (overrides?.meta ?? makeTestMeta());
        },
        updateMeta: (patch: Partial<SessionMeta>) => {
          if (overrides?.updateMetaThrows) throw new Error("meta write failed");
          patches.push(patch);
          return { ...makeTestMeta(), ...patch };
        },
      },
      ui: {
        setStatus: (key: string, value: unknown) => statusWrites.push([key, value]),
        notify: () => undefined,
      },
    } as never,
  };
}

describe("cleanup — field list equivalence", () => {
  it("clears exactly the quit-era fields and nothing terminal", async () => {
    const { ctx, patches } = makeCtx();
    const result = await releaseSessionResources(ctx, makeTestConfig({ output: { pipelineStage: false } }), {
      reason: "user_quit",
    });

    expect(result.criticalFailed).toBe(false);
    expect(result.failedSteps).toEqual([]);
    expect(patches).toHaveLength(1);
    expect(Object.keys(patches[0]!).sort()).toEqual(EXPECTED_CLEARED_KEYS);
    // Terminal attribution belongs to the caller (quit/auto job).
    expect(patches[0]!.flowState).toBeUndefined();
    expect(patches[0]!.terminateReason).toBeUndefined();
  });

  it("is a no-op-ish release for a session with no pipeline meta", async () => {
    const { ctx, patches } = makeCtx({ meta: null });
    const result = await releaseSessionResources(ctx, makeTestConfig({ output: { pipelineStage: false } }), {
      reason: "auto_stopped",
    });
    expect(result.criticalFailed).toBe(false);
    expect(patches).toHaveLength(1);
  });
});

describe("cleanup — failure classification", () => {
  it("an unreadable meta is a CRITICAL failure (authorization cannot be invalidated)", async () => {
    const { ctx } = makeCtx({ getMetaThrows: true });
    const result = await releaseSessionResources(ctx, makeTestConfig({ output: { pipelineStage: false } }), {
      reason: "auto_failed",
    });
    expect(result.criticalFailed).toBe(true);
    expect(result.failedSteps).toContain("invalidate_design_review_authorization");
  });

  it("a failing meta write is NON-critical (warn + failedSteps)", async () => {
    const { ctx } = makeCtx({ updateMetaThrows: true });
    const result = await releaseSessionResources(ctx, makeTestConfig({ output: { pipelineStage: false } }), {
      reason: "auto_completed",
    });
    expect(result.criticalFailed).toBe(false);
    expect(result.failedSteps).toContain("clear_session_fields");
    expect(diagnosticActions).toContain("release_meta_clear_failed");
  });
});
