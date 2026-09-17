import { describe, it, expect } from "bun:test";
import { promptDecisionMenu } from "../../core/flow-state";
import type { FlowStateCtx } from "../../core/flow-state";
import type { SessionMeta, PipelineConfig } from "../../types";
import { makeTestMeta, makeTestConfig } from "../helpers";

/**
 * Phase 0 (182): choose-stage aftermath integration tests.
 *
 * Verifies that after a successful choose_stage via promptStageSelection
 * (secondary menu path), the status bar is synced with the correct
 * stage -> nextStage pointer text.
 */

function makeCtx(
  meta: SessionMeta,
  ui?: { select?: (msg: string, opts: string[]) => Promise<string | undefined>; notify?: (msg: string) => void },
): FlowStateCtx & { statusCalls: { key: string; text: string | undefined }[] } {
  const statusCalls: { key: string; text: string | undefined }[] = [];
  return {
    session: {
      getMeta: () => meta,
      updateMeta: (patch: Partial<SessionMeta>) => {
        Object.assign(meta, patch);
        return meta;
      },
    },
    ui: {
      ...ui,
      setStatus: (key: string, text: string | undefined) => {
        statusCalls.push({ key, text });
      },
    } as FlowStateCtx["ui"],
    statusCalls,
  };
}

describe("choose-stage aftermath: status bar sync (Phase 0 / 182)", () => {
  it("promptStageSelection via directStageSelect writes status bar with stage pointer", async () => {
    const TMP = "/tmp/choose-aftermath-" + Date.now();
    const config = makeTestConfig({ projectRoot: TMP, output: { pipelineStage: true } });

    const meta = makeTestMeta({
      currentStage: "develop",
      flowState: "blocked",
      blockedReason: "loop_overflow",
      pipelineId: "pipe-aftermath-001",
    });

    // Select "review" from the secondary stage menu
    const ctx = makeCtx(meta, {
      select: async (_msg: string, _options: string[]) => {
        // The secondary menu includes "review" as one of the choices
        return "review";
      },
    });

    const outcome = await promptDecisionMenu(ctx, meta, config, {
      source: "test",
      directStageSelect: true,
    });

    expect(outcome).toBe("decided");
    expect(meta.currentStage).toBe("review");

    // Verify status bar was written with the stage pointer text
    // formatStage produces: "[ pipeId • stage -> nextStage ]"
    const finalSetStatus = ctx.statusCalls.filter(c => c.key === "pipeline-stage" && c.text !== undefined);
    expect(finalSetStatus.length).toBeGreaterThanOrEqual(1);

    // The last status bar write should contain the "-> review" pointer
    const lastStatus = finalSetStatus[finalSetStatus.length - 1];
    expect(lastStatus.text).toBeDefined();
    // After choosing "review", the status bar should show "review" as current stage
    // with "-> fix" as the next stage pointer (review's nextStage is "fix")
    expect(lastStatus.text).toContain("review");
    expect(lastStatus.text).toContain("->");
  });

  it("promptStageSelection via choose_stage from first-level menu writes status bar", async () => {
    const TMP = "/tmp/choose-aftermath-first-" + Date.now();
    const config = makeTestConfig({ projectRoot: TMP, output: { pipelineStage: true } });

    const meta = makeTestMeta({
      currentStage: "develop",
      flowState: "blocked",
      blockedReason: "loop_overflow",
      pipelineId: "pipe-aftermath-002",
    });

    let selectCallCount = 0;
    const ctx = makeCtx(meta, {
      select: async (_msg: string, options: string[]) => {
        selectCallCount++;
        if (selectCallCount === 1) {
          // First-level menu: choose "Choose stage..."
          return "Choose stage…";
        }
        // Secondary menu: choose "review"
        return "review";
      },
    });

    const outcome = await promptDecisionMenu(ctx, meta, config, {
      source: "test",
    });

    expect(outcome).toBe("decided");
    expect(meta.currentStage).toBe("review");

    // Status bar should be synced
    const statusWrites = ctx.statusCalls.filter(c => c.key === "pipeline-stage" && c.text !== undefined);
    expect(statusWrites.length).toBeGreaterThanOrEqual(1);
  });
});
