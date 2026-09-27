import { describe, it, expect, beforeAll } from "bun:test";
import { createAgentSettled } from "../../core/agent-settled";
import { makeTestConfig, makeTestMeta, createMockCtx } from "../helpers";
import { readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initAuditLog, getDateAuditFileName } from "../../utils/auditLog";
import type { PipelineStage, SessionMeta } from "../../types";

const TMP = join(tmpdir(), "pi-pipeline-agent-settled-verify-gate-" + Date.now());

beforeAll(async () => {
  await mkdir(TMP, { recursive: true });
  await initAuditLog(makeTestConfig({ projectRoot: TMP }));
});

describe("Phase 3 (140): completionMarker precheck in agent_settled", () => {
  const markerTmp = join(tmpdir(), "pi-marker-settled-" + Date.now());

  it("completionMarker not on disk → skips verification, no verifyAttempts increment", async () => {
    const stageTmp = join(markerTmp, "no-marker");
    await mkdir(stageTmp, { recursive: true });
    await initAuditLog(makeTestConfig({ projectRoot: stageTmp }));

    // Write requirement doc WITHOUT the marker
    await writeFile(join(stageTmp, "req.md"), "# Requirements\nNo marker here\n", "utf-8");

    const config = makeTestConfig({
      projectRoot: stageTmp,
      stages: Object.fromEntries(
        ["clarify", "plan", "develop", "review", "fix", "awaiting_human", "completed"].map(
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
      ) as any,
    });

    const meta = makeTestMeta({
      currentStage: "clarify",
      requirementDoc: "req.md",
      verifyAttempts: 0,
    });
    const ctx = createMockCtx(meta);

    const hook = createAgentSettled(config);
    await hook.handler(ctx as any);

    // verifyAttempts must NOT be incremented (precheck skipped verification)
    expect(meta.verifyAttempts).toBe(0);
    // No stage advance occurred — metadataUpdates should be empty (no updateMeta calls)
    expect(ctx.metadataUpdates.length).toBe(0);
    expect(meta.currentStage).toBe("clarify");
    // Audit should contain verify_completion_marker_pending
    const logContent = await readFile(join(stageTmp, ".pi", "audit", getDateAuditFileName()), "utf-8");
    expect(logContent).toContain("verify_completion_marker_pending");

    await rm(stageTmp, { recursive: true, force: true });
  });

  it("completionMarker on disk → proceeds to normal verification", async () => {
    const stageTmp = join(markerTmp, "with-marker");
    await mkdir(stageTmp, { recursive: true });
    await initAuditLog(makeTestConfig({ projectRoot: stageTmp }));

    // Write requirement doc WITH the marker
    await writeFile(
      join(stageTmp, "req.md"),
      "# Requirements\n## 模型确认\n- full-und? 理解确认：是\n",
      "utf-8",
    );

    // Create a verify.md that will pass (requiredFiles with existing file)
    const vrDir = join(stageTmp, "references", "spec");
    await mkdir(vrDir, { recursive: true });
    await writeFile(
      join(vrDir, "verify.md"),
      "---\nrules:\n  requiredFiles:\n    - \"exists.md\"\n---\nVerify\n",
      "utf-8",
    );
    await writeFile(join(stageTmp, "exists.md"), "content");

    const config = makeTestConfig({
      projectRoot: stageTmp,
      stages: Object.fromEntries(
        ["clarify", "plan", "develop", "review", "fix", "awaiting_human", "completed"].map(
          (s, i, a) => [
            s,
            {
              agentPath: "a.md",
              skillPath: "s.md",
              nextStage: (a[i + 1] ?? null) as PipelineStage | null,
              requireDomain: false,
              verify: s === "clarify"
                ? { require: true, verifyFile: "references/spec/verify.md", completionMarker: "## 模型确认" }
                : undefined,
            },
          ],
        ),
      ) as any,
    });

    const meta = makeTestMeta({
      currentStage: "clarify",
      requirementDoc: "req.md",
      verifyAttempts: 0,
    });
    const ctx = createMockCtx(meta);

    const hook = createAgentSettled(config);
    await hook.handler(ctx as any);

    // Verification ran and passed → stage should advance to plan
    const lastMeta = ctx.metadataUpdates[ctx.metadataUpdates.length - 1];
    expect(lastMeta.currentStage).toBe("plan");

    await rm(stageTmp, { recursive: true, force: true });
  });

  it("no completionMarker configured → behavior unchanged (backward compatible)", async () => {
    const stageTmp = join(markerTmp, "no-config");
    await mkdir(stageTmp, { recursive: true });
    await initAuditLog(makeTestConfig({ projectRoot: stageTmp }));

    // Create a verify.md that will pass
    const vrDir = join(stageTmp, "references", "spec");
    await mkdir(vrDir, { recursive: true });
    await writeFile(
      join(vrDir, "verify.md"),
      "---\nrules:\n  requiredFiles:\n    - \"exists.md\"\n---\nVerify\n",
      "utf-8",
    );
    await writeFile(join(stageTmp, "exists.md"), "content");

    const config = makeTestConfig({
      projectRoot: stageTmp,
      stages: Object.fromEntries(
        ["clarify", "plan", "develop", "review", "fix", "awaiting_human", "completed"].map(
          (s, i, a) => [
            s,
            {
              agentPath: "a.md",
              skillPath: "s.md",
              nextStage: (a[i + 1] ?? null) as PipelineStage | null,
              requireDomain: false,
              // No completionMarker configured
              verify: s === "clarify"
                ? { require: true, verifyFile: "references/spec/verify.md" }
                : undefined,
            },
          ],
        ),
      ) as any,
    });

    const meta = makeTestMeta({ currentStage: "clarify" });
    const ctx = createMockCtx(meta);

    const hook = createAgentSettled(config);
    await hook.handler(ctx as any);

    // Without completionMarker, verification runs normally → stage advances
    const lastMeta = ctx.metadataUpdates[ctx.metadataUpdates.length - 1];
    expect(lastMeta.currentStage).toBe("plan");
    // No completionMarker audit
    const logContent = await readFile(join(stageTmp, ".pi", "audit", getDateAuditFileName()), "utf-8");
    expect(logContent).not.toContain("verify_completion_marker_pending");

    await rm(stageTmp, { recursive: true, force: true });
  });
});

describe("Phase 3 (148): agent_settled verify config skip", () => {
  it("config error (missing verify.md) → notify + audit verify_config_skip + auto-advance (pass)", async () => {
    const stageTmp = join(tmpdir(), "pi-settled-skip-" + Date.now());
    await mkdir(stageTmp, { recursive: true });
    await mkdir(join(stageTmp, ".pi", "audit"), { recursive: true });
    await initAuditLog(makeTestConfig({ projectRoot: stageTmp, auditDir: ".pi/audit" }));

    const config = makeTestConfig({ projectRoot: stageTmp, auditDir: ".pi/audit" });
    config.stages["develop"] = {
      ...config.stages["develop"],
      nextStage: "review",
      verify: { require: true },
    };
    const meta = makeTestMeta({ currentStage: "develop" });

    const notifies: string[] = [];
    const ctx = {
      _ctx: { messages: [] },
      session: {
        getMeta: () => meta,
        updateMeta: (m: any) => Object.assign(meta, m),
      },
      pi: { sendUserMessage: () => {} },
      ui: { notify: (msg?: string) => { if (msg) notifies.push(msg); } },
    };

    const hook = createAgentSettled(config);
    await hook.handler(ctx as any);

    // Should have notified about config skip
    expect(notifies.some(n => n.includes("config error"))).toBe(true);
    // Should have advanced (pass path)
    expect(meta.currentStage).toBe("review");
    // Should have audit log verify_config_skip
    const logContent = await readFile(join(stageTmp, ".pi", "audit", getDateAuditFileName()), "utf-8");
    expect(logContent).toContain("verify_config_skip");
    // M1 fix: skipped must NOT write auto_verify_pass audit
    expect(logContent).not.toContain("auto_verify_pass");

    await rm(stageTmp, { recursive: true, force: true });
  });
});

describe("168 Phase 0: precheckRequiredFiles in agent_settled hook", () => {
  it("requiredFiles missing → verify_precheck_deferred audit, no runVerification, verifyAttempts not incremented, no freeze", async () => {
    const stageTmp = join(tmpdir(), "pi-settled-precheck-" + Date.now());
    await mkdir(stageTmp, { recursive: true });
    await initAuditLog(makeTestConfig({ projectRoot: stageTmp }));

    // Create verify.md with requiredFiles that don't exist
    const vrDir = join(stageTmp, "references", "develop_spec");
    await mkdir(vrDir, { recursive: true });
    await writeFile(
      join(vrDir, "verify.md"),
      "---\nrules:\n  requiredFiles:\n    - \"nonexistent.md\"\n---\nBody\n",
    );

    const config = makeTestConfig({
      projectRoot: stageTmp,
      stages: Object.fromEntries(
        ["clarify", "plan", "develop", "review", "fix", "awaiting_human", "completed"].map(
          (s, i, a) => [
            s,
            {
              agentPath: "a.md",
              skillPath: "s.md",
              nextStage: (a[i + 1] ?? null) as PipelineStage | null,
              requireDomain: false,
              verify: s === "develop"
                ? { require: true, verifyFile: "references/develop_spec/verify.md", mode: "hook" as const }
                : undefined,
            },
          ],
        ),
      ) as any,
    });

    const meta = makeTestMeta({ currentStage: "develop", verifyAttempts: 0 });
    const ctx = createMockCtx(meta);

    const hook = createAgentSettled(config);
    await hook.handler(ctx as any);

    // verifyAttempts must NOT be incremented (precheck deferred)
    expect(meta.verifyAttempts).toBe(0);
    // Pipeline should NOT be frozen
    expect(meta.flowState).toBeUndefined();
    // Stage should NOT advance
    expect(meta.currentStage).toBe("develop");
    // No verifyFailures written (runVerification was NOT called)
    const verifyUpdates = ctx.metadataUpdates.filter(u => u.verifyFailures);
    expect(verifyUpdates.length).toBe(0);
    // Audit should contain verify_precheck_deferred
    const logContent = await readFile(join(stageTmp, ".pi", "audit", getDateAuditFileName()), "utf-8");
    expect(logContent).toContain("verify_precheck_deferred");
    expect(logContent).toContain("nonexistent.md");
    // Should NOT contain auto_verify_fail (full verification was not run)
    expect(logContent).not.toContain("auto_verify_fail");

    await rm(stageTmp, { recursive: true, force: true });
  });
});

describe("Phase 2 / 176: contract-unavailable fail-open integration", () => {
  it("review settle with verdict anchor unavailable → contract_anchor_unavailable + review_declaration_missing audit, notify emitted, verify+confirm gate not blocked", async () => {
    const stageTmp = join(tmpdir(), "pi-176-contract-unavail-" + Date.now());
    await mkdir(stageTmp, { recursive: true });
    await initAuditLog(makeTestConfig({ projectRoot: stageTmp }));

    // Review stage config: verify.require=true, hook mode, auto confirm (default)
    const config = makeTestConfig({
      projectRoot: stageTmp,
      stages: Object.fromEntries(
        ["clarify", "plan", "develop", "review", "fix", "awaiting_human", "completed"].map(
          (s, i, a) => [
            s,
            {
              agentPath: "a.md",
              skillPath: "s.md",
              nextStage: (a[i + 1] ?? null) as PipelineStage | null,
              requireDomain: false,
              verify: s === "review"
                ? { require: true, verifyFile: "references/review_spec/verify.md", mode: "hook" as const }
                : undefined,
            },
          ],
        ),
      ) as any,
    });

    // Create verify.md WITHOUT runtime: verdict anchor — only has requiredFile
    // (no groups with runtime: verdict → loadVerifyContractAnchors returns empty verdict)
    const vrDir = join(stageTmp, "references", "review_spec");
    await mkdir(vrDir, { recursive: true });
    await writeFile(
      join(vrDir, "verify.md"),
      "---\nrules:\n  requiredFiles:\n    - \"exists.md\"\n---\nBody\n",
    );
    await writeFile(join(stageTmp, "exists.md"), "content");

    // Create a review report so parseReviewConclusion finds it but verdict anchor is missing
    const reviewDir = join(stageTmp, "docs", "review");
    await mkdir(reviewDir, { recursive: true });
    await writeFile(
      join(reviewDir, "code_review_test.md"),
      "# Review\n结论：通过\n",
    );

    const meta = makeTestMeta({ currentStage: "review" });
    const ctx = createMockCtx(meta);

    const hook = createAgentSettled(config);
    await hook.handler(ctx as any);

    // Assert: contract_anchor_unavailable + review_declaration_missing audits
    const logPath = join(stageTmp, ".pi", "audit", getDateAuditFileName());
    const logContent = await readFile(logPath, "utf-8");
    expect(logContent).toContain("contract_anchor_unavailable");
    expect(logContent).toContain("review_declaration_missing");
    expect(logContent).toContain("contract_anchor_unavailable");

    // Assert: UI notify was emitted (throttled)
    const notifications = (ctx as any).notifications as string[];
    expect(notifications.some((n: string) => n.includes("contract anchor unavailable"))).toBe(true);

    // Assert: verify+confirm gate not blocked — should fall through to verification
    // (verify passes because requiredFiles exists, then auto-advance to fix)
    const lastMeta = ctx.metadataUpdates[ctx.metadataUpdates.length - 1];
    expect(lastMeta.currentStage).toBe("fix");

    await rm(stageTmp, { recursive: true, force: true });
  });

  it("removing contract-unavailable wiring causes test to fail (red-green discrimination)", async () => {
    // This test validates that the contract-unavailable branch is truly wired.
    // It creates the same setup as above but verifies the audit events are present.
    // If the agent-settled.ts lines 218-237 were removed, this test would turn red.
    const stageTmp = join(tmpdir(), "pi-176-redgreen-" + Date.now());
    await mkdir(stageTmp, { recursive: true });
    await initAuditLog(makeTestConfig({ projectRoot: stageTmp }));

    const config = makeTestConfig({
      projectRoot: stageTmp,
      stages: Object.fromEntries(
        ["clarify", "plan", "develop", "review", "fix", "awaiting_human", "completed"].map(
          (s, i, a) => [
            s,
            {
              agentPath: "a.md",
              skillPath: "s.md",
              nextStage: (a[i + 1] ?? null) as PipelineStage | null,
              requireDomain: false,
              verify: s === "review"
                ? { require: true, verifyFile: "references/review_spec/verify.md", mode: "hook" as const }
                : undefined,
            },
          ],
        ),
      ) as any,
    });

    const vrDir = join(stageTmp, "references", "review_spec");
    await mkdir(vrDir, { recursive: true });
    await writeFile(
      join(vrDir, "verify.md"),
      "---\nrules:\n  requiredFiles:\n    - \"exists.md\"\n---\nBody\n",
    );
    await writeFile(join(stageTmp, "exists.md"), "content");

    const reviewDir = join(stageTmp, "docs", "review");
    await mkdir(reviewDir, { recursive: true });
    await writeFile(
      join(reviewDir, "code_review_test.md"),
      "# Review\n结论：通过\n",
    );

    const meta = makeTestMeta({ currentStage: "review" });
    const ctx = createMockCtx(meta);

    const hook = createAgentSettled(config);
    await hook.handler(ctx as any);

    const logPath = join(stageTmp, ".pi", "audit", getDateAuditFileName());
    const logContent = await readFile(logPath, "utf-8");

    // Red-green discrimination: these audit events MUST be present when the
    // contract-unavailable branch is wired. Removing lines 218-237 in
    // agent-settled.ts would make this test fail.
    expect(logContent).toContain("contract_anchor_unavailable");
    expect(logContent).toContain("review_declaration_missing");

    await rm(stageTmp, { recursive: true, force: true });
  });
});

describe("168 Phase 2: agent_settled frozen re-popup", () => {
  it("frozen agent_settled triggers ui.select (decision menu re-popup)", async () => {
    const stageTmp = join(tmpdir(), "pi-settled-repopup-" + Date.now());
    await mkdir(stageTmp, { recursive: true });
    await initAuditLog(makeTestConfig({ projectRoot: stageTmp }));

    const config = makeTestConfig({ projectRoot: stageTmp });
    const meta = makeTestMeta({
      currentStage: "develop",
      flowState: "blocked",
      blockedReason: "loop_overflow",
    });
    let selectCalls = 0;
    const ctx = createMockCtx(meta, {
      selectReturn: undefined, // Esc → stay blocked
    });
    // Track ui.select calls
    const origSelect = ctx.ui.select;
    ctx.ui.select = async (msg: string, opts: string[]) => {
      selectCalls++;
      return origSelect!(msg, opts);
    };

    const hook = createAgentSettled(config);
    await hook.handler(ctx as any);

    // ui.select should have been called (decision menu re-popped up)
    expect(selectCalls).toBe(1);

    await rm(stageTmp, { recursive: true, force: true });
  });
});
