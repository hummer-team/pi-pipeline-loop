import { describe, it, expect, beforeAll } from "bun:test";
import { createAgentSettled } from "../../core/agent-settled";
import { makeTestConfig, makeTestMeta, createMockCtx } from "../helpers";
import { readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initAuditLog, getDateAuditFileName } from "../../utils/auditLog";
import type { PipelineStage, SessionMeta } from "../../types";

const TMP = join(tmpdir(), "pi-pipeline-agent-settled-confirm-review-" + Date.now());

beforeAll(async () => {
  await mkdir(TMP, { recursive: true });
  await initAuditLog(makeTestConfig({ projectRoot: TMP }));
});

describe("Phase 4 (162): agent_settled confirm gate integration", () => {
  function makePlanConfigWithConfirm(root: string, mode: "auto" | "manual" | "smart") {
    const base = makeTestConfig({ projectRoot: root });
    const planStage = {
      ...base.stages.plan,
      nextStage: "develop" as PipelineStage,
      verify: { require: true },
      allowedWritePaths: ["docs/"],
      confirm: { mode },
    };
    return {
      ...base,
      stages: { ...base.stages, plan: planStage as typeof base.stages.plan },
    };
  }

  async function createPlanDoc(root: string, content: string) {
    const docsDir = join(root, "docs", "design");
    await mkdir(docsDir, { recursive: true });
    const planPath = join(docsDir, "77_Config_plan.md");
    await writeFile(planPath, content, "utf-8");
    return planPath;
  }

  async function createVerifyMd(root: string, content: string) {
    const stageDir = join(root, ".pi", "references", "plan_spec");
    await mkdir(stageDir, { recursive: true });
    const verifyPath = join(stageDir, "verify.md");
    await writeFile(verifyPath, content, "utf-8");
  }

  it("smart mode: short-circuits with confirm_smart_defer_to_tool audit", async () => {
    const stageTmp = join(tmpdir(), "pi-settled-smart-" + Date.now());
    await mkdir(stageTmp, { recursive: true });
    await initAuditLog(makeTestConfig({ projectRoot: stageTmp }));

    const config = makePlanConfigWithConfirm(stageTmp, "smart");
    const meta = makeTestMeta({ currentStage: "plan", requirementDoc: "docs/design/77_Config.md" });
    const ctx = createMockCtx(meta);

    const hook = createAgentSettled(config);
    await hook.handler(ctx as any);

    const logPath = join(stageTmp, ".pi", "audit", getDateAuditFileName());
    const content = await readFile(logPath, "utf-8");
    expect(content).toContain("confirm_smart_defer_to_tool");
    // Stage should not change
    expect(meta.currentStage).toBe("plan");

    await rm(stageTmp, { recursive: true, force: true });
  });

  it("auto mode: pre-writes bilingual marker before verify (confirm_auto_write)", async () => {
    const stageTmp = join(tmpdir(), "pi-settled-auto-" + Date.now());
    await mkdir(stageTmp, { recursive: true });
    await initAuditLog(makeTestConfig({ projectRoot: stageTmp }));

    const config = makePlanConfigWithConfirm(stageTmp, "auto");
    await createPlanDoc(stageTmp, "# Plan\nplan content here\n");
    // verify.md with requiredFiles pointing to existing plan doc → passes
    await createVerifyMd(stageTmp, `---
requiredFiles:
  - "docs/design/77_Config_plan.md"
---
Verify plan quality.`);

    const meta = makeTestMeta({
      currentStage: "plan",
      requirementDoc: "docs/design/77_Config.md",
    });
    const ctx = createMockCtx(meta);

    const hook = createAgentSettled(config);
    await hook.handler(ctx as any);

    const logPath = join(stageTmp, ".pi", "audit", getDateAuditFileName());
    const logContent = await readFile(logPath, "utf-8");
    expect(logContent).toContain("confirm_auto_write");

    // Plan doc should have bilingual marker
    const planDoc = await readFile(join(stageTmp, "docs", "design", "77_Config_plan.md"), "utf-8");
    expect(planDoc).toContain("## 用户确认：确认无误");
    expect(planDoc).toContain("## User Confirmation: Confirmed");

    await rm(stageTmp, { recursive: true, force: true });
  });

  it("manual mode: triggers confirm gate — approve advances to develop", async () => {
    const stageTmp = join(tmpdir(), "pi-settled-manual-" + Date.now());
    await mkdir(stageTmp, { recursive: true });
    await initAuditLog(makeTestConfig({ projectRoot: stageTmp }));

    const config = makePlanConfigWithConfirm(stageTmp, "manual");
    const planPath = await createPlanDoc(stageTmp, "# Plan\nplan content here\n");
    // verify.md with requiredFiles pointing to existing plan doc → passes
    const relPlanPath = "docs/design/77_Config_plan.md";
    await createVerifyMd(stageTmp, `---
requiredFiles:
  - "${relPlanPath}"
---
Verify plan.`);

    const meta = makeTestMeta({
      currentStage: "plan",
      requirementDoc: "docs/design/77_Config.md",
    });
    // select returns "Approve & Advance" to simulate user approval
    const ctx = createMockCtx(meta, { selectReturn: "Approve & Advance" });

    const hook = createAgentSettled(config);
    await hook.handler(ctx as any);

    // After approval, should advance to develop
    expect(meta.currentStage).toBe("develop");
    expect(meta.confirmRejections).toBeUndefined();

    const logPath = join(stageTmp, ".pi", "audit", getDateAuditFileName());
    const logContent = await readFile(logPath, "utf-8");
    expect(logContent).toContain("confirm_approved");

    await rm(stageTmp, { recursive: true, force: true });
  });

  it("Phase 4 / 179 (G5/G7): owner re-asks unresolved gate up to 3 times, then only hints", async () => {
    // Restore the module-level audit dir (prior tests redirect+remove it).
    await initAuditLog(makeTestConfig({ projectRoot: TMP }));
    const root = join(TMP, "d5b-" + Date.now());
    await mkdir(root, { recursive: true });

    const config = makePlanConfigWithConfirm(root, "manual");
    await createPlanDoc(root, "# Plan\nplan content here\n");
    await createVerifyMd(root, `---
requiredFiles:
  - "docs/design/77_Config_plan.md"
---
Verify plan.`);

    const meta = makeTestMeta({ currentStage: "plan", requirementDoc: "docs/design/77_Config.md" });
    let selectCalls = 0;
    const ctx = createMockCtx(meta);
    ctx.ui.select = async () => { selectCalls++; return undefined; };

    const hook = createAgentSettled(config);
    // Settles 1-3: gate presented each time, dismissed → pending + bounded re-ask count
    for (let i = 1; i <= 3; i++) {
      await hook.handler(ctx as any);
      expect(selectCalls).toBe(i);
      expect(meta.confirmGateReask).toEqual({ stage: "plan", count: i });
      expect(meta.currentStage).toBe("plan");
    }

    // 4th settle: cap reached → no popup, hint only, dismissed not counted as violation
    const notifiesBefore = ctx.notifications.length;
    await hook.handler(ctx as any);
    expect(selectCalls).toBe(3);
    expect(ctx.notifications.length).toBeGreaterThan(notifiesBefore);
    expect((meta as any).violations ?? []).toHaveLength(0);

    await rm(root, { recursive: true, force: true });
  });

  it("Phase 4 / 179 (G5/G7): re-ask count is scoped to the current stage (stage change resets)", async () => {
    await initAuditLog(makeTestConfig({ projectRoot: TMP }));
    const root = join(TMP, "d5b-scope-" + Date.now());
    await mkdir(root, { recursive: true });

    const config = makePlanConfigWithConfirm(root, "manual");
    await createPlanDoc(root, "# Plan\nplan content here\n");
    await createVerifyMd(root, `---
requiredFiles:
  - "docs/design/77_Config_plan.md"
---
Verify plan.`);

    const meta = makeTestMeta({
      currentStage: "plan",
      requirementDoc: "docs/design/77_Config.md",
      // Stale count from a DIFFERENT stage must not exhaust the gate.
      confirmGateReask: { stage: "review", count: 9 },
    });
    let selectCalls = 0;
    const ctx = createMockCtx(meta);
    ctx.ui.select = async () => { selectCalls++; return undefined; };

    await createAgentSettled(config).handler(ctx as any);

    expect(selectCalls).toBe(1);
    expect(meta.confirmGateReask).toEqual({ stage: "plan", count: 1 });

    await rm(root, { recursive: true, force: true });
  });

  it("Phase 4 / 179 fix: system deferrals do NOT consume the re-ask budget (timeout fallback stays reachable)", async () => {
    // Regression: prior to the fix, every confirm-gate deferral (subagent live)
    // returned { action: "pending" } indistinguishable from Esc dismiss, so
    // agent-settled incremented confirmGateReask on each deferral. After 3
    // deferrals, reaskExhausted became true and the handler returned early
    // WITHOUT calling maybeHandleConfirmGate — making the timeout fallback
    // ("pop anyway + hint" after spawnWaitTimeoutMs) permanently unreachable.
    const MANAGER_SYMBOL = Symbol.for("pi-subagents:manager");
    const setManagerRunning = (running: boolean): void => {
      (globalThis as Record<symbol, unknown>)[MANAGER_SYMBOL] = {
        getRecord: () => undefined,
        hasRunning: () => running,
      };
    };
    const clearManager = (): void => {
      delete (globalThis as Record<symbol, unknown>)[MANAGER_SYMBOL];
    };

    await initAuditLog(makeTestConfig({ projectRoot: TMP }));
    const root = join(TMP, "d5b-defer-reask-" + Date.now());
    await mkdir(root, { recursive: true });

    try {
      const config = makePlanConfigWithConfirm(root, "manual");
      await createPlanDoc(root, "# Plan\nplan content here\n");
      await createVerifyMd(root, `---
requiredFiles:
  - "docs/design/77_Config_plan.md"
---
Verify plan.`);

      const meta = makeTestMeta({ currentStage: "plan", requirementDoc: "docs/design/77_Config.md" });
      let selectCalls = 0;
      const ctx = createMockCtx(meta);
      ctx.ui.select = async () => { selectCalls++; return undefined; };

      // Simulate a live subagent → gate defers (returns deferred:true + pending).
      setManagerRunning(true);

      const hook = createAgentSettled(config);

      // Run 5 settles — all should defer (subagent still "live"), none should
      // increment confirmGateReask. The gate must be invoked every time.
      for (let i = 1; i <= 5; i++) {
        await hook.handler(ctx as any);
        // Deferral → select is NOT called (no popup while subagent live).
        expect(selectCalls).toBe(0);
        // Re-ask must NOT be incremented by deferrals.
        expect(meta.confirmGateReask).toBeUndefined();
      }

      // Now simulate subagent settle → manager reports no running.
      // The 6th settle should present the popup (no reaskExhausted short-circuit).
      setManagerRunning(false);
      await hook.handler(ctx as any);
      expect(selectCalls).toBe(1); // Popup presented
      // Esc dismiss IS a real dismiss → re-ask count increments.
      expect(meta.confirmGateReask).toEqual({ stage: "plan", count: 1 });
    } finally {
      clearManager();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("deferContentPatterns: plan marker rule does not block verify in manual mode", async () => {
    const stageTmp = join(tmpdir(), "pi-settled-defer-" + Date.now());
    await mkdir(stageTmp, { recursive: true });
    await initAuditLog(makeTestConfig({ projectRoot: stageTmp }));

    const config = makePlanConfigWithConfirm(stageTmp, "manual");
    // Plan doc WITHOUT the confirmation marker
    await createPlanDoc(stageTmp, "# Plan\nplan content here\nno marker yet\n");
    // verify.md with a requiredFiles rule (passes) + the plan marker rule that should be deferred
    await createVerifyMd(stageTmp, `---
requiredFiles:
  - "docs/design/77_Config_plan.md"
fileContentPattern:
  - path: "docs/design/*_plan.md"
    pattern: "^## (用户确认|User Confirmation)"
---
Verify plan.`);

    const meta = makeTestMeta({
      currentStage: "plan",
      requirementDoc: "docs/design/77_Config.md",
    });
    // Select returns undefined (Esc) — pending
    const ctx = createMockCtx(meta);

    const hook = createAgentSettled(config);
    await hook.handler(ctx as any);

    const logPath = join(stageTmp, ".pi", "audit", getDateAuditFileName());
    const logContent = await readFile(logPath, "utf-8");
    // Deferral should have been applied (marker rule skipped during verify)
    expect(logContent).toContain("verify_rule_deferred");
    // Confirm gate triggered — immediate undefined select → fast collateral dismiss
    // (Phase 2 / 180 migrated this assertion from the legacy `confirm_pending action=esc_dismissed`).
    expect(logContent).toContain("confirm_gate_dismiss_interrupted");
    // Stage should not change (pending)
    expect(meta.currentStage).toBe("plan");

    await rm(stageTmp, { recursive: true, force: true });
  });

  it("Phase 1 / 181: child settle is suppressed — owner pending stamp refreshed by child, no popup", async () => {
    const stageTmp = join(tmpdir(), "pi-settled-child181-" + Date.now());
    await mkdir(stageTmp, { recursive: true });
    await initAuditLog(makeTestConfig({ projectRoot: stageTmp }));

    const config = makePlanConfigWithConfirm(stageTmp, "manual");
    await createPlanDoc(stageTmp, "# Plan\nplan content here\n");
    await createVerifyMd(stageTmp, `---
requiredFiles:
  - "docs/design/77_Config_plan.md"
---
Verify plan.`);

    const originalAt = Date.now() - 1000; // Owner's original stamp (1s ago)
    const stamp = { stage: "plan" as const, at: originalAt };
    const meta = makeTestMeta({
      currentStage: "plan",
      requirementDoc: "docs/design/77_Config.md",
      stageStartTime: Date.now(),
      confirmGateDeferredAt: { ...stamp },
    });
    let selectCalls = 0;
    // Child session: parentSession header makes detectSessionRole report isChild.
    const ctx = createMockCtx(meta, {
      sessionHeader: { parentSession: "/tmp/parent.jsonl" },
      sessionFile: "/tmp/child.jsonl",
    });
    ctx.ui.select = async () => { selectCalls++; return "Approve & Advance"; };

    const beforeChildSettle = Date.now();
    await createAgentSettled(config).handler(ctx as any);

    // Child never presents the owner dialog.
    expect(selectCalls).toBe(0);
    // Fix-E: child refreshes the stamp (overwrites owner's) with a new timestamp.
    expect(meta.confirmGateDeferredAt).toBeDefined();
    expect(meta.confirmGateDeferredAt?.stage).toBe("plan");
    expect(meta.confirmGateDeferredAt!.at).toBeGreaterThanOrEqual(beforeChildSettle);
    // Stage not advanced.
    expect(meta.currentStage).toBe("plan");
    // Suppression audit written with the child session file.
    const logContent = await readFile(join(stageTmp, ".pi", "audit", getDateAuditFileName()), "utf-8");
    expect(logContent).toContain("confirm_gate_suppressed_child");
    expect(logContent).toContain("sessionFile=/tmp/child.jsonl");

    await rm(stageTmp, { recursive: true, force: true });
  });
});

// ── Phase 1 (163): review_declaration_missing audit in agent_settled ─────────

describe("Phase 1 (163): review_declaration_missing audit", () => {
  it("review settle without declaration → auto mode falls through to verify (Bug 4)", async () => {
    const stageTmp = join(tmpdir(), "pi-163-decl-missing-" + Date.now());
    await mkdir(stageTmp, { recursive: true });
    await initAuditLog(makeTestConfig({ projectRoot: stageTmp }));

    // Config: review stage with verify.require=true, hook mode
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
              verify: s === "review"
                ? { require: true, verifyFile: "references/spec/verify.md", mode: "hook" as const }
                : undefined,
            },
          ],
        ),
      ) as any,
    });

    // Create verify.md that passes (requiredFiles exists)
    const vrDir = join(stageTmp, "references", "spec");
    await mkdir(vrDir, { recursive: true });
    await writeFile(
      join(vrDir, "verify.md"),
      "---\nrules:\n  requiredFiles:\n    - \"exists.md\"\n---\nBody\n",
    );
    await writeFile(join(stageTmp, "exists.md"), "content");

    const meta = makeTestMeta({ currentStage: "review" });
    const ctx = createMockCtx(meta);

    const hook = createAgentSettled(config);
    await hook.handler(ctx as any);

    // Bug 4: No review report → null verdict → auto mode falls through to verify
    // Verify passes → auto-advance to next stage (fix, per test config)
    const lastMeta = ctx.metadataUpdates[ctx.metadataUpdates.length - 1];
    expect(lastMeta.currentStage).toBe("fix");

    await rm(stageTmp, { recursive: true, force: true });
  });

  it("review settle with advancedThisTurn=true → hook skips (no review_declaration_missing)", async () => {
    const stageTmp = join(tmpdir(), "pi-163-decl-skip-" + Date.now());
    await mkdir(stageTmp, { recursive: true });
    await initAuditLog(makeTestConfig({ projectRoot: stageTmp }));

    const config = makeTestConfig({ projectRoot: stageTmp });
    const meta = makeTestMeta({ currentStage: "review", advancedThisTurn: true });
    const ctx = createMockCtx(meta);

    const hook = createAgentSettled(config);
    await hook.handler(ctx as any);

    // Should have audit hook_skip_after_manual_advance (not review_declaration_missing)
    const logPath = join(stageTmp, ".pi", "audit", getDateAuditFileName());
    const logContent = await readFile(logPath, "utf-8");
    expect(logContent).toContain("hook_skip_after_manual_advance");
    expect(logContent).not.toContain("review_declaration_missing");

    await rm(stageTmp, { recursive: true, force: true });
  });

  // 163 fix: reviewConclusionDeclared=true suppresses false-positive review_declaration_missing
  // when the model declared reviewConclusion but stage did not advance (verify fail / gate pending).
  it("review settle with reviewConclusionDeclared=true → no review_declaration_missing audit", async () => {
    const stageTmp = join(tmpdir(), "pi-163-decl-flag-" + Date.now());
    await mkdir(stageTmp, { recursive: true });
    await initAuditLog(makeTestConfig({ projectRoot: stageTmp }));

    // Config: review stage with verify.require=true, hook mode (same as the missing-decl test)
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
              verify: s === "review"
                ? { require: true, verifyFile: "references/spec/verify.md", mode: "hook" as const }
                : undefined,
            },
          ],
        ),
      ) as any,
    });

    // Create verify.md that passes
    const vrDir = join(stageTmp, "references", "spec");
    await mkdir(vrDir, { recursive: true });
    await writeFile(
      join(vrDir, "verify.md"),
      "---\nrules:\n  requiredFiles:\n    - \"exists.md\"\n---\nBody\n",
    );
    await writeFile(join(stageTmp, "exists.md"), "content");

    // reviewConclusionDeclared=true simulates the model calling stage_advance({ reviewConclusion })
    // but the stage did not advance (e.g., verify fail or confirm gate pending).
    const meta = makeTestMeta({ currentStage: "review", reviewConclusionDeclared: true });
    const ctx = createMockCtx(meta);

    const hook = createAgentSettled(config);
    await hook.handler(ctx as any);

    // Should NOT have review_declaration_missing (declaration was made)
    const logPath = join(stageTmp, ".pi", "audit", getDateAuditFileName());
    const logContent = await readFile(logPath, "utf-8");
    expect(logContent).not.toContain("review_declaration_missing");

    // The flag should have been cleared after consumption
    const lastMeta = ctx.metadataUpdates[ctx.metadataUpdates.length - 1];
    expect(lastMeta.reviewConclusionDeclared).toBeUndefined();

    await rm(stageTmp, { recursive: true, force: true });
  });
});

// ─── Bug 4: manual mode review decision chain ───────────────────────────────

describe("Bug 4: agent-settled manual mode review decision chain", () => {
  /** Helper: build review-stage config with manual confirm mode */
  function makeReviewManualConfig(stageTmp: string) {
    return makeTestConfig({
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
              verify: s === "review"
                ? { require: true, verifyFile: "references/spec/verify.md", mode: "hook" as const }
                : undefined,
              ...(s === "review" ? { confirm: { mode: "manual" as const }, allowedWritePaths: ["docs/"] } : {}),
            },
          ],
        ),
      ) as any,
    });
  }

  async function setupVerifyAndReport(stageTmp: string, reportContent: string) {
    // verify.md that passes
    const vrDir = join(stageTmp, "references", "spec");
    await mkdir(vrDir, { recursive: true });
    await writeFile(
      join(vrDir, "verify.md"),
      "---\nrules:\n  requiredFiles:\n    - \"exists.md\"\n---\nBody\n",
    );
    await writeFile(join(stageTmp, "exists.md"), "content");

    // Write review report
    const reviewDir = join(stageTmp, "docs", "review");
    await mkdir(reviewDir, { recursive: true });
    await writeFile(join(reviewDir, "code_review_test.md"), reportContent, "utf-8");
  }

  it("manual mode: report fail → select shows Reject first → user picks Reject → confirmRejections+1 → route fix", async () => {
    const stageTmp = join(tmpdir(), "pi-manual-reject-" + Date.now());
    await mkdir(stageTmp, { recursive: true });
    await initAuditLog(makeTestConfig({ projectRoot: stageTmp }));

    const config = makeReviewManualConfig(stageTmp);
    await setupVerifyAndReport(stageTmp,
      "# Review\n### 问题 1\n- 等级：Blocker\n- 是否修复：待修复\n\n## 结论\n- 结论：通过\n");

    const meta = makeTestMeta({ currentStage: "review", confirmRejections: 0 });
    // User picks "Reject & Send to Fix" (which is first due to defaultReject=true)
    const ctx = createMockCtx(meta, { selectReturn: "Reject & Send to Fix" });

    const hook = createAgentSettled(config);
    await hook.handler(ctx as any);

    // Should route to fix stage
    expect(meta.currentStage).toBe("fix");
    // confirmRejections should be incremented to 1
    expect(meta.confirmRejections).toBe(1);

    const logPath = join(stageTmp, ".pi", "audit", getDateAuditFileName());
    const logContent = await readFile(logPath, "utf-8");
    // Should have confirm rejection audit
    expect(logContent).toContain("confirm_rejected");

    await rm(stageTmp, { recursive: true, force: true });
  });

  it("manual mode: report fail → select shows Reject first → user picks Approve → completed, confirmRejections cleared", async () => {
    const stageTmp = join(tmpdir(), "pi-manual-approve-" + Date.now());
    await mkdir(stageTmp, { recursive: true });
    await initAuditLog(makeTestConfig({ projectRoot: stageTmp }));

    const config = makeReviewManualConfig(stageTmp);
    await setupVerifyAndReport(stageTmp,
      "# Review\n### 问题 1\n- 等级：Blocker\n- 是否修复：待修复\n\n## 结论\n- 结论：通过\n");

    const meta = makeTestMeta({ currentStage: "review", confirmRejections: 0 });
    // User picks "Approve & Complete" (despite Reject being first)
    const ctx = createMockCtx(meta, { selectReturn: "Approve & Complete" });

    const hook = createAgentSettled(config);
    await hook.handler(ctx as any);

    // Should advance to completed
    expect(meta.currentStage).toBe("completed");
    // confirmRejections should be cleared (approve resets counter)
    expect(meta.confirmRejections).toBeUndefined();

    const logPath = join(stageTmp, ".pi", "audit", getDateAuditFileName());
    const logContent = await readFile(logPath, "utf-8");
    expect(logContent).toContain("confirm_approved");

    await rm(stageTmp, { recursive: true, force: true });
  });
});
