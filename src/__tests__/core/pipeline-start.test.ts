import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { createPipelineStartCommand } from "../../commands/pipeline-start";
import { makeTestConfig, createMockCtx, makeTestMeta } from "../helpers";

let TMP: string;
let docPath: string;

beforeEach(async () => {
  TMP = path.join(tmpdir(), "pi-start-" + Date.now());
  await fs.mkdir(TMP, { recursive: true });
  docPath = path.join(TMP, "req.md");
});

afterEach(async () => {
  await fs.rm(TMP, { recursive: true, force: true });
});

describe("createPipelineStartCommand", () => {
  it("starts a pipeline with a valid doc file", async () => {
    await fs.writeFile(docPath, "# My Requirements\nDo X and Y", "utf-8");
    const config = makeTestConfig({ projectRoot: TMP });
    const meta = makeTestMeta({ currentStage: "", pipelineId: "" } as any);
    let updatedMeta: any = null;
    const ctx = {
      session: {
        getMetadata: () => meta,
        updateMetadata: (m: any) => { updatedMeta = m; },
      },
    };

    const cmd = createPipelineStartCommand(config);
    const result: any = await cmd.execute({ file: "req.md" }, ctx);

    expect(result.success).toBe(true);
    expect(result.pipelineId).toMatch(/^pipe-/);
    expect(result.currentStage).toBe("clarify");
    expect(result.requirementContent).toContain("# My Requirements");
    expect(updatedMeta).not.toBeNull();
    expect(updatedMeta.currentStage).toBe("clarify");
    expect(updatedMeta.requirementDoc).toBe("req.md");
  });

  it("returns error when file is missing", async () => {
    const config = makeTestConfig({ projectRoot: TMP });
    const meta = makeTestMeta({ currentStage: "", pipelineId: "" } as any);
    const ctx = {
      session: {
        getMetadata: () => meta,
        updateMetadata: () => {},
      },
    };

    const cmd = createPipelineStartCommand(config);
    const result: any = await cmd.execute({ file: "nonexistent.md" }, ctx);

    expect(result.success).toBe(false);
    expect(result.error).toContain("File not found");
  });

  it("returns error when pipeline already running", async () => {
    await fs.writeFile(docPath, "content", "utf-8");
    const config = makeTestConfig({ projectRoot: TMP });
    const meta = makeTestMeta();
    const ctx = createMockCtx(meta);

    const cmd = createPipelineStartCommand(config);
    const result: any = await cmd.execute({ file: "req.md" }, ctx as any);

    expect(result.success).toBe(false);
    expect(result.error).toContain("already running");
  });

  it("handles empty file content", async () => {
    await fs.writeFile(docPath, "", "utf-8");
    const config = makeTestConfig({ projectRoot: TMP });
    const meta = makeTestMeta({ currentStage: "", pipelineId: "" } as any);
    let updatedMeta: any = null;
    const ctx = {
      session: {
        getMetadata: () => meta,
        updateMetadata: (m: any) => { updatedMeta = m; },
      },
    };

    const cmd = createPipelineStartCommand(config);
    const result: any = await cmd.execute({ file: "req.md" }, ctx);

    expect(result.success).toBe(true);
    expect(result.requirementContent).toBe("");
    expect(updatedMeta.requirementDoc).toBe("req.md");
  });
});
