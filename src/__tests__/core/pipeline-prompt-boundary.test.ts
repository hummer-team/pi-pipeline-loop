/**
 * 194 Phase 2 (task 4 / C4): the plugin-owned system-prompt boundary.
 *
 * Pins the lifecycle contract of `pipeline-prompt-boundary` and its injector
 * wiring:
 *  - marker pairing: injected content is wrapped exactly once; re-injection
 *    strips the previous region first, so prompts never stack or nest;
 *  - fail-closed on incomplete pairing: an unpaired BEGIN/END, a nested BEGIN, or a
 *    legacy region whose boundary cannot be confirmed against a known plugin
 *    fingerprint blocks injection instead of guessing;
 *  - inert user content: markers and plugin-styled headings inside fenced
 *    code blocks or HTML comments are never treated as plugin regions;
 *  - legacy marker-less blocks: removed ONLY when the exact plugin heading
 *    plus its field fingerprint confirms them — same-named user sections
 *    without the fingerprint survive;
 *  - inheritance: a child session whose base carries the owner's wrapped
 *    region renders its OWN stage (owner review → child update → owner R2 →
 *    child develop) with exactly one managed region and no stale directives;
 *  - shared scope: STAGE WRITE SCOPE / LOOP STATUS advertise the same exact
 *    write policy the guard enforces (scoped / readonly / blocked), on the
 *    default AND the yml rendering path alike.
 */
import { describe, it, expect, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { join } from "node:path";
import type {
  DesignReviewOperation,
  DesignReviewState,
  PipelineConfig,
  SessionMeta,
} from "../../types";
import {
  PIPELINE_RUNTIME_CONTEXT_BEGIN,
  PIPELINE_RUNTIME_CONTEXT_END,
  stripPluginPromptContent,
  wrapPluginRuntimeContext,
} from "../../core/pipeline-prompt-boundary";
import { createPromptInjector } from "../../core/prompt-injector";
import { makeTestConfig, makeTestMeta, writePromptYml } from "../helpers";
import { deriveStandaloneReceiptPath } from "../../core/design-review/update-artifact";
import { initAuditLog, getDateAuditFileName, __resetAuditDirPath } from "../../utils/auditLog";
import { resetGitignoreCache } from "../../utils/gitignore";
import { resetPromptConfigCache } from "../../core/prompt-config";
import { auditLogFileFor } from "../helpers";

// ─── Fixtures ────────────────────────────────────────────────────────────────

const PLAN_DOC = path.resolve("/proj/docs/194_Feat_plan.md");
const REPORT_R1 = path.resolve("/proj/docs/194_Feat_review-design-1.md");
const REPORT_R2 = path.resolve("/proj/docs/194_Feat_review-design-2.md");
const AUTH_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const REVIEW_OP = "11111111-1111-4111-8111-111111111111";
const UPDATE_OP = "22222222-2222-4222-8222-222222222222";
const HANDOFF_OP = "33333333-3333-4333-8333-333333333333";
const RECEIPT_DOC = deriveStandaloneReceiptPath(PLAN_DOC, 1, UPDATE_OP)!;
const HASH64 = "b".repeat(64);

function makeOp(kind: DesignReviewOperation["kind"], operationId: string): DesignReviewOperation {
  return {
    operationId,
    kind,
    stageVisitId: 1000,
    attempt: 1,
    dispatchState: "dispatched",
    createdAt: 1,
    updatedAt: 1,
  };
}

function makeDrState(operation: DesignReviewOperation, overrides: Partial<DesignReviewState> = {}): DesignReviewState {
  return {
    schemaVersion: 1,
    planDoc: PLAN_DOC,
    authorizationId: AUTH_ID,
    authorizationSource: "menu",
    round: 1,
    phase: "review_running",
    authorizedAt: 1,
    updatedAt: 1,
    operation,
    ...overrides,
  };
}

function makeDrMeta(patch: {
  currentStage: SessionMeta["currentStage"];
  operation: DesignReviewOperation;
  stateOverrides?: Partial<DesignReviewState>;
}): SessionMeta {
  return makeTestMeta({
    currentStage: patch.currentStage,
    designReview: makeDrState(patch.operation, patch.stateOverrides),
  });
}

// ─── Pure boundary function: managed marker pairing ─────────────────────────

describe("stripPluginPromptContent: managed marker blocks", () => {
  it("leaves a marker-free prompt byte-identical", () => {
    const prompt = "PI BASE\n\n# User Section\nsome user text";
    const result = stripPluginPromptContent(prompt);
    expect(result.status).toBe("clean");
    if (result.status !== "clean") return;
    expect(result.prompt).toBe(prompt);
    expect(result.removedManagedBlocks).toBe(0);
    expect(result.removedLegacySections).toBe(0);
  });

  it("wrap → strip round-trips and removes the appended separator", () => {
    const base = "PI BASE";
    const plugin = "# Pipeline Status\n- Pipeline ID: pipe-test-001";
    const combined = `${base}\n\n---\n\n${wrapPluginRuntimeContext(plugin)}`;
    const result = stripPluginPromptContent(combined);
    expect(result.status).toBe("clean");
    if (result.status !== "clean") return;
    expect(result.prompt).toBe(base);
    expect(result.removedManagedBlocks).toBe(1);
  });

  it("removes stacked managed blocks (pre-194 accumulation) in one pass", () => {
    const twoBlocks =
      "PI BASE" +
      `\n\n---\n\n${wrapPluginRuntimeContext("OLD PLUGIN RUN 1")}` +
      `\n\n---\n\n${wrapPluginRuntimeContext("OLD PLUGIN RUN 2")}`;
    const result = stripPluginPromptContent(twoBlocks);
    expect(result.status).toBe("clean");
    if (result.status !== "clean") return;
    expect(result.removedManagedBlocks).toBe(2);
    expect(result.prompt).toBe("PI BASE");
  });

  it("fails closed on an unclosed BEGIN", () => {
    const prompt = `PI BASE\n\n---\n\n${PIPELINE_RUNTIME_CONTEXT_BEGIN}\n# Pipeline Status\n- Pipeline ID: x`;
    const result = stripPluginPromptContent(prompt);
    expect(result).toEqual({ status: "ambiguous", reason: "unclosed_runtime_context_begin" });
  });

  it("fails closed on a stray END", () => {
    const prompt = `PI BASE\n${PIPELINE_RUNTIME_CONTEXT_END}\ntail`;
    const result = stripPluginPromptContent(prompt);
    expect(result).toEqual({ status: "ambiguous", reason: "stray_runtime_context_end" });
  });

  it("fails closed on a nested BEGIN", () => {
    const prompt = [
      "PI BASE",
      PIPELINE_RUNTIME_CONTEXT_BEGIN,
      "outer content",
      PIPELINE_RUNTIME_CONTEXT_BEGIN,
      PIPELINE_RUNTIME_CONTEXT_END,
    ].join("\n");
    const result = stripPluginPromptContent(prompt);
    expect(result).toEqual({ status: "ambiguous", reason: "nested_runtime_context_begin" });
  });

  it("treats markers inside a fenced code block as inert user content", () => {
    const prompt = [
      "USER DOCS",
      "```md",
      PIPELINE_RUNTIME_CONTEXT_BEGIN,
      "example content inside a fence",
      PIPELINE_RUNTIME_CONTEXT_END,
      "```",
      "TAIL",
    ].join("\n");
    const result = stripPluginPromptContent(prompt);
    expect(result.status).toBe("clean");
    if (result.status !== "clean") return;
    expect(result.prompt).toBe(prompt);
    expect(result.removedManagedBlocks).toBe(0);
  });

  it("removes a real managed block while its fenced example stays inert", () => {
    // HTML semantics pin the marker form: a full `<!-- ... -->` marker can
    // never hide inside a multi-line comment (the marker's own `-->` closes
    // it), so fences are the inert-content surface user docs use. A fenced
    // example of both markers must NOT pair with or shadow the real block.
    const prompt = [
      "USER DOCS",
      "```md",
      PIPELINE_RUNTIME_CONTEXT_BEGIN,
      "example content inside a fence",
      PIPELINE_RUNTIME_CONTEXT_END,
      "```",
      "",
      "---",
      "",
      PIPELINE_RUNTIME_CONTEXT_BEGIN,
      "REAL PLUGIN CONTENT",
      PIPELINE_RUNTIME_CONTEXT_END,
    ].join("\n");
    const result = stripPluginPromptContent(prompt);
    expect(result.status).toBe("clean");
    if (result.status !== "clean") return;
    expect(result.removedManagedBlocks).toBe(1);
    expect(result.prompt).toContain("example content inside a fence");
    expect(result.prompt).not.toContain("REAL PLUGIN CONTENT");
  });
});

// ─── Pure boundary function: marker-less legacy sections ────────────────────

describe("stripPluginPromptContent: legacy marker-less sections", () => {
  it("removes a confirmed trailing legacy plugin run (heading + fingerprint)", () => {
    const prompt = [
      "PI BASE",
      "",
      "---",
      "",
      "# Pipeline Status",
      "- Pipeline ID: pipe-legacy",
      "- Current Stage: review",
      "",
      "---",
      "",
      "# STAGE WRITE SCOPE",
      "- Write Scope: docs/",
      "- Git: read-only (add/commit/push forbidden)",
    ].join("\n");
    const result = stripPluginPromptContent(prompt);
    expect(result.status).toBe("clean");
    if (result.status !== "clean") return;
    expect(result.removedLegacySections).toBe(2);
    expect(result.prompt).toBe("PI BASE");
  });

  it("preserves a same-named user section without the plugin fingerprint", () => {
    const prompt = [
      "PI BASE",
      "",
      "# Pipeline Status",
      "This is the user's own section about their app's pipeline.",
      "Nothing here identifies the plugin.",
    ].join("\n");
    const result = stripPluginPromptContent(prompt);
    expect(result.status).toBe("clean");
    if (result.status !== "clean") return;
    expect(result.removedLegacySections).toBe(0);
    expect(result.prompt).toBe(prompt);
  });

  it("ignores plugin-styled headings inside fenced code blocks", () => {
    const prompt = [
      "USER DOCS",
      "```",
      "# Pipeline Status",
      "- Pipeline ID: example-in-fence",
      "```",
      "TAIL",
    ].join("\n");
    const result = stripPluginPromptContent(prompt);
    expect(result.status).toBe("clean");
    if (result.status !== "clean") return;
    expect(result.removedLegacySections).toBe(0);
    expect(result.prompt).toBe(prompt);
  });

  it("ignores plugin-styled headings inside HTML comments", () => {
    const prompt = [
      "USER DOCS",
      "<!--",
      "# LOOP ENGINEERING STATUS",
      "- Current Step: #3",
      "-->",
      "TAIL",
    ].join("\n");
    const result = stripPluginPromptContent(prompt);
    expect(result.status).toBe("clean");
    if (result.status !== "clean") return;
    expect(result.removedLegacySections).toBe(0);
    expect(result.prompt).toBe(prompt);
  });

  it("fails closed when an unknown section follows a confirmed legacy section", () => {
    const prompt = [
      "PI BASE",
      "# Pipeline Status",
      "- Pipeline ID: pipe-legacy",
      "# MyOwnTailSection",
      "user content that must not be silently deleted",
    ].join("\n");
    const result = stripPluginPromptContent(prompt);
    expect(result).toEqual({ status: "ambiguous", reason: "legacy_user_section_conflict" });
  });

  it("fails closed when a same-named user section sits inside the legacy run", () => {
    const prompt = [
      "PI BASE",
      "# STAGE WRITE SCOPE",
      "- Write Scope: docs/ (plugin fingerprint present)",
      "# Pipeline Status",
      "user-authored prose describing a pipeline, with no plugin fields",
    ].join("\n");
    const result = stripPluginPromptContent(prompt);
    expect(result).toEqual({ status: "ambiguous", reason: "legacy_user_section_conflict" });
  });

  it("a user sentence merely MENTIONING a plugin field does not confirm removal", () => {
    const prompt = [
      "PI BASE",
      "# Pipeline Status",
      "Docs text: lines may start with - Pipeline ID: without being injected.",
    ].join("\n");
    // The mention sits mid-sentence, so the line-anchored fingerprint fails:
    // the section is treated as the user's own and preserved.
    const result = stripPluginPromptContent(prompt);
    expect(result.status).toBe("clean");
    if (result.status !== "clean") return;
    expect(result.removedLegacySections).toBe(0);
    expect(result.prompt).toBe(prompt);
  });

  it("the design-review context fingerprint covers both operation and decision views", () => {
    const opView = [
      "PI BASE",
      "# DESIGN-REVIEW DYNAMIC CONTEXT",
      "- Operation: review",
      "- Phase: review_running",
    ].join("\n");
    const decisionView = [
      "PI BASE",
      "# DESIGN-REVIEW DYNAMIC CONTEXT",
      "- Status: frozen while this decision is pending",
      "- Decision: pending — mode: smart",
    ].join("\n");
    expect(stripPluginPromptContent(opView)).toMatchObject({ status: "clean", removedLegacySections: 1 });
    expect(stripPluginPromptContent(decisionView)).toMatchObject({ status: "clean", removedLegacySections: 1 });
  });
});

// ─── Injector integration: wrap once, strip before rendering ────────────────

function makeInjectorCtx(
  meta: SessionMeta,
  base: string,
  notifications: string[],
): { ctx: unknown } {
  return {
    ctx: {
      session: { getMeta: () => meta },
      getSystemPrompt: () => base,
      ui: { notify: (msg: string) => notifications.push(msg) },
    },
  };
}

function countMarker(prompt: string, marker: string): number {
  return prompt.split(marker).length - 1;
}

function wrappedRegion(prompt: string): string {
  const begin = prompt.indexOf(PIPELINE_RUNTIME_CONTEXT_BEGIN);
  const end = prompt.lastIndexOf(PIPELINE_RUNTIME_CONTEXT_END);
  expect(begin).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(begin);
  return prompt.slice(begin, end + PIPELINE_RUNTIME_CONTEXT_END.length);
}

describe("createPromptInjector: boundary wiring", () => {
  const cleanups: Array<() => Promise<void>> = [];
  let tmpRoot = "";
  let auditPath = "";

  function freshConfig(pipelineId?: string): PipelineConfig {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-boundary-"));
    const config = makeTestConfig({ projectRoot: tmpRoot, auditDir: ".pi/audit" });
    auditPath = auditLogFileFor(join(tmpRoot, ".pi", "audit"), pipelineId);
    cleanups.push(async () => {
      resetPromptConfigCache();
      resetGitignoreCache();
      __resetAuditDirPath();
      await fs.promises.rm(tmpRoot, { recursive: true, force: true });
    });
    return config;
  }

  afterEach(async () => {
    while (cleanups.length > 0) await cleanups.shift()!();
  });

  it("wraps the fresh plugin content exactly once and preserves the base", async () => {
    const config = freshConfig();
    await initAuditLog(config);
    const meta = makeTestMeta({ currentStage: "review" });
    const notes: string[] = [];
    const hook = createPromptInjector(config);
    const { ctx } = makeInjectorCtx(meta, "PI BASE SYSTEM PROMPT", notes);
    const result = (await hook.handler(ctx as never))!;

    expect(result.systemPrompt!.startsWith("PI BASE SYSTEM PROMPT")).toBe(true);
    expect(countMarker(result.systemPrompt!, PIPELINE_RUNTIME_CONTEXT_BEGIN)).toBe(1);
    expect(countMarker(result.systemPrompt!, PIPELINE_RUNTIME_CONTEXT_END)).toBe(1);
    expect(result.systemPrompt!.endsWith(PIPELINE_RUNTIME_CONTEXT_END)).toBe(true);
    // The plugin sections live INSIDE the managed region.
    expect(wrappedRegion(result.systemPrompt!)).toContain("# Pipeline Status");
  });

  it("re-injection over its own previous output stays nested-free (marker idempotency)", async () => {
    const config = freshConfig();
    await initAuditLog(config);
    const meta = makeTestMeta({ currentStage: "review" });
    const hook = createPromptInjector(config);

    const first = (await hook.handler(makeInjectorCtx(meta, "PI BASE", []).ctx as never))!;
    const second = (await hook.handler(makeInjectorCtx(meta, first.systemPrompt!, []).ctx as never))!;

    expect(countMarker(second.systemPrompt!, PIPELINE_RUNTIME_CONTEXT_BEGIN)).toBe(1);
    // No duplicated sections: the heading occurs exactly once.
    expect(second.systemPrompt!.split("# Pipeline Status").length - 1).toBe(1);
    expect(second.systemPrompt!.startsWith("PI BASE")).toBe(true);
  });

  it("preserves user skills blocks and memory text when stripping its own region", async () => {
    const config = freshConfig();
    await initAuditLog(config);
    const meta = makeTestMeta({ currentStage: "review" });
    const userBase = [
      "PI BASE",
      "<available_skills>",
      "<skill>fast-develop</skill>",
      "</available_skills>",
      "MEMORY: user preferences must survive injection",
    ].join("\n");
    const hook = createPromptInjector(config);
    const first = (await hook.handler(makeInjectorCtx(meta, userBase, []).ctx as never))!;
    const second = (await hook.handler(makeInjectorCtx(meta, first.systemPrompt!, []).ctx as never))!;

    expect(second.systemPrompt!).toContain("<skill>fast-develop</skill>");
    expect(second.systemPrompt!).toContain("MEMORY: user preferences must survive injection");
    expect(countMarker(second.systemPrompt!, PIPELINE_RUNTIME_CONTEXT_BEGIN)).toBe(1);
  });

  it("strips a pre-194 marker-less plugin tail from the base and re-wraps the fresh render", async () => {
    const meta = makeTestMeta({
      currentStage: "review",
      pipelineId: "pipe-new-194",
    });
    const config = freshConfig(meta.pipelineId);
    await initAuditLog(config);
    const legacyBase = [
      "PI BASE",
      "",
      "---",
      "",
      "# Pipeline Status",
      "- Pipeline ID: pipe-legacy-999",
      "- Current Stage: develop",
      "",
      "---",
      "",
      "# STAGE WRITE SCOPE",
      "- Write Scope: docs/",
    ].join("\n");
    const hook = createPromptInjector(config);
    const result = (await hook.handler(makeInjectorCtx(meta, legacyBase, []).ctx as never))!;

    // The stale identity is gone, replaced by exactly one managed region.
    expect(result.systemPrompt!).not.toContain("pipe-legacy-999");
    expect(result.systemPrompt!.split("# Pipeline Status").length - 1).toBe(1);
    expect(countMarker(result.systemPrompt!, PIPELINE_RUNTIME_CONTEXT_BEGIN)).toBe(1);
    expect(result.systemPrompt!).toContain("pipe-new-194");
    const audit = await fs.promises.readFile(auditPath, "utf-8");
    expect(audit).toContain("prompt_boundary_stripped");
    expect(audit).toContain("removed_legacy_sections=2");
  });

  it("fails closed on an unpaired BEGIN: no injection, audit warn, clean-session notice", async () => {
    const meta = makeTestMeta({ currentStage: "review" });
    const config = freshConfig(meta.pipelineId);
    await initAuditLog(config);
    const brokenBase = `PI BASE\n\n---\n\n${PIPELINE_RUNTIME_CONTEXT_BEGIN}\n# Pipeline Status\n- Pipeline ID: x`;
    const notes: string[] = [];
    const hook = createPromptInjector(config);
    const result = await hook.handler(makeInjectorCtx(meta, brokenBase, notes).ctx as never);

    expect(result).toBeUndefined();
    expect(notes.some((n) => n.includes("unclosed_runtime_context_begin"))).toBe(true);
    expect(notes.some((n) => n.includes("clean session"))).toBe(true);
    const audit = await fs.promises.readFile(auditPath, "utf-8");
    expect(audit).toContain("prompt_boundary_ambiguous");
    expect(audit).toContain("reason=unclosed_runtime_context_begin");
  });

  it("fails closed on a legacy boundary conflict without guessing a split", async () => {
    const config = freshConfig();
    await initAuditLog(config);
    const meta = makeTestMeta({ currentStage: "review" });
    const conflictingBase = [
      "PI BASE",
      "# Pipeline Status",
      "- Pipeline ID: pipe-legacy",
      "# Unrelated User Section",
      "content",
    ].join("\n");
    const notes: string[] = [];
    const hook = createPromptInjector(config);
    const result = await hook.handler(makeInjectorCtx(meta, conflictingBase, notes).ctx as never);

    expect(result).toBeUndefined();
    expect(notes.some((n) => n.includes("legacy_user_section_conflict"))).toBe(true);
  });

  it("yml template path shares the same strip-then-wrap boundary", async () => {
    const config = freshConfig();
    await initAuditLog(config);
    await writePromptYml(tmpRoot, [
      "review: |",
      "  {{pipeline_status}}",
      "  ---",
      "  {{stage_write_scope}}",
      "",
    ].join("\n"));
    const meta = makeTestMeta({ currentStage: "review" });
    const hook = createPromptInjector(config);
    const first = (await hook.handler(makeInjectorCtx(meta, "PI BASE", []).ctx as never))!;
    // Own output fed back as base (append mode): one region, template rendered.
    const second = (await hook.handler(makeInjectorCtx(meta, first.systemPrompt!, []).ctx as never))!;

    expect(countMarker(second.systemPrompt!, PIPELINE_RUNTIME_CONTEXT_BEGIN)).toBe(1);
    expect(wrappedRegion(second.systemPrompt!)).toContain("# Pipeline Status");
    expect(wrappedRegion(second.systemPrompt!)).toContain("STAGE WRITE SCOPE");
  });
});

// ─── Inheritance chain: owner review → child update → owner R2 → child develop

describe("createPromptInjector: prompt inheritance across dispatch chain", () => {
  let root = "";

  function run(meta: SessionMeta, base: string): Promise<string> {
    const config = makeTestConfig({ projectRoot: root });
    return (async () => {
      const hook = createPromptInjector(config);
      const result = (await hook.handler(makeInjectorCtx(meta, base, []).ctx as never))!;
      return result.systemPrompt!;
    })();
  }

  it("each generation replaces the inherited region with its own stage content", async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-chain-"));
    try {
      const ownerReview = makeDrMeta({
        currentStage: "review",
        operation: makeOp("review", REVIEW_OP),
        stateOverrides: { reportDoc: REPORT_R1 },
      });
      const childUpdate = makeDrMeta({
        currentStage: "plan",
        operation: {
          ...makeOp("update", UPDATE_OP),
          updateArtifact: {
            format: "standalone-v1",
            receiptDoc: RECEIPT_DOC,
            baselineSectionsHash: HASH64,
          },
        },
        stateOverrides: { phase: "update_running" },
      });
      const ownerR2 = makeDrMeta({
        currentStage: "review",
        operation: makeOp("review", REVIEW_OP),
        stateOverrides: { round: 2, reportDoc: REPORT_R2, phase: "review_running" },
      });
      const childDevelop = makeDrMeta({
        currentStage: "develop",
        operation: makeOp("develop-handoff", HANDOFF_OP),
        stateOverrides: { phase: "pass_ready" },
      });

      const p1 = await run(ownerReview, "PI BASE");
      expect(wrappedRegion(p1)).toContain("- Operation: review");
      expect(wrappedRegion(p1)).toContain(REPORT_R1);

      // Child update inherits P1 (with the owner's wrapped region).
      const p2 = await run(childUpdate, p1);
      expect(countMarker(p2, PIPELINE_RUNTIME_CONTEXT_BEGIN)).toBe(1);
      expect(p2.startsWith("PI BASE")).toBe(true);
      expect(wrappedRegion(p2)).toContain("- Operation: update");
      expect(wrappedRegion(p2)).toContain(RECEIPT_DOC);
      expect(p2).not.toContain("- Operation: review");
      expect(p2).not.toContain(REPORT_R1);

      // Owner round-2 review inherits P2.
      const p3 = await run(ownerR2, p2);
      expect(countMarker(p3, PIPELINE_RUNTIME_CONTEXT_BEGIN)).toBe(1);
      expect(wrappedRegion(p3)).toContain("- Operation: review");
      expect(wrappedRegion(p3)).toContain(REPORT_R2);
      expect(p3).not.toContain("- Operation: update");
      expect(p3).not.toContain(RECEIPT_DOC);

      // Child develop (handoff) inherits P3: stale review directives gone.
      const p4 = await run(childDevelop, p3);
      expect(countMarker(p4, PIPELINE_RUNTIME_CONTEXT_BEGIN)).toBe(1);
      expect(wrappedRegion(p4)).toContain("develop-handoff");
      expect(p4).not.toContain("- Operation: review");
      expect(p4).not.toContain(REPORT_R2);
    } finally {
      await fs.promises.rm(root, { recursive: true, force: true });
    }
  });

  it("a child keeps its own stage skill injection even though the owner injected one", async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-chain-skill-"));
    try {
      // Owner stage skill sits inside its managed region; the child base must
      // NOT let it suppress the child's own idempotent skill check.
      await fs.promises.mkdir(path.join(root, ".pi", "skills", "test-skill"), { recursive: true });
      const skillContent = `# Design Skill\n\n${"f".repeat(220)}\n`;
      await fs.promises.writeFile(path.join(root, ".pi", "skills", "test-skill", "SKILL.md"), skillContent, "utf-8");

      const owner = makeTestMeta({ currentStage: "review" });
      const p1 = await run(owner, "PI BASE");
      expect(p1).toContain("# STAGE-SPECIFIC RULES (REVIEW)");

      // Simulate the child running the SAME stage: without stripping, the
      // inherited region would make isStageSkillInBase skip re-injection.
      const p2 = await run(owner, p1);
      expect(countMarker(p2, PIPELINE_RUNTIME_CONTEXT_BEGIN)).toBe(1);
      expect(p2.split("# STAGE-SPECIFIC RULES (REVIEW)").length - 1).toBe(1);
    } finally {
      await fs.promises.rm(root, { recursive: true, force: true });
    }
  });
});

// ─── Shared write scope (guard ↔ guidance single source) ────────────────────

describe("buildStageWriteScope / loop status share the design-review write policy", () => {


  async function render(meta: SessionMeta): Promise<string> {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-scope-"));
    try {
      const config = makeTestConfig({ projectRoot: root });
      const hook = createPromptInjector(config);
      const result = (await hook.handler(makeInjectorCtx(meta, "", []).ctx as never))!;
      return result.systemPrompt!;
    } finally {
      await fs.promises.rm(root, { recursive: true, force: true });
    }
  }

  it("ordinary sessions keep the stage whitelist text (unchanged behavior)", async () => {
    const meta = makeTestMeta({ currentStage: "develop" });
    const prompt = await render(meta);
    expect(prompt).toContain("- Write Scope: all (global protect applies)");
  });

  it("a review operation advertises the EXACT report path as the stage write scope", async () => {
    const meta = makeDrMeta({
      currentStage: "review",
      operation: makeOp("review", REVIEW_OP),
      stateOverrides: { reportDoc: REPORT_R1 },
    });
    const prompt = await render(meta);
    expect(prompt).toContain("- Write Scope: EXACTLY these files (everything else is read-only):");
    expect(prompt).toContain(`- ${REPORT_R1}`);
  });

  it("a paused loop never promises a writable file in STAGE WRITE SCOPE", async () => {
    const meta = makeDrMeta({
      currentStage: "plan",
      operation: makeOp("review", REVIEW_OP),
      stateOverrides: { phase: "paused", pauseReason: "executor-failed", reportDoc: REPORT_R1 },
    });
    const prompt = await render(meta);
    expect(prompt).toContain("Write Scope: nothing — the loop is paused waiting for the owner (paused:executor-failed)");
    expect(prompt).not.toContain(`- Write Scope: EXACTLY`);
  });

  it("an unprovable identity fails closed in the shared scope text", async () => {
    const meta = makeDrMeta({
      currentStage: "review",
      operation: makeOp("review", REVIEW_OP),
      stateOverrides: { authorizationId: "", reportDoc: REPORT_R1 },
    });
    const prompt = await render(meta);
    expect(prompt).toContain(
      "Write Scope: nothing — this run's identity or output binding cannot be proven (design_review_identity_incomplete)",
    );
  });

  it("develop under an open handoff loop gets the plugin-owned scope in LOOP STATUS", async () => {
    const meta = makeDrMeta({
      currentStage: "develop",
      operation: makeOp("develop-handoff", HANDOFF_OP),
      stateOverrides: { phase: "pass_ready" },
    });
    const prompt = await render(meta);
    expect(prompt).toContain("# LOOP ENGINEERING STATUS");
    expect(prompt).toContain(
      "Write Scope: nothing — this develop-handoff operation writes no model-owned files (handoff_is_plugin_owned)",
    );
  });

  it("the yml {{stage_write_scope}} placeholder renders the same policy text", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-scope-yml-"));
    try {
      await writePromptYml(root, [
        "review: |",
        "  {{pipeline_status}}",
        "  ---",
        "  {{stage_write_scope}}",
        "",
      ].join("\n"));
      const config = makeTestConfig({ projectRoot: root });
      const hook = createPromptInjector(config);
      const meta = makeDrMeta({
        currentStage: "review",
        operation: makeOp("review", REVIEW_OP),
        stateOverrides: { reportDoc: REPORT_R1 },
      });
      const result = (await hook.handler(makeInjectorCtx(meta, "", []).ctx as never))!;
      expect(wrappedRegion(result.systemPrompt!)).toContain(`- ${REPORT_R1}`);
      expect(wrappedRegion(result.systemPrompt!)).toContain("EXACTLY these files");
    } finally {
      await fs.promises.rm(root, { recursive: true, force: true });
    }
  });
});
