import { describe, it, expect, beforeAll } from "bun:test";
import { createAgentSettled } from "../../core/agent-settled";
import { makeTestConfig, makeTestMeta, createMockCtx } from "../helpers";
import { readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initAuditLog } from "../../utils/auditLog";
import type { PipelineStage, SessionMeta } from "../../types";
import { auditLogFileFor } from "../helpers";

const TMP = join(tmpdir(), "pi-pipeline-agent-settled-turn-gates-" + Date.now());

beforeAll(async () => {
  await mkdir(TMP, { recursive: true });
  await initAuditLog(makeTestConfig({ projectRoot: TMP }));
});

// ── Phase 4 (169) P1: W1 terminal compact wiring in agent_settled ─────────────
//
// Locks the plan Phase 4验收 requirement:
// - W1: completed + no consumed flag → helper is called
// - W1: advancedThisTurn=true + completed → helper still called (locks pre-short-circuit)
// - W1: already consumed → helper is NOT called

describe("Phase 4 (169) P1: W1 terminal compact wiring", () => {
  it("W1: completed + no consumed flag → maybeCompactOnPipelineCompleted is called", async () => {
    const stageTmp = join(tmpdir(), "pi-169-w1-called-" + Date.now());
    await mkdir(stageTmp, { recursive: true });
    await initAuditLog(makeTestConfig({ projectRoot: stageTmp }));

    // No verify.require on completed → hook returns after W1 check
    const config = makeTestConfig({ projectRoot: stageTmp });
    const meta = makeTestMeta({
      currentStage: "completed",
      pipelineId: "pipe-w1-001",
      // No terminalCompact flag → helper should be called
    });

    // Track compact calls via _ctx mock
    let compactCalled = false;
    const ctx = createMockCtx(meta);
    (ctx as any)._ctx = {
      ...((ctx as any)._ctx ?? {}),
      isIdle: () => true,
      compact: () => { compactCalled = true; },
      getContextUsage: () => ({ tokens: 1000 }), // below threshold → skips, but proves call
    };

    const hook = createAgentSettled(config);
    await hook.handler(ctx as any);

    // Guard consumed the flag (below_threshold or compacted) — W1 was reached
    // The helper ran: either terminalCompact is set or compact was invoked
    const freshMeta = meta;
    // Helper was invoked: if tokens below threshold, it set skipped_below_threshold;
    // otherwise it attempted compact. Either way, the call happened.
    expect(freshMeta.terminalCompact !== undefined || compactCalled).toBe(true);

    await rm(stageTmp, { recursive: true, force: true });
  });

  it("W1: already consumed (terminalCompact set) → helper is a no-op", async () => {
    const stageTmp = join(tmpdir(), "pi-169-w1-noop-" + Date.now());
    await mkdir(stageTmp, { recursive: true });
    await initAuditLog(makeTestConfig({ projectRoot: stageTmp }));

    const config = makeTestConfig({ projectRoot: stageTmp });
    const meta = makeTestMeta({
      currentStage: "completed",
      pipelineId: "pipe-w1-consumed",
      terminalCompact: { outcome: "compacted", at: Date.now() },
    });

    let compactCalled = false;
    const ctx = createMockCtx(meta);
    (ctx as any)._ctx = {
      ...((ctx as any)._ctx ?? {}),
      isIdle: () => true,
      compact: () => { compactCalled = true; },
      getContextUsage: () => ({ tokens: 200_000 }),
    };

    const hook = createAgentSettled(config);
    await hook.handler(ctx as any);

    // Helper returned early (terminalCompact already set) — compact must NOT be called
    expect(compactCalled).toBe(false);

    await rm(stageTmp, { recursive: true, force: true });
  });

  it("W1: advancedThisTurn=true + completed → helper still called (pre-short-circuit)", async () => {
    const stageTmp = join(tmpdir(), "pi-169-w1-advturn-" + Date.now());
    await mkdir(stageTmp, { recursive: true });
    await initAuditLog(makeTestConfig({ projectRoot: stageTmp }));

    const config = makeTestConfig({ projectRoot: stageTmp });
    const meta = makeTestMeta({
      currentStage: "completed",
      pipelineId: "pipe-w1-adv",
      advancedThisTurn: true, // set by stage_advance tool
    });

    let compactCalled = false;
    const ctx = createMockCtx(meta);
    (ctx as any)._ctx = {
      ...((ctx as any)._ctx ?? {}),
      isIdle: () => true,
      compact: () => { compactCalled = true; },
      getContextUsage: () => ({ tokens: 1000 }),
    };

    const hook = createAgentSettled(config);
    await hook.handler(ctx as any);

    // W1 fires BEFORE advancedThisTurn short-circuit → helper reached
    expect(meta.terminalCompact !== undefined || compactCalled).toBe(true);

    await rm(stageTmp, { recursive: true, force: true });
  });
});

// ── Nit 3 (reaudit): agent-settled auto mode + fail report → hook-level route fix ──
//
// Plan Phase 3 acceptance explicitly requires this case: auto mode + report with
// Blocker/High → route fix (no counting), via the agent_settled hook path.
// Previously only indirectly covered (verify-integration.test.ts:865 calls
// routeReviewFailAuto directly; agent-settled.test.ts:1044 covers auto+no-report).

describe("Nit 3 (reaudit): agent-settled auto mode + fail report → route fix via hook", () => {
  it("auto mode + report with Blocker → route to fix, confirmRejections unchanged, select not called", async () => {
    const stageTmp = join(tmpdir(), "pi-nit3-auto-fail-" + Date.now());
    await mkdir(stageTmp, { recursive: true });
    await initAuditLog(makeTestConfig({ projectRoot: stageTmp }));

    // Config: review stage with auto confirm mode (default) and verify.require=false
    // (no verify so the test focuses on the review decision chain path)
    const config = makeTestConfig({
      projectRoot: stageTmp,
      stages: Object.fromEntries(
        ["clarify", "plan", "design-review", "develop", "review", "fix", "awaiting_human", "completed"].map(
          (s, i, a) => [
            s,
            {
              agentPath: "a.md",
              skillPath: "s.md",
              nextStage: (a[i + 1] ?? null) as PipelineStage | null,
              requireDomain: false,
              ...(s === "review" ? { confirm: { mode: "auto" as const } } : {}),
            },
          ],
        ),
      ) as any,
    });

    // Write review report with Blocker → parseReviewConclusion returns fail
    const reviewDir = join(stageTmp, "docs", "review");
    await mkdir(reviewDir, { recursive: true });
    await writeFile(
      join(reviewDir, "code_review_nit3.md"),
      "# Review\n\n## 问题 1\n- 等级：Blocker\n- 是否修复：待修复\n\n## 结论\n- 结论：通过\n",
      "utf-8",
    );

    const meta = makeTestMeta({ currentStage: "review", confirmRejections: 2 });
    let selectCalled = false;
    const ctx = createMockCtx(meta, {
      selectReturn: undefined,
    });
    // Override select to track calls
    const origSelect = ctx.ui.select;
    ctx.ui.select = async (msg: string, opts: string[]) => {
      selectCalled = true;
      return origSelect?.(msg, opts);
    };

    const hook = createAgentSettled(config);
    await hook.handler(ctx as any);

    // Should route to fix stage
    expect(meta.currentStage).toBe("fix");
    // confirmRejections must be unchanged (auto route does not count)
    expect(meta.confirmRejections).toBe(2);
    // select must NOT be called (auto mode routes directly)
    expect(selectCalled).toBe(false);

    // Audit: review_auto_route_fix must be present
    const logPath = auditLogFileFor(join(stageTmp, ".pi", "audit"));
    const logContent = await readFile(logPath, "utf-8");
    expect(logContent).toContain("review_auto_route_fix");
    // Must NOT have confirm_rejected (no counting)
    expect(logContent).not.toContain("confirm_rejected");

    await rm(stageTmp, { recursive: true, force: true });
  });
});

// ─── Phase 1 (170): unbound requirementDoc gate ──────────────────────────────

describe("Phase 1 (170): unbound requirementDoc gate in agent_settled", () => {
  const unboundTmp = join(tmpdir(), "pi-unbound-" + Date.now());

  it("no requirementDoc + marker pending → verify_completion_marker_unbound + throttled notify", async () => {
    const stageTmp = join(unboundTmp, "unbound-notify");
    await mkdir(stageTmp, { recursive: true });
    await initAuditLog(makeTestConfig({ projectRoot: stageTmp }));

    const config = makeTestConfig({
      projectRoot: stageTmp,
      stages: Object.fromEntries(
        ["clarify", "plan", "design-review", "develop", "review", "fix", "awaiting_human", "completed"].map(
          (s, i, a) => [
            s,
            {
              agentPath: "a.md",
              skillPath: "s.md",
              nextStage: (a[i + 1] ?? null) as PipelineStage | null,
              requireDomain: false,
              verify: s === "clarify"
                ? { require: true, verifyFile: "verify.md", completionMarker: "## 模型确认" }
                : undefined,
            },
          ],
        ),
      ) as unknown as Record<PipelineStage, import("../../types").StageConfig>,
    });

    // Meta has NO requirementDoc — the root cause condition
    const meta: SessionMeta = makeTestMeta({
      currentStage: "clarify",
      requirementDoc: undefined,
      verifyAttempts: 0,
    });
    const ctx = createMockCtx(meta);

    const hook = createAgentSettled(config);
    await hook.handler(ctx as unknown as Parameters<typeof hook.handler>[0]);

    // Audit should contain verify_completion_marker_unbound (NOT verify_completion_marker_pending)
    const logContent = await readFile(auditLogFileFor(join(stageTmp, ".pi", "audit")), "utf-8");
    expect(logContent).toContain("verify_completion_marker_unbound");
    expect(logContent).not.toContain("verify_completion_marker_pending");

    // Notify should fire once with escape-hatch guidance
    expect(ctx.notifications.some(n => n.includes("Requirement document not bound"))).toBe(true);
    // lastUnboundNotifiedAt should have been stamped
    expect(meta.lastUnboundNotifiedAt).toBeDefined();
    expect(typeof meta.lastUnboundNotifiedAt).toBe("number");

    await rm(stageTmp, { recursive: true, force: true });
  });

  it("unbound throttle: second settle within window → no additional notify", async () => {
    const stageTmp = join(unboundTmp, "unbound-throttle");
    await mkdir(stageTmp, { recursive: true });
    await initAuditLog(makeTestConfig({ projectRoot: stageTmp }));

    const config = makeTestConfig({
      projectRoot: stageTmp,
      stages: Object.fromEntries(
        ["clarify", "plan", "design-review", "develop", "review", "fix", "awaiting_human", "completed"].map(
          (s, i, a) => [
            s,
            {
              agentPath: "a.md",
              skillPath: "s.md",
              nextStage: (a[i + 1] ?? null) as PipelineStage | null,
              requireDomain: false,
              verify: s === "clarify"
                ? { require: true, verifyFile: "verify.md", completionMarker: "## 模型确认" }
                : undefined,
            },
          ],
        ),
      ) as unknown as Record<PipelineStage, import("../../types").StageConfig>,
    });

    // Pre-stamp lastUnboundNotifiedAt to simulate a recent notification
    const meta: SessionMeta = makeTestMeta({
      currentStage: "clarify",
      requirementDoc: undefined,
      lastUnboundNotifiedAt: Date.now(), // Within throttle window
    });
    const ctx = createMockCtx(meta);

    const hook = createAgentSettled(config);
    await hook.handler(ctx as unknown as Parameters<typeof hook.handler>[0]);

    // Audit should still contain the unbound event (always written)
    const logContent = await readFile(auditLogFileFor(join(stageTmp, ".pi", "audit")), "utf-8");
    expect(logContent).toContain("verify_completion_marker_unbound");

    // But no new notification should fire (throttled)
    expect(ctx.notifications.filter(n => n.includes("Requirement document not bound")).length).toBe(0);

    await rm(stageTmp, { recursive: true, force: true });
  });

  it("doc bound + marker pending → verify_completion_marker_pending (regression)", async () => {
    const stageTmp = join(unboundTmp, "bound-pending");
    await mkdir(stageTmp, { recursive: true });
    await initAuditLog(makeTestConfig({ projectRoot: stageTmp }));

    // Write requirement doc WITHOUT the marker
    await writeFile(join(stageTmp, "req.md"), "# Requirements\nNo marker yet\n", "utf-8");

    const config = makeTestConfig({
      projectRoot: stageTmp,
      stages: Object.fromEntries(
        ["clarify", "plan", "design-review", "develop", "review", "fix", "awaiting_human", "completed"].map(
          (s, i, a) => [
            s,
            {
              agentPath: "a.md",
              skillPath: "s.md",
              nextStage: (a[i + 1] ?? null) as PipelineStage | null,
              requireDomain: false,
              verify: s === "clarify"
                ? { require: true, verifyFile: "verify.md", completionMarker: "## 模型确认" }
                : undefined,
            },
          ],
        ),
      ) as unknown as Record<PipelineStage, import("../../types").StageConfig>,
    });

    // Meta HAS requirementDoc bound — marker just not written yet
    const meta: SessionMeta = makeTestMeta({
      currentStage: "clarify",
      requirementDoc: "req.md",
      verifyAttempts: 0,
    });
    const ctx = createMockCtx(meta);

    const hook = createAgentSettled(config);
    await hook.handler(ctx as unknown as Parameters<typeof hook.handler>[0]);

    // Should use the OLD event name (pending, not unbound)
    const logContent = await readFile(auditLogFileFor(join(stageTmp, ".pi", "audit")), "utf-8");
    expect(logContent).toContain("verify_completion_marker_pending");
    expect(logContent).not.toContain("verify_completion_marker_unbound");

    // No notification for the bound-but-pending case
    expect(ctx.notifications.filter(n => n.includes("Requirement document not bound")).length).toBe(0);

    await rm(stageTmp, { recursive: true, force: true });
  });

  // ─── Phase 3 (170): aborted/blocked notify text branches ──

  it("Phase 2b (173) C3: aborted flowState → dormant, no notify (silent short-circuit)", async () => {
    const stageTmp = join(tmpdir(), "pi-as-aborted-msg-" + Date.now());
    await mkdir(stageTmp, { recursive: true });
    await initAuditLog(makeTestConfig({ projectRoot: stageTmp }));

    const config = makeTestConfig({ projectRoot: stageTmp });
    const meta = makeTestMeta({
      currentStage: "develop",
      flowState: "aborted",
      requirementDoc: "docs/design/82_Feat.md",
    });
    const ctx = createMockCtx(meta);

    const hook = createAgentSettled(config);
    await hook.handler(ctx as any);

    // Phase 2b (173) C3: aborted = dormant → silent short-circuit, no notify
    const abortedNotify = ctx.notifications.find(n => n.includes("Pipeline aborted"));
    expect(abortedNotify).toBeUndefined();

    await rm(stageTmp, { recursive: true, force: true });
  });

  it("blocked flowState → notify contains 'Pipeline frozen' with decision menu hint", async () => {
    const stageTmp = join(tmpdir(), "pi-as-blocked-msg-" + Date.now());
    await mkdir(stageTmp, { recursive: true });
    await initAuditLog(makeTestConfig({ projectRoot: stageTmp }));

    const config = makeTestConfig({ projectRoot: stageTmp });
    const meta = makeTestMeta({
      currentStage: "develop",
      flowState: "blocked",
      blockedReason: "loop_overflow",
    });
    const ctx = createMockCtx(meta);

    const hook = createAgentSettled(config);
    await hook.handler(ctx as any);

    // Blocked branch: should notify with frozen reason and decision menu hint
    const frozenNotify = ctx.notifications.find(n => n.includes("Pipeline frozen"));
    expect(frozenNotify).toBeDefined();
    expect(frozenNotify).toContain("decision menu");

    await rm(stageTmp, { recursive: true, force: true });
  });
});

// ── Phase 2 (172): pipeline-turn source gate ──────────────────────────────────

describe("Phase 2 (172): pipeline-turn source gate", () => {
  it("non-pipeline chat message → agent_settled_non_pipeline_turn audit, no verify", async () => {
    const config = makeTestConfig();
    await mkdir(join(config.projectRoot, config.auditDir!), { recursive: true });
    await initAuditLog(config);
    const meta = makeTestMeta({ currentStage: "develop", verifyAttempts: 0 });
    const ctx = createMockCtx(meta);
    // Set the last user message to a pure chat message (no pipeline signature)
    (ctx._ctx.sessionManager as any).getBranch = () => [
      { type: "message", message: { role: "user", content: "What is the weather today?" } },
    ];

    const hook = createAgentSettled(config);
    await hook.handler(ctx as any);

    // Should audit non-pipeline turn
    const auditPath = auditLogFileFor(join(config.projectRoot, config.auditDir!));
    const auditContent = await readFile(auditPath, "utf-8");
    expect(auditContent).toContain("agent_settled_non_pipeline_turn");
    // verifyAttempts must NOT have been incremented
    expect(meta.verifyAttempts).toBe(0);
  });

  it("pipeline wake prefix → verification proceeds", async () => {
    const config = makeTestConfig();
    await mkdir(join(config.projectRoot, config.auditDir!), { recursive: true });
    await initAuditLog(config);
    const meta = makeTestMeta({ currentStage: "develop" });
    const ctx = createMockCtx(meta);
    (ctx._ctx.sessionManager as any).getBranch = () => [
      { type: "message", message: { role: "user", content: 'Verification failed for "develop": build error.' } },
    ];

    const hook = createAgentSettled(config);
    await hook.handler(ctx as any);

    // Should NOT audit non-pipeline turn (verification proceeds)
    const auditPath = auditLogFileFor(join(config.projectRoot, config.auditDir!));
    const auditContent = await readFile(auditPath, "utf-8");
    expect(auditContent).not.toContain("agent_settled_non_pipeline_turn");
  });

  it("@mention with round args → verification proceeds", async () => {
    const config = makeTestConfig();
    await mkdir(join(config.projectRoot, config.auditDir!), { recursive: true });
    await initAuditLog(config);
    const meta = makeTestMeta({ currentStage: "clarify" });
    const ctx = createMockCtx(meta);
    (ctx._ctx.sessionManager as any).getBranch = () => [
      { type: "message", message: { role: "user", content: "@feat-design-plan-agent docs/req.md 2 答" } },
    ];

    const hook = createAgentSettled(config);
    await hook.handler(ctx as any);

    const auditPath = auditLogFileFor(join(config.projectRoot, config.auditDir!));
    const auditContent = await readFile(auditPath, "utf-8");
    expect(auditContent).not.toContain("agent_settled_non_pipeline_turn");
  });

  it("empty user messages → fail-open (treated as pipeline turn)", async () => {
    const config = makeTestConfig();
    await mkdir(join(config.projectRoot, config.auditDir!), { recursive: true });
    await initAuditLog(config);
    const meta = makeTestMeta({ currentStage: "develop" });
    const ctx = createMockCtx(meta);
    // No user messages in the branch
    (ctx._ctx.sessionManager as any).getBranch = () => [];

    const hook = createAgentSettled(config);
    await hook.handler(ctx as any);

    const auditPath = auditLogFileFor(join(config.projectRoot, config.auditDir!));
    const auditContent = await readFile(auditPath, "utf-8");
    // Empty → fail-open → NOT filtered as non-pipeline
    expect(auditContent).not.toContain("agent_settled_non_pipeline_turn");
  });
});

// ── Phase 1 / 179 (G2): bare-form gate relaxation + interpolated hint ────────

const CLARIFY_VERIFY_MD = `---
rules:
  path: "{requirementDoc}"
  groups:
    - name: round-well-formed
      when: "^#{1,2}\\\\s*(?:第\\\\s*(?<roundZh>\\\\d+)\\\\s*轮澄清|[Rr]ound\\\\s+(?<roundEn>\\\\d+))"
      runtime: roundHeading
      scope: section
      ruleMode: and
      rules:
        - type: fileContentPattern
          patterns: ["^- \\\\*{0,2}(?:方案|Option|Plan)[ \\\\t]*[A-Z]"]
        - type: fileContentPattern
          mode: or
          runtime: answerField
          patterns:
            - "答\\\\s*[:：]|\\\\*{2}答\\\\*{2}"
            - "Answer\\\\s*:"
    - name: full-und-confirmed
      ruleMode: and
      rules:
        - type: fileContentPattern
          mode: or
          runtime: modelConfirm
          patterns:
            - "^##\\\\s*模型确认"
---
clarify verification
`;

/** Writes the clarify runtime-contract verify.md into the test project. */
async function writeClarifyVerifyMd(projectRoot: string): Promise<void> {
  const dir = join(projectRoot, ".pi", "references", "clarify_spec");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "verify.md"), CLARIFY_VERIFY_MD, "utf-8");
}

/** Writes the clarify agent definition so resolveAgentMention resolves a name. */
async function writeClarifyAgentFile(projectRoot: string): Promise<void> {
  const dir = join(projectRoot, "agents");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "test-agent.md"), "---\nname: feat-design-plan-agent\n---\n", "utf-8");
}

describe("Phase 1 / 179 (G2 layer ①): bare-form pipeline turn relaxation", () => {
  it("bare '<doc> 2 答' with bound requirementDoc → pipeline turn (bare_turn_matched)", async () => {
    const config = makeTestConfig();
    await mkdir(join(config.projectRoot, config.auditDir!), { recursive: true });
    await initAuditLog(config);
    const meta = makeTestMeta({ currentStage: "develop", requirementDoc: "docs/design/x.md" });
    const ctx = createMockCtx(meta);
    (ctx._ctx.sessionManager as any).getBranch = () => [
      { type: "message", message: { role: "user", content: "docs/design/x.md 2 答" } },
    ];

    await createAgentSettled(config).handler(ctx as any);

    const auditContent = await readFile(auditLogFileFor(join(config.projectRoot, config.auditDir!)), "utf-8");
    expect(auditContent).not.toContain("agent_settled_non_pipeline_turn");
    expect(auditContent).toContain("agent_settled_bare_turn_matched");
  });

  it("bare text referencing a DIFFERENT doc → still non_pipeline_turn (no false hit)", async () => {
    const config = makeTestConfig();
    await mkdir(join(config.projectRoot, config.auditDir!), { recursive: true });
    await initAuditLog(config);
    const meta = makeTestMeta({ currentStage: "develop", requirementDoc: "docs/design/x.md" });
    const ctx = createMockCtx(meta);
    (ctx._ctx.sessionManager as any).getBranch = () => [
      { type: "message", message: { role: "user", content: "docs/design/other.md 2 答" } },
    ];

    await createAgentSettled(config).handler(ctx as any);

    const auditContent = await readFile(auditLogFileFor(join(config.projectRoot, config.auditDir!)), "utf-8");
    expect(auditContent).toContain("agent_settled_non_pipeline_turn");
    expect(auditContent).not.toContain("agent_settled_bare_turn_matched");
  });

  it("unbound requirementDoc → bare text keeps current non_pipeline_turn behavior", async () => {
    const config = makeTestConfig();
    await mkdir(join(config.projectRoot, config.auditDir!), { recursive: true });
    await initAuditLog(config);
    const meta = makeTestMeta({ currentStage: "develop" });
    const ctx = createMockCtx(meta);
    (ctx._ctx.sessionManager as any).getBranch = () => [
      { type: "message", message: { role: "user", content: "docs/design/x.md 2 答" } },
    ];

    await createAgentSettled(config).handler(ctx as any);

    const auditContent = await readFile(auditLogFileFor(join(config.projectRoot, config.auditDir!)), "utf-8");
    expect(auditContent).toContain("agent_settled_non_pipeline_turn");
    expect(auditContent).not.toContain("agent_settled_bare_turn_matched");
  });
});

describe("Phase 1 / 179 (G2 layer ②): await-answer hint interpolation", () => {
  it("notify text carries real doc path + agent name and no '{file}' literal", async () => {
    const config = makeTestConfig();
    config.stages.clarify = {
      ...config.stages.clarify,
      verify: { require: true },
    } as typeof config.stages.clarify;
    await mkdir(join(config.projectRoot, config.auditDir!), { recursive: true });
    await initAuditLog(config);
    await writeClarifyVerifyMd(config.projectRoot);
    await writeClarifyAgentFile(config.projectRoot);
    await mkdir(join(config.projectRoot, "docs", "design"), { recursive: true });
    await writeFile(
      join(config.projectRoot, "docs", "design", "x.md"),
      "# 第 1 轮澄清\n## 问题 1\n- 方案 A：foo\n- 方案 B：bar\n",
      "utf-8",
    );

    const meta = makeTestMeta({ currentStage: "clarify", requirementDoc: "docs/design/x.md" });
    const ctx = createMockCtx(meta);
    (ctx._ctx.sessionManager as any).getBranch = () => [
      { type: "message", message: { role: "user", content: "@feat-design-plan-agent docs/design/x.md 1 答" } },
    ];

    await createAgentSettled(config).handler(ctx as any);

    const hint = ctx.notifications.find((n) => n.includes("awaiting your answer"));
    expect(hint).toBeDefined();
    expect(hint).toContain("docs/design/x.md");
    expect(hint).toContain("feat-design-plan-agent");
    expect(hint).not.toContain("{file}");
  });
});

// ── 211 Bug Phase 0: owner re-presentation of a child-suppressed confirm gate ─

describe("211 Phase 0: chat turn with a pending confirm gate", () => {
  /**
   * Review #2: `makeTestConfig()` defaults plan.nextStage to "design-review".
   * Override it to "develop" to mirror the incident's stage chain. The
   * helpers.ts defaults are global to 2000+ tests and must NOT be changed.
   */
  function makePlanGateConfig(root: string) {
    const base = makeTestConfig({ projectRoot: root });
    const config: typeof base = {
      ...base,
      stages: {
        ...base.stages,
        plan: {
          ...base.stages.plan,
          nextStage: "develop" as PipelineStage,
          allowedWritePaths: ["docs/"],
          confirm: { mode: "manual" as const },
        },
      },
    } as typeof base;
    return config;
  }

  async function createPlanDoc(root: string, content: string): Promise<void> {
    const docsDir = join(root, "docs", "design");
    await mkdir(docsDir, { recursive: true });
    await writeFile(join(docsDir, "77_Config_Plan.md"), content, "utf-8");
  }

  it("chat turn + pending gate → confirm_gate_owner_reprompt, no non_pipeline_turn (mutual exclusion)", async () => {
    const stageTmp = join(tmpdir(), "pi-211-chat-gate-" + Date.now());
    await mkdir(stageTmp, { recursive: true });
    await initAuditLog(makeTestConfig({ projectRoot: stageTmp }));

    const config = makePlanGateConfig(stageTmp);
    await createPlanDoc(stageTmp, "# Plan\nplan content here\n");

    const meta = makeTestMeta({
      currentStage: "plan",
      requirementDoc: "docs/design/77_Config.md",
      confirmGateDeferredAt: { stage: "plan", at: Date.now() },
    });
    let selectCalls = 0;
    const ctx = createMockCtx(meta);
    ctx.ui.select = async () => { selectCalls++; return undefined; }; // Esc → pending
    (ctx._ctx.sessionManager as any).getBranch = () => [
      { type: "message", message: { role: "user", content: "阅读理解项目SOP规范" } },
    ];

    await createAgentSettled(config).handler(ctx as any);

    const logContent = await readFile(auditLogFileFor(join(stageTmp, ".pi", "audit")), "utf-8");
    // The gate was handed over — the settle turns MUST NOT be mislabelled chat.
    expect(logContent).toContain("confirm_gate_owner_reprompt");
    expect(logContent).toContain("action=pending");
    expect(logContent).not.toContain("agent_settled_non_pipeline_turn");
    // Esc consumes one unit of the shared bounded re-ask budget (177/179).
    expect(meta.confirmGateReask?.stage).toBe("plan");
    expect(meta.confirmGateReask?.count).toBe(1);

    await rm(stageTmp, { recursive: true, force: true });
  });

  it("chat turn + reask budget exhausted → notify-only (reask_exhausted), zero ui.select", async () => {
    const stageTmp = join(tmpdir(), "pi-211-chat-exhausted-" + Date.now());
    await mkdir(stageTmp, { recursive: true });
    await initAuditLog(makeTestConfig({ projectRoot: stageTmp }));

    const config = makePlanGateConfig(stageTmp);
    await createPlanDoc(stageTmp, "# Plan\nplan content here\n");

    const meta = makeTestMeta({
      currentStage: "plan",
      requirementDoc: "docs/design/77_Config.md",
      stageStartTime: Date.now() - 1000,
      confirmGateDeferredAt: { stage: "plan", at: Date.now() - 500 },
      confirmGateReask: { stage: "plan", count: 3 },
    });
    let selectCalls = 0;
    const ctx = createMockCtx(meta);
    ctx.ui.select = async () => { selectCalls++; return "Approve & Advance"; };
    (ctx._ctx.sessionManager as any).getBranch = () => [
      { type: "message", message: { role: "user", content: "阅读理解项目SOP规范" } },
    ];

    await createAgentSettled(config).handler(ctx as any);

    // Notify with the standing pending-gate copy; no popup (dialog-storm guard).
    expect(ctx.notifications.some((n) => n.includes("awaits human confirmation"))).toBe(true);
    expect(selectCalls).toBe(0);
    expect(meta.currentStage).toBe("plan");

    const logContent = await readFile(auditLogFileFor(join(stageTmp, ".pi", "audit")), "utf-8");
    expect(logContent).toContain("reason=reask_exhausted");
    expect(logContent).not.toContain("agent_settled_non_pipeline_turn");

    await rm(stageTmp, { recursive: true, force: true });
  });
});
