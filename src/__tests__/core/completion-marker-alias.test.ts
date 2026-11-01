/**
 * 221 Phase 1: `completionMarker` alias arrays for the settle precheck, and the
 * PROMPT primary selection that must never flip the precheck switch.
 *
 * Sealed behaviors:
 * - a configured string behaves exactly as before (human zero-regression);
 * - an array accepts ANY alias, and an EMPTY array means "no precheck";
 * - a marker inside a fenced code block or mid-line never counts;
 * - the prompt primary is job JSON → stage `completionMarker` → defaults, but
 *   the precheck stays driven by `completionMarker` alone.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { precheckCompletionMarker } from "../../core/auto-verifier";
import { resolveClarifyPromptMarkers } from "../../core/auto-pipeline/clarify-autopilot";
import { makeTestConfig, makeTestMeta } from "../helpers";
import type { SessionMeta } from "../../types";

let TMP: string;
let docPath: string;

beforeEach(() => {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), "pi-221-marker-"));
  docPath = path.join(TMP, "docs", "req.md");
  fs.mkdirSync(path.dirname(docPath), { recursive: true });
});

afterEach(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
});

function writeDoc(text: string): void {
  fs.writeFileSync(docPath, text, "utf8");
}

function meta(): SessionMeta {
  return makeTestMeta({ currentStage: "clarify", requirementDoc: "docs/req.md" });
}

describe("precheckCompletionMarker alias support", () => {
  it("accepts the default Chinese string marker (unchanged path)", async () => {
    writeDoc("# Req\n\n## 模型确认\nconfirmed\n");
    expect(await precheckCompletionMarker(meta(), "## 模型确认", TMP)).toBe(true);
  });

  it("accepts an English-only string marker", async () => {
    writeDoc("# Req\n\n## Model Confirmation\nconfirmed\n");
    expect(await precheckCompletionMarker(meta(), "## Model Confirmation", TMP)).toBe(true);
  });

  it("never treats a missing marker as confirmed (no marker path)", async () => {
    writeDoc("# Req\n\n````markdown\n## 模型确认\n````\n");
    expect(await precheckCompletionMarker(meta(), "## 模型确认", TMP)).toBe(false);
  });

  it("accepts any configured array alias", async () => {
    writeDoc("# Req\n\n## Model Confirmation\nconfirmed\n");
    const marker = ["## 模型确认", "## Model Confirmation"];
    expect(await precheckCompletionMarker(meta(), marker, TMP)).toBe(true);
  });

  it("an EMPTY array means no precheck (always false, never a freeze)", async () => {
    writeDoc("# Req\n\n## 模型确认\nconfirmed\n");
    expect(await precheckCompletionMarker(meta(), [], TMP)).toBe(false);
  });

  it("is false when no alias is present", async () => {
    writeDoc("# Req\n\nnothing yet\n");
    expect(
      await precheckCompletionMarker(meta(), ["## 模型确认", "## Model Confirmation"], TMP),
    ).toBe(false);
  });

  it("ignores a marker inside a fenced code block", async () => {
    writeDoc("# Req\n\n```markdown\n## 模型确认\n```\n");
    expect(await precheckCompletionMarker(meta(), "## 模型确认", TMP)).toBe(false);
  });

  it("ignores an inline (mid-line) marker reference", async () => {
    writeDoc("# Req\n\nwrite the `## 模型确认` marker later\n");
    expect(await precheckCompletionMarker(meta(), "## 模型确认", TMP)).toBe(false);
  });

  it("is false when the document is unbound", async () => {
    const unbound = makeTestMeta({ currentStage: "clarify", requirementDoc: undefined });
    expect(await precheckCompletionMarker(unbound, "## 模型确认", TMP)).toBe(false);
  });
});

describe("clarify prompt primary selection", () => {
  it("defaults to the Chinese marker and answer literal", () => {
    const markers = resolveClarifyPromptMarkers(makeTestConfig());
    expect(markers.completionMarker).toBe("## 模型确认");
    expect(markers.answerMarker).toBe("答：");
  });

  it("uses the stage completionMarker primary when configured", () => {
    const config = makeTestConfig();
    config.stages.clarify!.verify = {
      require: true,
      completionMarker: ["## Model Confirmation", "## 模型确认"],
    };
    expect(resolveClarifyPromptMarkers(config).completionMarker).toBe("## Model Confirmation");
  });

  it("prefers the job JSON modelConfirm primary for prompts", () => {
    const config = makeTestConfig();
    config.clarifyProtocol = {
      modelConfirm: ["## Custom Confirm"],
      answerMarkers: ["Confirm:"],
    };
    const markers = resolveClarifyPromptMarkers(config);
    expect(markers.completionMarker).toBe("## Custom Confirm");
    expect(markers.answerMarker).toBe("Confirm:");
  });
});
