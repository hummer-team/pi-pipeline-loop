/**
 * 193 Phase 1 (Unit Tests Core #1): configured SMART plan-revision decision
 * prompt — strict selection, rendering, dispatch integration and system-prompt
 * coherence.
 *
 * Covers the acceptance points of Phase 1:
 * - ONLY a missing file/key falls back to the constants default; explicit
 *   empty / non-string / read / parse / shape / unknown-token problems BLOCK
 *   the real review dispatch and NEVER degrade to auto behaviour;
 * - the selection source (yaml/default + content hash) is auditable;
 * - the token set is the review identity ONLY ({pipelineId} {planDoc} {round}
 *   {operationId} {inputHash} {reportDoc}) — the update prompt's issues
 *   validation is not inherited;
 * - custom piWorkDir is honored with NO cross-cache leakage, and an explicit
 *   recovery reload re-reads a fixed file without globally clearing caches;
 * - guidance is appended to the EXACT review prompt (first round AND the
 *   next-round review rendered from the CANDIDATE identity), never to update
 *   or develop-handoff dispatches;
 * - the injected design-review stage prompt renders the SAME protocol text,
 *   appending it exactly once when a custom stage template lacks the
 *   {{design_review_smart_guidance}} placeholder.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { PipelineConfig, SessionMeta } from "../../types";
import {
  DESIGN_REVIEW_SMART_DECISION_PROMPT_KEY,
  DesignReviewSmartPromptError,
  SMART_PROMPT_RUNTIME_TOKENS,
  selectDesignReviewSmartTemplate,
  renderDesignReviewSmartTemplateText,
  buildDesignReviewSmartPrompt,
  buildDesignReviewSmartGuidanceSection,
  type DesignReviewSmartPromptParams,
} from "../../core/design-review/smart-prompt";
import {
  invalidateStrictPromptCache,
  resetPromptConfigCache,
  strictPromptFilePath,
} from "../../core/prompt-config";
import { DEFAULT_DESIGN_REVIEW_SMART_DECISION_PROMPT } from "../../constants";
import {
  makeTestConfig,
  makeTestMeta,
  makeStrictSession,
  writePromptYml,
  writeStandaloneUpdateDeliverables,
} from "../helpers";
import {
  computeHash,
  createInitialState,
  deriveReportPath,
} from "../../core/design-review/state";
import { coordinateDesignReview, type CoordinatorContext } from "../../core/design-review/coordinator";
import { createPromptInjector } from "../../core/prompt-injector";
import { initAuditLog, getDateAuditFileName, __resetAuditDirPath } from "../../utils/auditLog";
import { auditLogFileFor } from "../helpers";

const PIPE = "pipe-test-001";
const HEADING = "## Design Review Smart Plan-Revision Decision";

function smartParams(overrides?: Partial<DesignReviewSmartPromptParams>): DesignReviewSmartPromptParams {
  return {
    pipelineId: PIPE,
    planDoc: "/abs/docs/193_Feat_plan.md",
    round: 1,
    operationId: "op-smart-1",
    inputHash: "abc123hash",
    reportDoc: "/abs/docs/review-design-1-193_Feat_plan.md",
    ...overrides,
  };
}

function writeYml(projectRoot: string, workDir: string, body: string): void {
  const refs = path.join(projectRoot, workDir, "references");
  fs.mkdirSync(refs, { recursive: true });
  fs.writeFileSync(path.join(refs, "pipeline-stage-prompt.yml"), body, "utf-8");
}

beforeEach(() => {
  resetPromptConfigCache();
});

afterEach(() => {
  resetPromptConfigCache();
  __resetAuditDirPath();
});

describe("193 Phase 1: smart decision template selection (strict source)", () => {
  let projectRoot: string;
  let config: PipelineConfig;

  beforeEach(() => {
    projectRoot = fs.mkdtempSync(path.join(tmpdir(), "dr-smart-sel-"));
    config = makeTestConfig({ projectRoot });
  });

  afterEach(() => {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  it("missing file → constants default with auditable source", async () => {
    const sel = await selectDesignReviewSmartTemplate(config);
    expect(sel.source).toBe("default");
    expect(sel.path).toBeUndefined();
    expect(sel.key).toBe(DESIGN_REVIEW_SMART_DECISION_PROMPT_KEY);
    expect(sel.templateText).toBe(DEFAULT_DESIGN_REVIEW_SMART_DECISION_PROMPT);
    expect(sel.contentHash).toBe(computeHash(DEFAULT_DESIGN_REVIEW_SMART_DECISION_PROMPT));
  });

  it("file present WITHOUT the key → constants default", async () => {
    writeYml(projectRoot, ".pi", "design_review_update_prompt: |\n  some update text\n");
    const sel = await selectDesignReviewSmartTemplate(config);
    expect(sel.source).toBe("default");
  });

  it("key present → YAML source with path + content hash", async () => {
    writeYml(projectRoot, ".pi", `${DESIGN_REVIEW_SMART_DECISION_PROMPT_KEY}: |\n  custom guidance {planDoc} round {round}\n`);
    const sel = await selectDesignReviewSmartTemplate(config);
    expect(sel.source).toBe("yaml");
    expect(sel.path).toBe(strictPromptFilePath(projectRoot, ".pi"));
    expect(sel.templateText).toContain("custom guidance");
  });

  it("explicit EMPTY value blocks with empty-value (never a default swap)", async () => {
    writeYml(projectRoot, ".pi", `${DESIGN_REVIEW_SMART_DECISION_PROMPT_KEY}: ""\n`);
    const err = await selectDesignReviewSmartTemplate(config).catch((e) => e);
    expect(err).toBeInstanceOf(DesignReviewSmartPromptError);
    expect((err as DesignReviewSmartPromptError).code).toBe("empty-value");
    expect((err as Error).message).toContain(DESIGN_REVIEW_SMART_DECISION_PROMPT_KEY);
    expect((err as DesignReviewSmartPromptError).filePath).toBe(strictPromptFilePath(projectRoot, ".pi"));
  });

  it("non-string value blocks with non-string", async () => {
    writeYml(projectRoot, ".pi", `${DESIGN_REVIEW_SMART_DECISION_PROMPT_KEY}: 123\n`);
    const err = await selectDesignReviewSmartTemplate(config).catch((e) => e);
    expect((err as DesignReviewSmartPromptError).code).toBe("non-string");
  });

  it("broken YAML blocks with parse-error (message carries the file)", async () => {
    writeYml(projectRoot, ".pi", `${DESIGN_REVIEW_SMART_DECISION_PROMPT_KEY}: "unclosed\n`);
    const err = await selectDesignReviewSmartTemplate(config).catch((e) => e);
    expect((err as DesignReviewSmartPromptError).code).toBe("parse-error");
    expect((err as Error).message).toContain("pipeline-stage-prompt.yml");
  });

  it("non-mapping top level blocks with shape-error", async () => {
    writeYml(projectRoot, ".pi", "- just\n- a\n- list\n");
    const err = await selectDesignReviewSmartTemplate(config).catch((e) => e);
    expect((err as DesignReviewSmartPromptError).code).toBe("shape-error");
  });

  it("unreadable file blocks with read-error", async () => {
    const filePath = strictPromptFilePath(projectRoot, ".pi");
    fs.mkdirSync(filePath, { recursive: true }); // EISDIR on read
    const err = await selectDesignReviewSmartTemplate(config).catch((e) => e);
    expect((err as DesignReviewSmartPromptError).code).toBe("read-error");
  });
});

describe("193 Phase 1: smart template rendering (identity tokens ONLY)", () => {
  it("renders all six identity tokens with no leftovers", () => {
    const text = renderDesignReviewSmartTemplateText(DEFAULT_DESIGN_REVIEW_SMART_DECISION_PROMPT, smartParams());
    expect(text).toContain(PIPE);
    expect(text).toContain("/abs/docs/193_Feat_plan.md");
    expect(text).toContain("op-smart-1");
    expect(text).toContain("abc123hash");
    expect(text).toContain("review-design-1-193_Feat_plan.md");
    expect(text).not.toMatch(/\{\{?\s*(pipelineId|planDoc|round|operationId|inputHash|reportDoc)\s*\}?\}/);
  });

  it("supports {x} and {{x}} forms identically", () => {
    const text = renderDesignReviewSmartTemplateText(
      "single {operationId} double {{operationId}}",
      smartParams(),
    );
    expect(text).toBe("single op-smart-1 double op-smart-1");
  });

  it("does NOT inherit the update token set: {issues} blocks as unknown-token", () => {
    const err = (() => {
      try {
        renderDesignReviewSmartTemplateText("issues: {issues}", smartParams());
        return null;
      } catch (e) {
        return e as DesignReviewSmartPromptError;
      }
    })();
    expect(err).toBeInstanceOf(DesignReviewSmartPromptError);
    expect(err!.code).toBe("unknown-token");
    expect(err!.message).toMatch(/unknown runtime tokens: issues/);
  });

  it("blocks a referenced token whose value is missing (missing-param)", () => {
    try {
      renderDesignReviewSmartTemplateText("report at {reportDoc}", smartParams({ reportDoc: "" }));
      throw new Error("should have blocked");
    } catch (e) {
      expect((e as DesignReviewSmartPromptError).code).toBe("missing-param");
      expect((e as Error).message).toMatch(/Missing required parameters for smart decision prompt: reportDoc/);
    }
  });

  it("core params are required: round 0 blocks", () => {
    try {
      renderDesignReviewSmartTemplateText(DEFAULT_DESIGN_REVIEW_SMART_DECISION_PROMPT, smartParams({ round: 0 }));
      throw new Error("should have blocked");
    } catch (e) {
      expect((e as DesignReviewSmartPromptError).message).toMatch(/Missing required parameters for smart decision prompt: round/);
    }
  });

  it("substituted values are never re-scanned and $-sequences survive", () => {
    const text = renderDesignReviewSmartTemplateText(
      "plan {planDoc} then {operationId}",
      smartParams({ planDoc: '/tmp/a$&b{"op": 1}.md', operationId: "op$1$$" }),
    );
    // `$&` / `$1` semantics must NOT apply (function replacer) and the JSON
    // literal braces inside the VALUE pass through untouched (non-identifier
    // brace content is never treated as a token).
    expect(text).toBe('plan /tmp/a$&b{"op": 1}.md then op$1$$');
  });

  it("non-identifier brace content (JSON literals) is untouched", () => {
    const text = renderDesignReviewSmartTemplateText('literal {"a": 1} stays; {round} renders', smartParams());
    expect(text).toBe('literal {"a": 1} stays; 1 renders');
  });

  it("exposes ONLY the six identity tokens", () => {
    expect([...SMART_PROMPT_RUNTIME_TOKENS].sort()).toEqual(
      ["inputHash", "operationId", "pipelineId", "planDoc", "reportDoc", "round"],
    );
  });
});

describe("193 Phase 1: workDir isolation and explicit recovery reload", () => {
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = fs.mkdtempSync(path.join(tmpdir(), "dr-smart-cache-"));
  });

  afterEach(() => {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  it("custom piWorkDir is honored and two workDirs never cross-cache", async () => {
    writeYml(projectRoot, "custom-assets", `${DESIGN_REVIEW_SMART_DECISION_PROMPT_KEY}: |\n  GUIDANCE FROM CUSTOM DIR {round}\n`);
    writeYml(projectRoot, ".pi", `${DESIGN_REVIEW_SMART_DECISION_PROMPT_KEY}: |\n  GUIDANCE FROM DOT PI {round}\n`);

    const customCfg = makeTestConfig({ projectRoot, piWorkDir: "custom-assets" });
    const selCustom = await selectDesignReviewSmartTemplate(customCfg);
    expect(selCustom.templateText).toContain("FROM CUSTOM DIR");

    const dotCfg = makeTestConfig({ projectRoot });
    const selDot = await selectDesignReviewSmartTemplate(dotCfg);
    expect(selDot.templateText).toContain("FROM DOT PI");
    expect(selDot.path).toBe(strictPromptFilePath(projectRoot, ".pi"));
  });

  it("broken config keeps blocking until an explicit reload re-reads the FIXED file", async () => {
    const config = makeTestConfig({ projectRoot });
    const yml = path.join(projectRoot, ".pi", "references", "pipeline-stage-prompt.yml");
    fs.mkdirSync(path.dirname(yml), { recursive: true });
    fs.writeFileSync(yml, `${DESIGN_REVIEW_SMART_DECISION_PROMPT_KEY}: "unclosed\n`, "utf-8");

    // First attempt blocks (and the parse error is cached by actual path)
    await expect(selectDesignReviewSmartTemplate(config)).rejects.toBeInstanceOf(DesignReviewSmartPromptError);
    // Without reload the cached error still blocks — dispatch stays closed
    await expect(selectDesignReviewSmartTemplate(config)).rejects.toMatchObject({ code: "parse-error" });
    // Fix the file; a plain read is still the cached error...
    fs.writeFileSync(yml, `${DESIGN_REVIEW_SMART_DECISION_PROMPT_KEY}: |\n  FIXED GUIDANCE {round}\n`, "utf-8");
    await expect(selectDesignReviewSmartTemplate(config)).rejects.toBeInstanceOf(DesignReviewSmartPromptError);
    // ...while the explicit recovery reload re-reads and succeeds
    const sel = await selectDesignReviewSmartTemplate(config, { reloadFile: true });
    expect(sel.source).toBe("yaml");
    expect(sel.templateText).toContain("FIXED GUIDANCE");
  });

  it("invalidation targets ONE path without globally clearing others", async () => {
    writeYml(projectRoot, "assets-a", `${DESIGN_REVIEW_SMART_DECISION_PROMPT_KEY}: "unclosed\n`);
    writeYml(projectRoot, "assets-b", `${DESIGN_REVIEW_SMART_DECISION_PROMPT_KEY}: "unclosed\n`);
    const cfgA = makeTestConfig({ projectRoot, piWorkDir: "assets-a" });
    const cfgB = makeTestConfig({ projectRoot, piWorkDir: "assets-b" });
    await expect(selectDesignReviewSmartTemplate(cfgA)).rejects.toBeInstanceOf(DesignReviewSmartPromptError);
    await expect(selectDesignReviewSmartTemplate(cfgB)).rejects.toBeInstanceOf(DesignReviewSmartPromptError);

    // Fix BOTH files; invalidate ONLY A's path
    writeYml(projectRoot, "assets-a", `${DESIGN_REVIEW_SMART_DECISION_PROMPT_KEY}: |\n  A OK\n`);
    writeYml(projectRoot, "assets-b", `${DESIGN_REVIEW_SMART_DECISION_PROMPT_KEY}: |\n  B OK\n`);
    invalidateStrictPromptCache(strictPromptFilePath(projectRoot, "assets-a"));

    const selA = await selectDesignReviewSmartTemplate(cfgA);
    expect(selA.templateText).toContain("A OK");
    await expect(selectDesignReviewSmartTemplate(cfgB)).rejects.toMatchObject({ code: "parse-error" });
  });

  it("buildDesignReviewSmartPrompt combines select + render (auditable selection)", async () => {
    const config = makeTestConfig({ projectRoot });
    const built = await buildDesignReviewSmartPrompt(config, smartParams());
    expect(built.selection.source).toBe("default");
    expect(built.guidance).toContain(HEADING);
    expect(built.guidance).toContain("op-smart-1");
  });
});

describe("193 Phase 1: review dispatch integration (exact prompt, blocking, recovery)", () => {
  let projectRoot: string;
  let planDoc: string;
  let config: PipelineConfig;

  function baseConfig(): PipelineConfig {
    const cfg = makeTestConfig({ projectRoot });
    cfg.stages["develop"] = { ...cfg.stages["develop"], agentPath: "agents/dev.md", skillPath: "dev/SKILL.md" };
    return cfg;
  }

  function makeCtx(
    meta: SessionMeta,
    spawnLog: Array<{ stage: string; prompt?: string }>,
  ): { ctx: CoordinatorContext; session: ReturnType<typeof makeStrictSession> } {
    const session = makeStrictSession(meta);
    const ctx: CoordinatorContext = {
      config,
      session,
      ui: { notify: () => {} },
      pi: { sendUserMessage: () => {} },
      spawnOverride: async (_cfg, stage, _m, extraArgs) => {
        spawnLog.push({ stage, ...(extraArgs !== undefined ? { prompt: extraArgs } : {}) });
        return {
          spawned: true,
          fallback: false,
          deferred: false,
          agentId: `agent-${stage}-${spawnLog.length}`,
          dispatchOutcome: "spawned_id" as const,
        };
      },
    };
    return { ctx, session };
  }

  function freshMeta(): SessionMeta {
    const planHash = computeHash(fs.readFileSync(planDoc, "utf-8"));
    return makeTestMeta({
      currentStage: "design-review",
      designReview: createInitialState(planDoc, "menu", planHash, undefined, { pipelineId: PIPE }),
    });
  }

  beforeEach(() => {
    projectRoot = fs.mkdtempSync(path.join(tmpdir(), "dr-smart-disp-"));
    fs.mkdirSync(path.join(projectRoot, "docs"), { recursive: true });
    planDoc = path.join(projectRoot, "docs", "193_Feat_plan.md");
    fs.writeFileSync(planDoc, "# Plan\n\nOriginal content.\n", "utf-8");
    config = baseConfig();
    config.stages["design-review"] = { ...config.stages["design-review"], confirm: { mode: "smart" } };
  });

  afterEach(() => {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  async function readAudit(): Promise<string> {
    const file = auditLogFileFor(join(projectRoot, ".pi", "audit"));
    try {
      return await fs.promises.readFile(file, "utf-8");
    } catch {
      return "";
    }
  }

  it("smart review dispatch: guidance in the exact prompt + pinned mode + audited source", async () => {
    await initAuditLog(config);
    const spawnLog: Array<{ stage: string; prompt?: string }> = [];
    const meta = freshMeta();
    const { ctx, session } = makeCtx(meta, spawnLog);

    const r = await coordinateDesignReview(ctx, session.getMeta()!, "advance");
    expect(r.status === "handled" && r.action === "routed").toBe(true);
    const st = session.getMeta()!.designReview!;
    expect(st.operation?.reviewConfirmMode).toBe("smart");

    expect(spawnLog.length).toBe(1);
    const prompt = spawnLog[0].prompt!;
    expect(prompt).toContain(HEADING);
    // Candidate identity is bound into the guidance
    expect(prompt).toContain(st.operation!.operationId);
    expect(prompt).toContain(st.operation!.inputHash!);
    expect(prompt).toContain(deriveReportPath(planDoc, 1));

    const audit = await readAudit();
    expect(audit).toContain("action=smart_prompt_source");
    expect(audit).toContain("source=default");
    expect(audit).toContain(DESIGN_REVIEW_SMART_DECISION_PROMPT_KEY);
  });

  it("YAML custom guidance replaces the default and is audited with its path", async () => {
    await initAuditLog(config);
    writeYml(projectRoot, ".pi", `${DESIGN_REVIEW_SMART_DECISION_PROMPT_KEY}: |\n  SMART CUSTOM PROTOCOL for {pipelineId} operation {operationId}\n`);
    const spawnLog: Array<{ stage: string; prompt?: string }> = [];
    const { ctx, session } = makeCtx(freshMeta(), spawnLog);
    await coordinateDesignReview(ctx, session.getMeta()!, "advance");

    const prompt = spawnLog[0].prompt!;
    expect(prompt).toContain("SMART CUSTOM PROTOCOL");
    expect(prompt).not.toContain(HEADING); // default heading not used anymore
    const audit = await readAudit();
    expect(audit).toContain("action=smart_prompt_source");
    expect(audit).toContain("source=yaml");
    expect(audit).toContain(`path=${strictPromptFilePath(projectRoot, ".pi")}`);
  });

  it("BROKEN smart config blocks the real dispatch: zero RPC, recoverable state, no consumed visit", async () => {
    await initAuditLog(config);
    writeYml(projectRoot, ".pi", `${DESIGN_REVIEW_SMART_DECISION_PROMPT_KEY}: ""\n`);
    const spawnLog: Array<{ stage: string; prompt?: string }> = [];
    const meta = freshMeta();
    const startVisit = meta.stageStartTime;
    const { ctx, session } = makeCtx(meta, spawnLog);

    const r = await coordinateDesignReview(ctx, session.getMeta()!, "advance");
    expect(r.status === "handled" && r.action === "pending" && r.reason === "smart_decision_config_invalid").toBe(true);
    expect(spawnLog.length).toBe(0); // BLOCKED — never a silent degrade to auto
    const st = session.getMeta()!.designReview!;
    expect(st.phase).toBe("review_ready"); // unchanged, recoverable
    expect(st.operation).toBeUndefined();
    expect(session.getMeta()!.stageStartTime).toBe(startVisit);

    const audit = await readAudit();
    expect(audit).toContain("action=smart_prompt_blocked");
    expect(audit).toContain("code=empty-value");

    // Fix the config → the NEXT attempt re-reads (reload) and dispatches
    writeYml(projectRoot, ".pi", `${DESIGN_REVIEW_SMART_DECISION_PROMPT_KEY}: |\n  FIXED SMART PROTOCOL operation {operationId}\n`);
    const r2 = await coordinateDesignReview(ctx, session.getMeta()!, "advance");
    expect(r2.status === "handled" && r2.action === "routed").toBe(true);
    expect(spawnLog.length).toBe(1);
    expect(spawnLog[0].prompt).toContain("FIXED SMART PROTOCOL");
  });

  it("unknown token in the custom template blocks with unknown-token code", async () => {
    await initAuditLog(config);
    writeYml(projectRoot, ".pi", `${DESIGN_REVIEW_SMART_DECISION_PROMPT_KEY}: |\n  leak {issues} not allowed for smart\n`);
    const spawnLog: Array<{ stage: string; prompt?: string }> = [];
    const { ctx, session } = makeCtx(freshMeta(), spawnLog);
    const r = await coordinateDesignReview(ctx, session.getMeta()!, "advance");
    expect(r.status === "handled" && r.action === "pending" && r.reason === "smart_decision_config_invalid").toBe(true);
    expect(spawnLog.length).toBe(0);
    expect(await readAudit()).toContain("code=unknown-token");
  });

  it("auto and manual modes never consult the smart prompt config", async () => {
    writeYml(projectRoot, ".pi", `${DESIGN_REVIEW_SMART_DECISION_PROMPT_KEY}: ""\n`); // broken for smart only
    for (const mode of ["auto", "manual"] as const) {
      config.stages["design-review"] = { ...config.stages["design-review"], confirm: { mode } };
      const spawnLog: Array<{ stage: string; prompt?: string }> = [];
      const { ctx, session } = makeCtx(freshMeta(), spawnLog);
      const r = await coordinateDesignReview(ctx, session.getMeta()!, "advance");
      expect(r.status === "handled" && r.action === "routed").toBe(true);
      expect(spawnLog.length).toBe(1);
      expect(spawnLog[0].prompt).not.toContain(HEADING);
      expect(spawnLog[0].prompt).not.toContain("Plan Revision Decision");
      const st = session.getMeta()!.designReview!;
      expect(st.operation?.reviewConfirmMode).toBe(mode);
    }
  });

  it("next-round review uses the SAME prep and renders the CANDIDATE identity (round 2)", async () => {
    const spawnLog: Array<{ stage: string; prompt?: string }> = [];
    const planHash = computeHash(fs.readFileSync(planDoc, "utf-8"));
    const meta = freshMeta();
    const { ctx, session } = makeCtx(meta, spawnLog);

    // 1. review dispatch (round 1, guidance pinned smart)
    await coordinateDesignReview(ctx, session.getMeta()!, "advance");
    const reviewOpId = session.getMeta()!.designReview!.operation!.operationId;

    // 2. FAIL report WITH a revise-plan decision → routes to the update dispatch
    const reportDoc = deriveReportPath(planDoc, 1);
    fs.writeFileSync(reportDoc, [
      "# Design Review Report",
      "",
      `**pipeline**: ${PIPE}`,
      `**plan**: ${planDoc}`,
      "**round**: 1",
      `**operation**: ${reviewOpId}`,
      `**input hash**: ${planHash}`,
      "",
      "## Summary",
      "",
      "Reviewed the plan against the requirement document.",
      "",
      "## Recommendations",
      "",
      "Close every listed gap before development.",
      "",
      "## Verdict",
      "",
      "**Design Review: FAIL**",
      "",
      "## Issues",
      "1. Missing error handling",
      "2. Incomplete specification",
      "",
      "## Plan Revision Decision",
      "",
      "**action**: revise-plan",
      "**reason**: every listed gap is fixable inside the plan document.",
      "",
    ].join("\n"), "utf-8");
    const r2 = await coordinateDesignReview(ctx, session.getMeta()!, "settle");
    expect(r2.status === "handled" && r2.action === "routed").toBe(true);
    const updateOpId = session.getMeta()!.designReview!.operation!.operationId;

    // Update dispatch carries NO review decision guidance
    expect(spawnLog.length).toBe(2);
    expect(spawnLog[1].prompt).not.toContain(HEADING);

    // 3. Deliverables updated (194 Phase 1: revised plan + standalone receipt,
    //    no protocol section in the plan body) → settle → next-round review.
    writeStandaloneUpdateDeliverables({
      planDoc,
      state: session.getMeta()!.designReview!,
      pipelineId: PIPE,
    });
    const newPlanHash = computeHash(fs.readFileSync(planDoc, "utf-8"));
    const r3 = await coordinateDesignReview(ctx, session.getMeta()!, "settle");
    expect(r3.status === "handled" && r3.action === "routed").toBe(true);

    const round2 = session.getMeta()!.designReview!;
    expect(round2.round).toBe(2);
    expect(round2.operation?.reviewConfirmMode).toBe("smart");
    expect(spawnLog.length).toBe(3);

    // Round-2 guidance renders from the CANDIDATE (new op/round/hash/report),
    // never from the stale round-1 meta.
    const prompt = spawnLog[2].prompt!;
    expect(prompt).toContain(HEADING);
    expect(prompt).toContain(round2.operation!.operationId);
    expect(prompt).toContain(deriveReportPath(planDoc, 2));
    expect(prompt).toContain(newPlanHash);
    expect(prompt).not.toContain(planHash); // old baseline is gone from the guidance
  });
});

describe("193 Phase 1: system-prompt coherence (injection builder + append-once)", () => {
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = fs.mkdtempSync(path.join(tmpdir(), "dr-smart-inj-"));
    fs.mkdirSync(path.join(projectRoot, "docs"), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  function trustedReviewMeta(mode: "smart" | "auto" | undefined): SessionMeta {
    const planDoc = path.join(projectRoot, "docs", "193_Feat_plan.md");
    const dr = createInitialState(planDoc, "menu", "hash-1", undefined, { pipelineId: PIPE });
    return makeTestMeta({
      pipelineId: PIPE,
      currentStage: "design-review",
      designReview: {
        ...dr,
        phase: "review_running",
        operation: {
          operationId: "op-inj-1",
          kind: "review",
          stageVisitId: 1000,
          attempt: 1,
          dispatchState: "dispatched",
          agentId: "agent-inj",
          inputHash: "hash-1",
          round: 1,
          createdAt: 1,
          updatedAt: 1,
          ...(mode !== undefined ? { reviewConfirmMode: mode } : {}),
        },
      },
    });
  }

  it("buildDesignReviewSmartGuidanceSection renders for a smart review and gates the rest", async () => {
    const config = makeTestConfig({ projectRoot });
    // Smart review_running → guidance with the bound identity
    const g = await buildDesignReviewSmartGuidanceSection(config, trustedReviewMeta("smart"));
    expect(g).toContain(HEADING);
    expect(g).toContain("op-inj-1");
    expect(g).toContain("hash-1");

    // auto mode → null (ordinary plan/review smart-confirm untouched)
    expect(await buildDesignReviewSmartGuidanceSection(config, trustedReviewMeta("auto"))).toBeNull();
    // legacy unpinned operation on a NON-smart config → null
    expect(await buildDesignReviewSmartGuidanceSection(config, trustedReviewMeta(undefined))).toBeNull();
    // outside design-review → null
    const other = makeTestMeta({ currentStage: "develop", designReview: undefined });
    expect(await buildDesignReviewSmartGuidanceSection(config, other)).toBeNull();
  });

  it("193 round-2 fix (review issue 1): the smart protocol is suppressed during the decision-pending read-only window", async () => {
    const config = makeTestConfig({ projectRoot });
    const base = trustedReviewMeta("smart");
    const dr = base.designReview!;
    const pending: SessionMeta = {
      ...base,
      designReview: {
        ...dr,
        phase: "paused",
        pauseReason: "decision-pending",
        decision: {
          state: "pending",
          decisionId: "dec-smart-1",
          reviewIdentity: {
            pipelineId: PIPE,
            planDoc: dr.planDoc,
            authorizationId: dr.authorizationId,
            round: 1,
            operationId: "op-inj-1",
            stageVisitId: 1000,
          },
          reportDoc: dr.reportDoc ?? "/tmp/report-193.md",
          reportHash: "hash-report",
          planHash: "hash-plan",
          issues: [{ issueId: "i1", text: "a real issue" }],
          mode: "smart",
          ownerSessionFile: "owner.jsonl",
          createdAt: 1,
        },
      },
    };

    // Pending FAIL: the protocol (incl. "append EXACTLY ONE section to the
    // report") must NOT be injected — the report is frozen at the snapshot the
    // human decision binds to; only /pipeline-resume moves forward.
    expect(await buildDesignReviewSmartGuidanceSection(config, pending)).toBeNull();
    // Control: the SAME identity without the pending pause still renders.
    const control = await buildDesignReviewSmartGuidanceSection(config, base);
    expect(control).toContain(HEADING);
    expect(control).toContain("append EXACTLY ONE section");
  });

  it("injection blocks on BROKEN smart config return null (dispatch is the enforcement point)", async () => {
    writeYml(projectRoot, ".pi", `${DESIGN_REVIEW_SMART_DECISION_PROMPT_KEY}: ""\n`);
    const config = makeTestConfig({ projectRoot });
    const g = await buildDesignReviewSmartGuidanceSection(config, trustedReviewMeta("smart"));
    expect(g).toBeNull();
  });

  it("custom stage template WITHOUT the placeholder still gets the guidance appended exactly once", async () => {
    await writePromptYml(projectRoot, [
      "design-review: |",
      "  {{pipeline_status}}",
      "  ---",
      "  {{stage_write_scope}}",
      "  ---",
      "  {{design_review_context}}",
      "",
    ].join("\n"));
    const config = makeTestConfig({ projectRoot });
    const meta = trustedReviewMeta("smart");
    const hook = createPromptInjector(config);
    const result = (await hook.handler({ session: { getMeta: () => meta } } as never))!;
    const prompt = result.systemPrompt!;
    const count = prompt.split(HEADING).length - 1;
    expect(count).toBe(1);
    // The previously-unregistered context placeholder now substitutes too —
    // no literal braces may survive in the rendered stage prompt.
    expect(prompt).not.toContain("{{design_review_context}}");
    expect(prompt).not.toContain("{{design_review_smart_guidance}}");
  });

  it("custom stage template WITH the placeholder substitutes once (no double append)", async () => {
    await writePromptYml(projectRoot, [
      "design-review: |",
      "  {{pipeline_status}}",
      "  ---",
      "  {{stage_write_scope}}",
      "  ---",
      "  {{design_review_smart_guidance}}",
      "",
    ].join("\n"));
    const config = makeTestConfig({ projectRoot });
    const meta = trustedReviewMeta("smart");
    const hook = createPromptInjector(config);
    const result = (await hook.handler({ session: { getMeta: () => meta } } as never))!;
    expect(result.systemPrompt!.split(HEADING).length - 1).toBe(1);
  });

  it("non-smart review removes the paragraph entirely", async () => {
    await writePromptYml(projectRoot, [
      "design-review: |",
      "  {{pipeline_status}}",
      "  ---",
      "  {{stage_write_scope}}",
      "  ---",
      "  {{design_review_smart_guidance}}",
      "",
    ].join("\n"));
    const config = makeTestConfig({ projectRoot });
    const meta = trustedReviewMeta("auto");
    const hook = createPromptInjector(config);
    const result = (await hook.handler({ session: { getMeta: () => meta } } as never))!;
    expect(result.systemPrompt).not.toContain(HEADING);
    expect(result.systemPrompt).not.toContain("{{design_review_smart_guidance}}");
  });
});
