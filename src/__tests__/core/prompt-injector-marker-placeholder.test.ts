/**
 * 221 Phase 1: the clarify prompt asks for the CONFIGURED marker/answer primary.
 *
 * Sealed behaviors:
 * - default config (no job JSON) → the human text is unchanged
 *   (`## 模型确认` + `答：`);
 * - a configured primary replaces the yml `{completionMarker}` / `{answerMarker}`
 *   placeholders in the executor section;
 * - an already deployed legacy yml (literal `## 模型确认`) is still rewritten
 *   WITHOUT re-running `/pipeline-init`;
 * - the fallback (no yml file) text uses the same primary.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { createPromptInjector } from "../../core/prompt-injector";
import { makeTestConfig, makeTestMeta } from "../helpers";
import { initAuditLog, __resetAuditDirPath } from "../../utils/auditLog";
import { __resetMemoryThrottle } from "../../utils/audit-throttle";
import { resetPromptConfigCache } from "../../core/prompt-config";
import type { PipelineConfig, SessionMeta } from "../../types";

const MANAGER_SYMBOL = Symbol.for("pi-subagents:manager");
const TEMPLATE_YML = path.join(__dirname, "../../template/references/pipeline-stage-prompt.yml");

/** Invoke the real before_agent_start handler with the minimal ctx it needs. */
async function invokeInjector(config: PipelineConfig, meta: SessionMeta): Promise<string> {
  const hook = createPromptInjector(config);
  const ctx = { session: { getMeta: () => meta } };
  const result = (await hook.handler(ctx as any)) as { systemPrompt?: string } | undefined;
  expect(result?.systemPrompt).toBeDefined();
  return result!.systemPrompt!;
}

function clarifyMeta(): SessionMeta {
  return makeTestMeta({ currentStage: "clarify", requirementDoc: "docs/design/req.md" });
}

let TMP: string;

beforeEach(async () => {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), "pi-221-marker-placeholder-"));
  delete (globalThis as Record<symbol, unknown>)[MANAGER_SYMBOL];
  resetPromptConfigCache();
  await initAuditLog(makeTestConfig({ projectRoot: TMP }));
  __resetMemoryThrottle();
});

afterEach(() => {
  delete (globalThis as Record<symbol, unknown>)[MANAGER_SYMBOL];
  fs.rmSync(TMP, { recursive: true, force: true });
  __resetAuditDirPath();
  resetPromptConfigCache();
});

function deployYml(transform?: (content: string) => string): void {
  const dir = path.join(TMP, ".pi", "references");
  fs.mkdirSync(dir, { recursive: true });
  const content = fs.readFileSync(TEMPLATE_YML, "utf8");
  fs.writeFileSync(
    path.join(dir, "pipeline-stage-prompt.yml"),
    transform ? transform(content) : content,
    "utf8",
  );
  resetPromptConfigCache();
}

function customMarkerConfig(): PipelineConfig {
  return makeTestConfig({
    projectRoot: TMP,
    clarifyProtocol: {
      modelConfirm: ["## Custom Confirm"],
      answerMarkers: ["Confirm:"],
    },
  });
}

describe("clarify marker placeholders (yml path)", () => {
  it("keeps the Chinese defaults when no job config is installed", async () => {
    deployYml();
    const prompt = await invokeInjector(makeTestConfig({ projectRoot: TMP }), clarifyMeta());
    expect(prompt).toContain("`## 模型确认` marker");
    expect(prompt).toContain("`答：` fields");
    expect(prompt).not.toContain("{completionMarker}");
    expect(prompt).not.toContain("{answerMarker}");
  });

  it("substitutes the configured primaries", async () => {
    deployYml();
    const prompt = await invokeInjector(customMarkerConfig(), clarifyMeta());
    expect(prompt).toContain("`## Custom Confirm` marker");
    expect(prompt).toContain("`Confirm:` fields");
    expect(prompt).not.toContain("{completionMarker}");
    expect(prompt).not.toContain("{answerMarker}");
  });

  it("rewrites a legacy yml that still carries the literal Chinese marker", async () => {
    // Simulates a project initialised before 221: the deployed yml has the
    // literal marker, so the configured primary must win without /pipeline-init.
    deployYml((content) =>
      content.replaceAll("{completionMarker}", "## 模型确认").replaceAll("{answerMarker}", "**答**"),
    );
    const prompt = await invokeInjector(customMarkerConfig(), clarifyMeta());
    expect(prompt).toContain("`## Custom Confirm` marker");
  });
});

describe("clarify marker placeholders (fallback path)", () => {
  it("uses the default primary without a yml template", async () => {
    // No .pi/references/pipeline-stage-prompt.yml → hardcoded executor text.
    const prompt = await invokeInjector(makeTestConfig({ projectRoot: TMP }), clarifyMeta());
    expect(prompt).toContain("`## 模型确认` marker");
  });

  it("uses the configured primary without a yml template", async () => {
    const prompt = await invokeInjector(customMarkerConfig(), clarifyMeta());
    expect(prompt).toContain("`## Custom Confirm` marker");
  });
});
