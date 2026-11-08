/**
 * 227 Phase 2 (D-14): in an auto job `request-human` is never a menu.
 *
 * | mode   | onFail      | decision      |
 * |--------|-------------|---------------|
 * | manual | any         | stop          |
 * | smart  | stop        | stop          |
 * | smart  | auto-revise | revise-plan   |
 * | auto   | n/a         | revise-plan   |
 * | human  | any         | null (menu)   |
 */
import { describe, it, expect } from "bun:test";
import {
  resolveAutoHumanFallback,
  applyAutoHumanFallback,
} from "../../core/design-review/auto-human-fallback";
import { makeTestMeta } from "../helpers";
import type { SessionMeta } from "../../types";

const autoMeta = (): SessionMeta =>
  makeTestMeta({
    currentStage: "design-review",
    autoJob: { jobId: "fallback_loop", jobPath: "docs/jobs/fallback_loop.yaml", docIndex: 0, totalDocs: 1 },
  });

describe("227 P2: resolveAutoHumanFallback matrix", () => {
  it("human track never rewrites the menu", () => {
    expect(resolveAutoHumanFallback(makeTestMeta(), "manual", "auto-revise")).toBeNull();
    expect(resolveAutoHumanFallback(makeTestMeta(), "smart", "stop")).toBeNull();
  });

  it("auto job + manual ⇒ stop-and-report (onFail never rewrites)", () => {
    expect(resolveAutoHumanFallback(autoMeta(), "manual", "auto-revise")).toBe("stop");
    expect(resolveAutoHumanFallback(autoMeta(), "manual", "stop")).toBe("stop");
  });

  it("auto job + smart ⇒ onFail decides", () => {
    expect(resolveAutoHumanFallback(autoMeta(), "smart", "stop")).toBe("stop");
    expect(resolveAutoHumanFallback(autoMeta(), "smart", "auto-revise")).toBe("revise-plan");
  });

  it("auto mode never stops on a human request (revise-plan default)", () => {
    expect(resolveAutoHumanFallback(autoMeta(), "auto", "auto-revise")).toBe("revise-plan");
  });
});

describe("227 P2: applyAutoHumanFallback", () => {
  it("`stop` outside an auto context performs no transaction and reports pending", async () => {
    const meta = makeTestMeta({ currentStage: "design-review", pipelineId: "pipe-227-fallback" });
    const ctx = { config: { projectRoot: "/nonexistent-227-fallback" }, session: {} } as never;

    const result = await applyAutoHumanFallback(ctx, meta, "stop");

    expect(result).toEqual({
      status: "handled",
      action: "pending",
      reason: "design_review_manual_fail",
    });
  });

  it("`revise-plan` is a no-op here (the coordinator routes handleFail itself)", async () => {
    const meta = makeTestMeta({ currentStage: "design-review" });
    const ctx = { config: { projectRoot: "/nonexistent-227-fallback" }, session: {} } as never;
    const result = await applyAutoHumanFallback(ctx, meta, "revise-plan");
    expect(result).toEqual({ status: "handled", action: "pending", reason: "auto_revise_plan" });
  });

  it("227 review fix 2: a child context FORWARDS the stop (never finalizes the job)", async () => {
    // `CoordinatorContext` drops `_ctx`, so the explicit `roleIsChild` evidence
    // is the ONLY thing that keeps a child from executing the owner transaction.
    const meta = autoMeta();
    const patches: Array<Partial<SessionMeta>> = [];
    const ctx = {
      config: { projectRoot: "/nonexistent-227-fallback" },
      session: {
        getMeta: () => meta,
        updateMeta: (patch: Partial<SessionMeta>) => {
          patches.push(patch);
          return meta;
        },
      },
      roleIsChild: true,
    } as never;

    const result = await applyAutoHumanFallback(ctx, meta, "stop");

    expect(result).toEqual({ status: "handled", action: "pending", reason: "design_review_manual_fail" });
    expect(patches).toHaveLength(1);
    expect(patches[0]?.autoJobStopPending).toMatchObject({ reason: "design_review_manual_fail" });
  });
});
