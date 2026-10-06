/**
 * 192 Phase 4 (task 1/2/3): unified entry pre-checks for BOTH design-review
 * entries (TUI menu + direct choose_stage gate).
 *
 * - menu choice is the authorization itself (single dispatch, no second
 *   confirm); blocked configurations (disabled/require:false mapping, asset
 *   gaps, non-develop success target, disabled develop) create NO state;
 * - direct entry: stale authorization invalidated BEFORE a new one can be
 *   created; no UI / cancel / child → no authorization;
 * - round allocation scans STRICT historical report names (never re-occupies
 *   an existing report path) and attribution fields are recorded.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { maybeHandleConfirmGate } from "../../core/stage-advancer";
import { designReviewAuthorisationGate } from "../../core/design-review/authorization";
import { validateDesignReviewStageAssets } from "../../core/design-review/entry";
import { makeTestConfig, makeTestMeta, createMockCtx } from "../helpers";
import { initAuditLog, __resetAuditDirPath } from "../../utils/auditLog";
import type { PipelineConfig, SessionMeta } from "../../types";

describe("192 Phase 4: entry pre-checks", () => {
  let projectRoot: string;
  let planRel: string;
  let planDoc: string;

  beforeEach(async () => {
    projectRoot = fs.mkdtempSync(path.join(tmpdir(), "dr-entry-"));
    fs.mkdirSync(path.join(projectRoot, "docs", "design"), { recursive: true });
    planRel = "docs/design/190_Feat_plan.md";
    planDoc = path.join(projectRoot, "docs", "design", "190_Feat_plan.md");
    fs.writeFileSync(planDoc, "# Plan\nv1\n", "utf-8");
    fs.writeFileSync(path.join(projectRoot, "docs", "design", "190_Feat.md"), "# Req\n", "utf-8");
    // Own the audit directory: full-suite runs share the module-global audit
    // path; pointing it at THIS projectRoot prevents ENOENT from a directory
    // a previous test file deleted.
    await initAuditLog(makeTestConfig({ projectRoot }));
  });

  afterEach(() => {
    __resetAuditDirPath();
    fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  function baseConfig(overrides?: Partial<PipelineConfig>): PipelineConfig {
    const config = makeTestConfig({ projectRoot });
    config.stages["plan"] = { ...config.stages["plan"], confirm: { mode: "manual" as const } };
    return { ...config, ...overrides } as PipelineConfig;
  }

  it("validateDesignReviewStageAssets: require:false maps to disabled (loader semantics)", () => {
    const config = makeTestConfig({ projectRoot });
    config.stages["design-review"] = {
      ...config.stages["design-review"],
      verify: { require: false },
    } as never;
    const res = validateDesignReviewStageAssets(config);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe("design_review_disabled");
  });

  it("menu: success target conflict (original nextStage not develop) blocks WITHOUT creating authorization", async () => {
    const config = baseConfig({
      designReviewOriginalTargets: { "design-review": "review" },
    });
    const meta = makeTestMeta({ currentStage: "plan", requirementDoc: "docs/design/190_Feat.md", pipelineId: "pipe-entry-1" });
    const ctx = createMockCtx(meta, { selectReturn: "Auto Review Plan" });
    let dispatched = 0;
    (ctx as any).spawnOverride = async () => { dispatched++; return { spawned: true, fallback: false, deferred: false, agentId: "x", dispatchOutcome: "spawned_id" as const }; };
    const ui = { notify: () => {} };

    const result = await maybeHandleConfirmGate(config, ctx as any, meta, ui as any, {
      mode: "manual", sessionFile: path.join(projectRoot, "s.json"),
    });
    expect(result.result).toBe("handled");
    const after: SessionMeta = ctx.session.getMeta();
    expect(after.designReview).toBeUndefined(); // no half-authorized loop
    expect(after.currentStage).toBe("plan");    // no stage switch
    expect(dispatched).toBe(0);
  });

  it("menu: disabled develop stage blocks (activation only accepts dispatchable develop)", async () => {
    const config = baseConfig();
    config.stages["develop"] = { ...config.stages["develop"], disabled: true } as never;
    const meta = makeTestMeta({ currentStage: "plan", requirementDoc: "docs/design/190_Feat.md", pipelineId: "pipe-entry-1" });
    const ctx = createMockCtx(meta, { selectReturn: "Auto Review Plan" });
    (ctx as any).spawnOverride = async () => ({ spawned: true, fallback: false, deferred: false, agentId: "x", dispatchOutcome: "spawned_id" as const });
    const ui = { notify: () => {} };

    await maybeHandleConfirmGate(config, ctx as any, meta, ui as any, {
      mode: "manual", sessionFile: path.join(projectRoot, "s.json"),
    });
    const after: SessionMeta = ctx.session.getMeta();
    expect(after.designReview).toBeUndefined();
    expect(after.currentStage).toBe("plan");
  });

  it("menu: valid choice authorizes ONCE with strict scanned round and immediate single dispatch", async () => {
    // historical reports occupy rounds 1 and 2 → new authorization must start at 3
    fs.writeFileSync(path.join(projectRoot, "docs", "design", "review-design-1-190_Feat_plan.md"), "old1", "utf-8");
    fs.writeFileSync(path.join(projectRoot, "docs", "design", "review-design-2-190_Feat_plan.md"), "old2", "utf-8");

    const config = baseConfig();
    const meta = makeTestMeta({ currentStage: "plan", requirementDoc: "docs/design/190_Feat.md", pipelineId: "pipe-entry-1" });
    const ctx = createMockCtx(meta, { selectReturn: "Auto Review Plan" });
    let dispatched = 0;
    (ctx as any).spawnOverride = async () => {
      dispatched++;
      return { spawned: true, fallback: false, deferred: false, agentId: `a-${dispatched}`, dispatchOutcome: "spawned_id" as const };
    };
    const ui = { notify: () => {} };

    const result = await maybeHandleConfirmGate(config, ctx as any, meta, ui as any, {
      mode: "manual", sessionFile: path.join(projectRoot, "s.json"),
    });
    expect(result.result).toBe("handled");
    const after: SessionMeta = ctx.session.getMeta();
    expect(after.currentStage).toBe("design-review");
    expect(after.designReview?.round).toBe(3); // history-scanned safe round
    expect(after.designReview?.reportDoc).toBe(path.join(projectRoot, "docs", "design", "review-design-3-190_Feat_plan.md"));
    // no report overwritten
    expect(fs.readFileSync(path.join(projectRoot, "docs", "design", "review-design-1-190_Feat_plan.md"), "utf-8")).toBe("old1");
    // choice → exactly ONE immediate dispatch via coordinator
    expect(dispatched).toBe(1);
  });

  it("direct gate: child sessions and missing TUI never authorize; valid owner records attribution", async () => {
    const config = baseConfig();
    const meta = makeTestMeta({ currentStage: "plan", requirementDoc: "docs/design/190_Feat.md", pipelineId: "pipe-entry-1" });

    // no TUI (ctx without select/confirm) → rejected before any state creation
    const noTuiCtx = { session: { getMeta: () => meta, updateMeta: () => meta } } as never;
    const r1 = await designReviewAuthorisationGate(noTuiCtx, config, meta);
    expect(r1.ok).toBe(false);
    if (!r1.ok) expect(r1.reason).toBe("tui_unavailable");

    // child session → cannot authorize even with TUI present
    const childCtx = {
      session: { getMeta: () => meta, updateMeta: () => meta },
      ui: { notify: () => {}, select: async () => undefined, confirm: async () => true },
      _ctx: { sessionManager: { getBranch: () => [], getEntries: () => [], getHeader: () => ({ parentSession: "/tmp/o.jsonl" }), getSessionName: () => "kid", getSessionFile: () => "/tmp/kid.jsonl" } },
    } as never;
    const r2 = await designReviewAuthorisationGate(childCtx, config, meta);
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.reason).toBe("child_session_cannot_authorise");
  });

  it("direct gate: authorizes with scanned safe round + attribution when confirmed", async () => {
    const config = baseConfig();
    const meta = makeTestMeta({ currentStage: "plan", requirementDoc: "docs/design/190_Feat.md", pipelineId: "pipe-entry-1" });
    let confirmed = false;
    const gateCtx = {
      session: { getMeta: () => meta, updateMeta: () => meta },
      ui: {
        notify: () => {},
        select: async () => undefined,
        confirm: async () => { confirmed = true; return true; },
      },
      _ctx: { sessionManager: { getBranch: () => [], getEntries: () => [], getSessionFile: () => "/tmp/owner.jsonl", getSessionName: () => "owner", getHeader: () => undefined } },
    } as never;
    const res = await designReviewAuthorisationGate(gateCtx, config, meta);
    expect(confirmed).toBe(true);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.state.requirementDoc).toBe(path.join(projectRoot, "docs", "design", "190_Feat.md"));
      expect(res.state.pipelineId).toBe("pipe-entry-1");
      expect(res.state.reportDoc).toContain("review-design-1-");
    }
  });
});
