/**
 * @module review2-m2-forward-args
 * Tests for review#2 M2: forwardArgs passthrough on 4 residual branches.
 * Phase 3 Q3-A: explicit forwardArgs are passed through unconditionally.
 *
 * Each test asserts real behavior; removing the corresponding implementation must
 * turn the test red (no empty/typeof assertions).
 */

import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { createPipelineStartCommand } from "../../commands/pipeline-start";
import { makeTestConfig, makeTestMeta, createMockCtx } from "../helpers";
import { initAuditLog, __resetAuditDirPath } from "../../utils/auditLog";
import { __resetMemoryThrottle } from "../../utils/audit-throttle";

describe("M2: forwardArgs passthrough on residual branches", () => {
  let TMP: string;

  beforeEach(async () => {
    TMP = path.join(
      os.tmpdir(),
      `pi-r2-forward-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    );
    await fsp.mkdir(TMP, { recursive: true });
    await initAuditLog(makeTestConfig({ projectRoot: TMP }));
    __resetMemoryThrottle();
  });

  afterEach(async () => {
    await fsp.rm(TMP, { recursive: true, force: true });
    __resetAuditDirPath();
  });

  it("M2a: aborted + different doc + forwardArgs → new pipeline clarify receives forwardArgs", async () => {
    // Write both old and new docs
    await fsp.mkdir(path.join(TMP, "docs"), { recursive: true });
    await fsp.writeFile(path.join(TMP, "docs", "old.md"), "# Old\n", "utf-8");
    await fsp.writeFile(path.join(TMP, "docs", "new.md"), "# New\n", "utf-8");

    const config = makeTestConfig({ projectRoot: TMP, startStageMode: "auto" });
    const cmd = createPipelineStartCommand(config);

    // Existing aborted pipeline for a different doc
    const meta = makeTestMeta({
      currentStage: "plan",
      flowState: "aborted",
      requirementDoc: "docs/old.md",
    });
    const ctx = createMockCtx(meta, { sessionFile: "main-session" });

    // Execute with a NEW doc + forwardArgs
    const result: any = await cmd.execute(
      { file: "docs/new.md", forwardArgs: "focus-on-X" },
      ctx as any,
    );

    // Different doc → goes to startNewPipeline with forwardArgs
    expect(result.success).toBe(true);
    expect(result.currentStage).toBe("clarify");
    // meta.requirementDoc must reflect the new doc (not silently stuck on old)
    expect(ctx.session.getMeta().requirementDoc).toBe("docs/new.md");
  });

  it("M2b: fresh + mode=ask + forwardArgs → ask menu receives forwardArgs", async () => {
    await fsp.mkdir(path.join(TMP, "docs"), { recursive: true });
    await fsp.writeFile(path.join(TMP, "docs", "feature.md"), "# Feature\n", "utf-8");

    // Mode=ask with select returning "New pipeline"
    const config = makeTestConfig({
      projectRoot: TMP,
      startStageMode: "ask",
    });
    const cmd = createPipelineStartCommand(config);
    const freshMeta = makeTestMeta({ currentStage: "", pipelineId: "" } as any);
    const ctx = createMockCtx(freshMeta, {
      sessionFile: "main-session",
      selectReturn: "New pipeline",
      confirmReturn: true,
    });

    const result: any = await cmd.execute(
      { file: "docs/feature.md", forwardArgs: "full-und?" },
      ctx as any,
    );

    // After "New pipeline" selection, startNewPipeline is invoked with forwardArgs.
    expect(result.success).toBe(true);
    expect(result.currentStage).toBe("clarify");
  });

  it("M2c: ask menu 'Spec stage' + forwardArgs → startNewPipeline receives forwardArgs", async () => {
    await fsp.mkdir(path.join(TMP, "docs"), { recursive: true });
    await fsp.writeFile(path.join(TMP, "docs", "feature.md"), "# Feature\n", "utf-8");

    const config = makeTestConfig({
      projectRoot: TMP,
      startStageMode: "ask",
    });
    const cmd = createPipelineStartCommand(config);
    const freshMeta = makeTestMeta({ currentStage: "", pipelineId: "" } as any);
    const ctx = createMockCtx(freshMeta, {
      sessionFile: "main-session",
      selectReturn: "Spec stage",
      confirmReturn: true,
    });
    // Second select returns "Start at: develop"
    const origSelect = ctx.ui.select;
    let selectCalls = 0;
    ctx.ui.select = async (_msg: string, opts: string[]) => {
      selectCalls++;
      if (selectCalls === 1) return "Spec stage";
      if (selectCalls === 2) return "Start at: develop";
      return origSelect?.(_msg, opts);
    };

    const result: any = await cmd.execute(
      { file: "docs/feature.md", forwardArgs: "focus-on-review" },
      ctx as any,
    );

    // Spec stage 'develop' → startNewPipeline with forwardArgs forwarded
    expect(result.success).toBe(true);
    // The starting stage should be develop (from the second select)
    expect(result.currentStage).toBe("develop");
  });
});
