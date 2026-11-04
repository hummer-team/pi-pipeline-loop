/**
 * 224 Phase 3: the REAL plan-stage scheduling contract.
 *
 * One template, per-track truth: the plugin owns dispatch on every stage
 * entry it controls (stage transitions, auto job start stages); the ONE
 * exception is the human track starting a new pipeline AT the plan stage.
 * Three copies must stay verbatim: the yml template, the fallback constant
 * and the business project's manual sync (documented handover step).
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { createPromptInjector } from "../../core/prompt-injector";
import { makeTestConfig, makeTestMeta } from "../helpers";
import type { SessionMeta } from "../../types";
import { resetGitignoreCache } from "../../utils/gitignore";
import { resetPromptConfigCache } from "../../core/prompt-config";
import { initAuditLog, __resetAuditDirPath } from "../../utils/auditLog";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";

const SRC_ROOT = path.resolve(__dirname, "..", "..", "..");
const TEMPLATE_YML = path.join(SRC_ROOT, "src", "template", "references", "pipeline-stage-prompt.yml");

const NEW_SCHEDULING =
  "**Scheduling**: The plugin owns dispatch on every stage entry it controls — a stage transition, or an auto job's start stage — and spawns `{subagent_type}` automatically; do NOT invoke the agent yourself while a plugin spawn is active or queued. The ONE exception is the human track starting a new pipeline AT this stage (`/pipeline-start` with this stage as start stage): nothing is spawned there, so invoke @`{subagent_type}` with the plan document path yourself. The agent returns `nextStage: develop`; the main thread calls stage_advance.";

/** Extracts one `key: |` block from the yml (lines up to the next top-level key). */
function readYmlStage(fileName: string, key: string): string[] {
  const lines = fs.readFileSync(fileName, "utf8").split("\n");
  const marker = lines.findIndex((line) => line === `${key}: |`);
  if (marker < 0) throw new Error(`${key} not found in ${fileName}`);
  const block: string[] = [];
  for (let i = marker + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.length > 0 && !line.startsWith(" ") && line !== "") break;
    block.push(line);
  }
  while (block.length > 0 && block[block.length - 1] === "") block.pop();
  return block;
}

let TMP: string;

beforeEach(() => {
  TMP = fs.mkdtempSync(path.join(tmpdir(), "pi-224-plan-copy-"));
  resetGitignoreCache();
  resetPromptConfigCache();
});

afterEach(async () => {
  resetPromptConfigCache();
  __resetAuditDirPath();
  await rm(TMP, { recursive: true, force: true });
});

async function renderStageExecutorSegment(stage: SessionMeta["currentStage"], opts: { withStageYml?: boolean } = {}): Promise<string> {
  if (opts.withStageYml) {
    // Deploy the plane stage template EXACTLY as /pipeline-init does.
    const reference = path.join(TMP, ".pi", "references");
    fs.mkdirSync(reference, { recursive: true });
    fs.copyFileSync(TEMPLATE_YML, path.join(reference, "pipeline-stage-prompt.yml"));
  } else {
    // Fallback shape: a project yml exists but carries no stage_executor keys.
    const reference = path.join(TMP, ".pi", "references");
    fs.mkdirSync(reference, { recursive: true });
    fs.writeFileSync(path.join(reference, "pipeline-stage-prompt.yml"), "plan: |\n  {{stage_executor}}\n", "utf8");
  }
  const config = makeTestConfig({ projectRoot: TMP });
  await initAuditLog(config);
  const meta = makeTestMeta({ currentStage: stage, pipelineId: "pipe-224" });
  const ctx = { session: { getMeta: () => meta } };
  const hook = createPromptInjector(config);
  const result = await hook.handler(ctx as never);
  return result?.systemPrompt ?? "";
}

describe("224 phase 3 — the default yml template states the real contract", () => {
  it("stage_executor_plan carries the new sentence and its 6 unchanged lines", () => {
    const block = readYmlStage(TEMPLATE_YML, "stage_executor_plan");
    const text = block.join("\n");
    // The new sentence is present, the false manual claim is gone.
    expect(text).toContain(NEW_SCHEDULING);
    expect(text).not.toContain("**Scheduling**: User @`{subagent_type}`");
    // The 6 other (non-empty) lines of the block are untouched, in place.
    const nonEmpty = block.filter((line) => line.trim().length > 0);
    expect(nonEmpty.length).toBe(6);
    expect(nonEmpty[0]).toContain("## Stage Executor Scheduling");
    expect(nonEmpty[1]).toContain("This stage uses `{subagent_type}` (lightweight advance mode).");
    expect(nonEmpty[3]).toContain("**Context**: {context_arg}");
    expect(nonEmpty[4]).toContain("**Checkpoint**: Do NOT call `stage_advance` until the plan document is complete and user-confirmed.");
    expect(nonEmpty[5]).toContain("{active_spawn_note}");
  });

  it("clarify / design-review / develop / review / fix blocks are byte-identical to before", () => {
    const clarify = readYmlStage(TEMPLATE_YML, "stage_executor_clarify").join("\n");
    expect(clarify).toContain("**Scheduling**: User @`{subagent_type}` in chat with the requirement document path.");
    const designReview = readYmlStage(TEMPLATE_YML, "stage_executor_design-review").join("\n");
    expect(designReview).toContain("**Scheduling**: The plugin auto-spawns `{subagent_type}` on stage entry. Main thread must NOT re-invoke. The plugin owns dispatch. Never call `{subagent_type}` yourself while a plugin spawn is queued or active. A one-shot manual dispatch is authorized ONLY after the plugin reports a `pending_spawn_stalled` event, and only once.");
    const develop = readYmlStage(TEMPLATE_YML, "stage_executor_develop").join("\n");
    expect(develop).toContain("**Scheduling**: The plugin auto-spawns `{subagent_type}` on stage entry. Main thread must NOT re-invoke.");
    const review = readYmlStage(TEMPLATE_YML, "stage_executor_review").join("\n");
    expect(review).toContain("**Scheduling**: The plugin auto-spawns `{subagent_type}` on stage entry. Main thread must NOT re-invoke.");
    const fix = readYmlStage(TEMPLATE_YML, "stage_executor_fix").join("\n");
    expect(fix).toContain("**Scheduling**: The plugin auto-spawns `{subagent_type}` on stage entry. Main thread must NOT re-invoke.");
  });
});

describe("224 phase 3 — rendered plan prompt (yml path vs fallback path)", () => {
  it("yml path: rendered plan prompt contains the new sentence, never `User @`", async () => {
    const rendered = await renderStageExecutorSegment("plan", { withStageYml: true });
    expect(rendered).toContain("The plugin owns dispatch on every stage entry it controls");
    expect(rendered).toContain("invoke @`feat-design-plan-agent` with the plan document path yourself");
    expect(rendered).not.toContain("**Scheduling**: User @`feat-design-plan-agent`");
    // The human-track exception is stated (a sentence, not a bare count).
    expect(rendered).toContain("The ONE exception is the human track starting a new pipeline AT this stage");
  });

  it("fallback path (no yml key): the plugin default says the SAME sentence", async () => {
    const rendered = await renderStageExecutorSegment("plan");
    expect(rendered).toContain("**Scheduling**: The plugin owns dispatch on every stage entry it controls");
    expect(rendered).toContain("invoke @`feat-design-plan-agent` with the plan document path yourself");
    expect(rendered).not.toContain("**Scheduling**: User @`feat-design-plan-agent`");
  });

  it("other stages keep their per-stage truth in the same fallback shape", async () => {
    const clarify = await renderStageExecutorSegment("clarify");
    expect(clarify).toContain("**Scheduling**: User @`feat-design-plan-agent` in chat with the requirement document path.");
    const develop = await renderStageExecutorSegment("develop");
    expect(develop).toContain("**Scheduling**: The plugin auto-spawns `develop-agent` on stage entry. Main thread must NOT re-invoke.");
    const review = await renderStageExecutorSegment("review");
    expect(review).toContain("The plugin owns dispatch. Never call `code-review-agent` yourself while a plugin spawn is queued or active.");
    const fix = await renderStageExecutorSegment("fix");
    expect(fix).toContain("A one-shot manual dispatch is authorized ONLY after the plugin reports a `pending_spawn_stalled` event");
  });
});
