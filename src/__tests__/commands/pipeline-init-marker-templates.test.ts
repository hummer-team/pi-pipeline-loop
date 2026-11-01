/**
 * 221 review round 2 (issue 1): the clarify templates that agents read
 * DIRECTLY (`skills/design/SKILL.md`, `references/clarify_template.md`) carry
 * marker placeholders that `/pipeline-init` resolves at install time.
 *
 * Without this, a project with a custom primary would ship a SKILL/template
 * still telling the agent to write the default `答：` / `## 模型确认`, which the
 * precheck no longer accepts.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { createPipelineInitCommand } from "../../commands/pipeline-init";
import { makeTestConfig } from "../helpers";
import type { PipelineConfig } from "../../types";

let TMP: string;

beforeEach(async () => {
  TMP = path.join(tmpdir(), "pi-init-marker-" + Date.now() + "-" + Math.random().toString(36).slice(2));
  await fs.mkdir(TMP, { recursive: true });
});

afterEach(async () => {
  await fs.rm(TMP, { recursive: true, force: true });
});

function customConfig(): PipelineConfig {
  return makeTestConfig({
    projectRoot: TMP,
    clarifyProtocol: {
      answerMarkers: ["Confirm:"],
      modelConfirm: ["## Custom Confirm"],
    },
  });
}

async function install(config: PipelineConfig): Promise<void> {
  const cmd = createPipelineInitCommand(config);
  const result = (await cmd.execute("0" as never)) as { success?: boolean };
  expect(result.success).toBe(true);
}

describe("pipeline-init: clarify marker templates", () => {
  it("resolves the marker placeholders of directly-read templates", async () => {
    await install(customConfig());

    const skill = await fs.readFile(path.join(TMP, ".pi", "skills", "design", "SKILL.md"), "utf8");
    expect(skill).toContain("`Confirm:`");
    expect(skill).toContain("`## Custom Confirm`");
    expect(skill).not.toContain("{answerMarker}");
    expect(skill).not.toContain("{completionMarker}");
    expect(skill).not.toContain("{completionAliases}");

    const template = await fs.readFile(
      path.join(TMP, ".pi", "references", "clarify_template.md"),
      "utf8",
    );
    expect(template).toContain("Confirm:");
    expect(template).toContain("## Custom Confirm");
    expect(template).not.toContain("{answerMarker}");
    expect(template).not.toContain("{completionMarker}");
    expect(template).not.toContain("{completionAliases}");
  });

  it("keeps the bilingual defaults with no clarify configuration", async () => {
    await install(makeTestConfig({ projectRoot: TMP }));

    const template = await fs.readFile(
      path.join(TMP, ".pi", "references", "clarify_template.md"),
      "utf8",
    );
    expect(template).toContain("答：");
    expect(template).toContain("## 模型确认");
    expect(template).not.toContain("{completionMarker}");
  });
});
