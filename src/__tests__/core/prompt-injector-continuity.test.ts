/**
 * 219 Phase 6: the "task continuity" prompt section.
 *
 * Key behaviors:
 * - Rendered on BOTH injection paths (default assembly part + `{{task_continuity}}`).
 * - `none` → no section (clean prompts stay byte-identical).
 * - The human tier always renders; an auto job adds queue progress + budgets.
 * - `meta.continuity` wins; otherwise the same pure judgement is recomputed
 *   from the sidecar.
 */
import { describe, it, expect, beforeEach, afterEach, spyOn } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { makeTestConfig, makeTestMeta } from "../helpers";
import { buildTaskContinuitySection } from "../../core/prompt-injector";
import { createJobState, writeJobState, type AutoJobState } from "../../core/auto-pipeline/job-state";
import { acquireJobLock, __resetAutoJobLockForTests } from "../../core/auto-pipeline/config-overlay";
import { __setSafeWriteAuditLogOverride } from "../../utils/auditLog";

const SRC_ROOT = path.resolve(__dirname, "..", "..", "..");
const OWNER_PIPELINE_ID = "pipe-continuity-owner";

let ROOT: string;
let errorSpy: ReturnType<typeof spyOn>;
let infoSpy: ReturnType<typeof spyOn>;

function config() {
  return makeTestConfig({ projectRoot: ROOT });
}

async function installRunningJob(overrides?: Partial<AutoJobState>): Promise<AutoJobState> {
  const base = createJobState({
    jobId: "alpha",
    jobPath: "docs/jobs/alpha.yaml",
    jobHash: "h",
    docs: [{ doc: "docs/design/a.md" }, { doc: "docs/design/b.md" }],
  });
  const state: AutoJobState = {
    ...base,
    status: "running",
    counters: { ...base.counters, totalLoops: 3 },
    ...overrides,
  };
  state.docs[0]!.lastStage = "review";
  state.docs[0]!.pipelineId = OWNER_PIPELINE_ID;
  await writeJobState(ROOT, state);
  const lock = acquireJobLock({ projectRoot: ROOT, jobId: "alpha" });
  if (!lock.ok) throw new Error("lock acquire failed");
  return state;
}

beforeEach(() => {
  ROOT = fs.mkdtempSync(path.join(tmpdir(), "pi-219-continuity-prompt-"));
  __resetAutoJobLockForTests();
  __setSafeWriteAuditLogOverride(async () => undefined);
  errorSpy = spyOn(console, "error").mockImplementation(() => undefined);
  infoSpy = spyOn(console, "info").mockImplementation(() => undefined);
});

afterEach(() => {
  __setSafeWriteAuditLogOverride(null);
  errorSpy.mockRestore();
  infoSpy.mockRestore();
  __resetAutoJobLockForTests();
  fs.rmSync(ROOT, { recursive: true, force: true });
});

describe("prompt-injector — task continuity section", () => {
  it("no interruption → no section (clean prompt unchanged)", () => {
    expect(buildTaskContinuitySection(config(), makeTestMeta())).toBeNull();
  });

  it("meta.continuity=resume renders document / stage / flow state / actions", () => {
    const meta = makeTestMeta({
      flowState: "blocked",
      blockedReason: "loop_overflow",
      requirementDoc: "docs/design/a.md",
      continuity: "resume",
    });
    const section = buildTaskContinuitySection(config(), meta);
    expect(section).not.toBeNull();
    expect(section).toContain("# TASK CONTINUITY");
    expect(section).toContain("Decision: resume");
    expect(section).toContain("docs/design/a.md");
    expect(section).toContain("Stage: develop");
    expect(section).toContain("Flow state: blocked");
    expect(section).toContain("Allowed actions");
  });

  it("meta.continuity=none renders nothing", () => {
    const meta = makeTestMeta({ continuity: "none" });
    expect(buildTaskContinuitySection(config(), meta)).toBeNull();
  });

  it("without meta.continuity the section is recomputed from the sidecar (stage fallback)", async () => {
    await installRunningJob();
    const meta = makeTestMeta({ currentStage: undefined as unknown as never, requirementDoc: "docs/design/a.md" });
    const section = buildTaskContinuitySection(config(), meta);
    expect(section).not.toBeNull();
    expect(section).toContain("Decision: resume");
    // H4: the stage comes from docs[docIndex].lastStage.
    expect(section).toContain("Stage: review");
  });

  it("the session that OWNS the running doc renders nothing (no per-turn 'resume')", async () => {
    // Review 219 issue 10: `sessionStartedAt: Date.now()` made rule 2 true on
    // every turn of a legitimately running job. Identity, not a clock, tells
    // the owner apart: the sidecar's running doc carries this pipelineId.
    await installRunningJob({ lastSettleAt: Date.now() - 60_000 });
    const meta = makeTestMeta({
      pipelineId: OWNER_PIPELINE_ID,
      requirementDoc: "docs/design/a.md",
    });
    expect(buildTaskContinuitySection(config(), meta)).toBeNull();
  });

  it("a DIFFERENT session (no meta / other pipeline) still resumes the running job", async () => {
    await installRunningJob({ lastSettleAt: Date.now() - 60_000 });
    const meta = makeTestMeta({
      pipelineId: "pipe-someone-else",
      requirementDoc: "docs/design/a.md",
    });
    const section = buildTaskContinuitySection(config(), meta);
    expect(section).not.toBeNull();
    expect(section).toContain("Decision: resume");
  });

  it("auto tier adds job name, queue progress and budgets", async () => {
    await installRunningJob();
    const meta = makeTestMeta({
      requirementDoc: "docs/design/a.md",
      continuity: "resume",
      autoJob: {
        jobId: "alpha",
        jobPath: "docs/jobs/alpha.yaml",
        docIndex: 1,
        totalDocs: 2,
        designReviewMaxRounds: 3,
        designReviewRounds: 1,
      },
    });
    const section = buildTaskContinuitySection(config(), meta)!;
    expect(section).toContain("Auto job: alpha");
    expect(section).toContain("queue 2/2");
    expect(section).toContain("Remaining design-review rounds: 2");
    expect(section).toContain("Total loops used: 3 (budget unlimited)");
  });

  it("auto tier reports the REMAINING total-loop budget when the job set one", async () => {
    await installRunningJob();
    const meta = makeTestMeta({
      requirementDoc: "docs/design/a.md",
      continuity: "resume",
      autoJob: {
        jobId: "alpha",
        jobPath: "docs/jobs/alpha.yaml",
        docIndex: 0,
        totalDocs: 2,
        totalLoopsBudget: 5,
      },
    });
    const section = buildTaskContinuitySection(config(), meta)!;
    expect(section).toContain("Remaining total loops: 2 (budget 5, used 3)");
    expect(section).not.toContain("Total loops used:");
  });

  it("human tier never leaks auto-job fields", () => {
    const meta = makeTestMeta({ continuity: "resume" });
    const section = buildTaskContinuitySection(config(), meta)!;
    expect(section).not.toContain("Auto job:");
    expect(section).not.toContain("Remaining design-review");
  });
});

describe("prompt-injector — BOTH injection paths", () => {
  it("the default assembly and the placeholder table both build the section", () => {
    const text = fs.readFileSync(path.join(SRC_ROOT, "src", "core", "prompt-injector.ts"), "utf8");
    // Placeholder path.
    expect(text).toContain("task_continuity: buildTaskContinuitySection(config, meta)");
    // Default-parts path.
    expect(text).toContain("const part14 = buildTaskContinuitySection(config, meta)");
  });
});
