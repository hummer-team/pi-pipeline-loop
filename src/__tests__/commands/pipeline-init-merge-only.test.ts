/**
 * @module pipeline-init-merge-only.test
 * Phase 5 / 177 (D11): `/pipeline-init` must not overwrite an existing deployed
 * SKILL.md (preserve English localization); it only injects/updates the
 * managed-contract block. guide.md keeps its always-overwrite semantics.
 *
 * Kept in a dedicated file: the sibling pipeline-init.test.ts installs a global
 * `mock.module("../../core/prompt-config")` that would otherwise mask the real
 * yml-based managed-block rendering.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { createPipelineInitCommand } from "../../commands/pipeline-init";
import { makeTestConfig } from "../helpers";

let TMP: string;

beforeEach(async () => {
  TMP = path.join(tmpdir(), "pi-177-init-merge-" + Date.now() + "-" + Math.random().toString(36).slice(2));
  await fs.mkdir(TMP, { recursive: true });
});

afterEach(async () => {
  await fs.rm(TMP, { recursive: true, force: true });
});

function makeInitConfig() {
  return makeTestConfig({
    projectRoot: TMP,
    stages: Object.fromEntries(
      ["clarify", "plan", "develop", "review", "fix", "awaiting_human", "completed"].map(
        (s, i, a) => [
          s,
          {
            agentPath: `.pi/agents/${s}/${s}.md`,
            skillPath: `${s}/SKILL.md`,
            nextStage: a[i + 1] ?? null,
            requireDomain: false,
          },
        ],
      ),
    ) as any,
  });
}

describe("Phase 5 / 177 (D11): SKILL.md merge-only init", () => {
  it("existing localized SKILL is not overwritten; block injected and verbatim preserved", async () => {
    const config = makeInitConfig();
    const skillDir = path.join(TMP, ".pi", "skills", "plan");
    await fs.mkdir(skillDir, { recursive: true });
    await fs.writeFile(
      path.join(skillDir, "SKILL.md"),
      "# English Localized SKILL\n\nCustom localized guidance.\n",
      "utf-8",
    );

    const cmd = createPipelineInitCommand(config);
    const result: any = await cmd.execute("0" as any);
    expect(result.success).toBe(true);

    const after = await fs.readFile(path.join(skillDir, "SKILL.md"), "utf-8");
    // Block-external localization preserved (NOT overwritten by the repo template).
    expect(after).toContain("# English Localized SKILL");
    expect(after).toContain("Custom localized guidance.");
    // Managed contract block injected by the merge loop.
    expect(after).toContain("BEGIN pi-pipeline:managed-contract");
  });

  it("guide.md is still always overwritten", async () => {
    const config = makeInitConfig();
    await fs.mkdir(path.join(TMP, ".pi"), { recursive: true });
    await fs.writeFile(path.join(TMP, ".pi", "guide.md"), "# OLD Guide\n", "utf-8");

    const cmd = createPipelineInitCommand(config);
    await cmd.execute("0" as any);

    const after = await fs.readFile(path.join(TMP, ".pi", "guide.md"), "utf-8");
    expect(after).not.toBe("# OLD Guide\n");
    expect(after.length).toBeGreaterThan("# OLD Guide\n".length);
  });
});
