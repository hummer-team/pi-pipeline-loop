/**
 * 193 Phase 3 (tasks 2/3/4): the COMMAND/STARTUP entry behaviours for a
 * design-review human decision.
 *
 * Acceptance covered here:
 * - `/pipeline-resume` (provenance "resume") RE-PRESENTS a persisted pending
 *   decision through the shared present-and-act flow and executes the chosen
 *   recovery; Esc keeps the decision pending (never auto-resolved);
 * - `--force-resume` cannot replace the human choice: the domain branch runs
 *   FIRST and the generic force recovery never executes;
 * - an identity-BLOCKED design-review domain is taken over at the entry with
 *   actionable guidance — generic resume/force paths do not run;
 * - a `verify_failed` obtained at the resume entry is consumed EXACTLY ONCE
 *   through the shared honest consumer (tool method: no model wake, budget
 *   attempt recorded once) with no fallthrough to generic recovery;
 * - session STARTUP (provenance "startup") never re-presents the menu and
 *   NEVER falls through to the stale_startup abort while a decision pause or
 *   a domain-consumed verification failure owns the state.
 */

import { describe, it, expect, beforeEach, afterEach, afterAll } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";
import type { DesignReviewState, PipelineConfig, SessionMeta } from "../../types";
import {
  coordinateDesignReview,
  type CoordinatorContext,
} from "../../core/design-review/coordinator";
import {
  clearAllHumanDecisionMenus,
  HUMAN_DECISION_TITLE,
} from "../../core/design-review/human-decision";
import { clearAllDecisionTimers } from "../../core/flow-state";
import {
  computeHash,
  createInitialState,
  deriveReportPath,
} from "../../core/design-review/state";
import { createPipelineResumeCommand } from "../../commands/pipeline-resume";
import { createSessionStarter } from "../../core/session-starter";
import { getFlowState } from "../../core/flow-state";
import { makeTestConfig, makeTestMeta, createMockCtx } from "../helpers";
import { initAuditLog } from "../../utils/auditLog";

const PIPE = "pipe-test-001";
const OWNER = "/x/owner-session.json";

describe("193 Phase 3: resume/startup entries and the human decision", () => {
  let projectRoot: string;
  let planDoc: string;
  let config: PipelineConfig;
  let meta: SessionMeta;
  let cmdCtx: ReturnType<typeof createMockCtx>;
  let menuCalls: Array<{ title: string }>;
  let selectQueue: Array<string | undefined>;

  beforeEach(async () => {
    projectRoot = fs.mkdtempSync(path.join(tmpdir(), "dr-resume-cmd-"));
    fs.mkdirSync(path.join(projectRoot, "docs"), { recursive: true });
    planDoc = path.join(projectRoot, "docs", "193_Feat_plan.md");
    fs.writeFileSync(planDoc, "# Plan\n\nOriginal content.\n", "utf-8");

    config = makeTestConfig({ projectRoot });
    config.stages["develop"] = {
      ...config.stages["develop"],
      agentPath: "agents/dev.md",
      skillPath: "dev/SKILL.md",
    };
    config.stages["design-review"] = {
      ...config.stages["design-review"],
      confirm: { mode: "manual" },
    };
    await initAuditLog(config);

    meta = makeTestMeta({
      currentStage: "design-review",
      designReview: createInitialState(
        planDoc,
        "menu",
        computeHash(fs.readFileSync(planDoc, "utf-8")),
        OWNER,
        { pipelineId: PIPE },
      ),
    });
    cmdCtx = createMockCtx(meta, {
      sessionFile: OWNER,
      sessionName: "owner",
      pi: { sendUserMessage: () => {} },
    });
    menuCalls = [];
    selectQueue = [];
    cmdCtx.ui!.select = async (title: string, _options: readonly string[]) => {
      menuCalls.push({ title });
      return selectQueue.length ? selectQueue.shift() : undefined;
    };
  });

  afterEach(() => {
    clearAllHumanDecisionMenus();
    fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  afterAll(() => {
    clearAllDecisionTimers();
  });

  /** Coordinator ctx for the DRIVE phase (menu/select state shared). */
  function driveCtx(source: "auto" | "tool"): CoordinatorContext {
    return {
      config,
      session: cmdCtx.session,
      ui: {
        notify: (_m: string) => {},
        select: async (title: string, options: readonly string[]) => {
          menuCalls.push({ title });
          return selectQueue.length ? selectQueue.shift() : undefined;
        },
      },
      pi: { sendUserMessage: () => {} },
      actor: { isChild: false, sessionFile: OWNER },
      interactionSource: source,
      spawnOverride: (async () => ({
        spawned: true,
        fallback: false,
        deferred: false,
        agentId: "agent-drive",
        dispatchOutcome: "spawned_id" as const,
      })) as CoordinatorContext["spawnOverride"],
    };
  }

  async function toReviewRunning(): Promise<void> {
    const r = await coordinateDesignReview(driveCtx("auto"), cmdCtx.session.getMeta()!, "advance");
    expect(r.status === "handled" && r.action === "routed").toBe(true);
  }

  function writeFailReport(): void {
    const st = cmdCtx.session.getMeta()!.designReview!;
    fs.writeFileSync(
      deriveReportPath(planDoc, 1),
      [
        "# Design Review Report",
        "",
        `**pipeline**: ${PIPE}`,
        `**plan**: ${planDoc}`,
        "**round**: 1",
        `**operation**: ${st.operation!.operationId}`,
        `**input hash**: ${st.planHash}`,
        "",
        "## Summary",
        "",
        "Reviewed the plan; gaps listed below.",
        "",
        "## Recommendations",
        "",
        "Close the gaps before development.",
        "",
        "## Verdict",
        "",
        "**Design Review: FAIL**",
        "",
        "## Issues",
        "",
        "1. Missing rollback plan for the migration phase",
        "",
      ].join("\n"),
      "utf-8",
    );
  }

  /** Real persisted pending decision: manual FAIL + menu Cancel. */
  async function toPending(): Promise<void> {
    await toReviewRunning();
    writeFailReport();
    selectQueue.push("Cancel");
    const r = await coordinateDesignReview(driveCtx("auto"), cmdCtx.session.getMeta()!, "settle");
    expect(r.status === "handled" && r.action === "pending").toBe(true);
    expect(cmdCtx.session.getMeta()!.designReview!.phase).toBe("paused");
    expect(cmdCtx.session.getMeta()!.designReview!.pauseReason).toBe("decision-pending");
  }

  function humanMenuCount(): number {
    return menuCalls.filter((c) => c.title === HUMAN_DECISION_TITLE).length;
  }

  it("/pipeline-resume RE-PRESENTS the pending menu and persists the choice", async () => {
    await toPending();
    const before = humanMenuCount();
    selectQueue.push("Proceed to Develop");

    const cmd = createPipelineResumeCommand(config);
    const result = (await cmd.execute({}, cmdCtx as never)) as { message?: string };

    expect(humanMenuCount()).toBe(before + 1);
    const after = cmdCtx.session.getMeta()!.designReview!;
    // the human choice is persisted through the strict decision-pinned commit
    expect(after.decision!.state).toBe("chosen");
    expect((after.decision as { choice?: string }).choice).toBe("proceed-develop");
    // command entries have NO trusted dispatch channel in this harness — the
    // develop handoff must honestly report a RETRYABLE outcome (never a fake
    // "advanced", never a silent fallthrough to generic resume).
    // 194 Phase 2: this harness deliberately ships NO deployed develop agent,
    // so the resource gate now blocks the handoff BEFORE the send intent —
    // the same retryable contract, enforced earlier with zero RPCs.
    expect(result.message ?? "").toContain("resource_preflight_failed");
    expect(result.message ?? "").not.toContain("No resume needed");
  });

  it("the persisted choice acts WITHOUT a second menu (idempotent retry)", async () => {
    await toPending();
    selectQueue.push("Proceed to Develop");
    const cmd = createPipelineResumeCommand(config);
    await cmd.execute({}, cmdCtx as never);
    const menusAfterChoice = humanMenuCount();

    // second resume: no popup for an already-chosen decision, still no
    // generic-resume fallthrough
    const result = (await cmd.execute({}, cmdCtx as never)) as { message?: string };
    expect(humanMenuCount()).toBe(menusAfterChoice);
    expect(result.message ?? "").toContain("Design-review recovery");
    expect(result.message ?? "").not.toContain("No resume needed");
    const after = cmdCtx.session.getMeta()!.designReview!;
    expect(after.decision!.state).toBe("chosen");
  });

  it("dismissed re-presentation keeps the decision pending (no auto-resolution)", async () => {
    await toPending();
    const before = humanMenuCount();
    // select returns undefined (Esc) — no choice may be recorded for the human
    const cmd = createPipelineResumeCommand(config);
    const result = (await cmd.execute({}, cmdCtx as never)) as { message?: string };

    expect(humanMenuCount()).toBe(before + 1);
    const after = cmdCtx.session.getMeta()!.designReview!;
    expect(after.decision!.state).toBe("pending");
    expect(after.phase).toBe("paused");
    expect(result.message ?? "").toContain("Design-review recovery pending");
  });

  it("--force-resume cannot replace the human choice (domain branch runs first)", async () => {
    await toPending();
    const before = humanMenuCount();
    const updatesBefore = cmdCtx.metadataUpdates.length;
    selectQueue.push("Cancel");

    const cmd = createPipelineResumeCommand(config);
    const result = (await cmd.execute({ forceResume: true }, cmdCtx as never)) as { message?: string };

    // the menu WAS re-presented (the human channel), and Cancel kept it pending
    expect(humanMenuCount()).toBe(before + 1);
    expect(result.message ?? "").toContain("Design-review recovery pending");
    const after = cmdCtx.session.getMeta()!.designReview!;
    expect(after.decision!.state).toBe("pending");
    // the generic force-resume recovery never executed
    expect(cmdCtx.metadataUpdates.length).toBe(updatesBefore);
  });

  it("identity-BLOCKED domain at resume: takeover guidance, zero generic action", async () => {
    const frozenMeta = makeTestMeta({
      currentStage: "design-review",
      flowState: "blocked",
      designReview: { phase: "review_running" } as unknown as DesignReviewState,
    });
    const ctx = createMockCtx(frozenMeta, { sessionFile: OWNER, sessionName: "owner" });
    const selectSpy: string[] = [];
    ctx.ui!.select = async (title: string) => {
      selectSpy.push(title);
      return undefined;
    };

    const cmd = createPipelineResumeCommand(config);
    const result = (await cmd.execute({}, ctx as never)) as { message?: string };

    expect(result.message ?? "").toContain("identity incomplete");
    // a frozen generic pipeline would have opened the decision menu — it must NOT
    expect(selectSpy.length).toBe(0);
    expect(ctx.metadataUpdates.length).toBe(0);
    expect(frozenMeta.flowState).toBe("blocked");
    expect(frozenMeta.designReview).toBeDefined();
  });

  it("verify_failed at the resume entry: consumed EXACTLY ONCE, tool method, no fallthrough", async () => {
    await toReviewRunning();
    // contract-invalid report → the shared verification service returns
    // kind "invalid", which routes to the honest verify_failed consumption
    fs.writeFileSync(deriveReportPath(planDoc, 1), "not a contract report\n", "utf-8");

    const sends: string[] = [];
    (cmdCtx.pi as { sendUserMessage: (m: string) => void }).sendUserMessage = (m: string) => {
      sends.push(m);
    };

    const cmd = createPipelineResumeCommand(config);
    const result = (await cmd.execute({}, cmdCtx as never)) as { message?: string };

    // ONE budget attempt — never two (no double consumption)
    expect((cmdCtx.session.getMeta() as SessionMeta).verifyAttempts).toBe(1);
    // tool method: concrete guidance shown proactively, the model is NOT woken
    expect(sends.length).toBe(0);
    expect(result.message ?? "").toBeTruthy();
    // no fallthrough into generic running/force recovery
    expect(result.message ?? "").not.toContain("No resume needed");
    // the domain is NOT frozen by a single consumed attempt
    expect(getFlowState(cmdCtx.session.getMeta() as SessionMeta)).toBe("running");
  });

  it("startup with a pending decision: read-only wait, NEVER the stale_startup abort", async () => {
    await toPending();

    const startupCtx = createMockCtx(cmdCtx.session.getMeta() as SessionMeta, {
      sessionFile: OWNER,
      sessionName: "owner",
      event: { reason: "startup" },
      pi: { sendUserMessage: () => {} },
    });
    const startMenuSpy: string[] = [];
    startupCtx.ui!.select = async (title: string) => {
      startMenuSpy.push(title);
      return undefined;
    };

    const hook = createSessionStarter(config);
    await hook.handler(startupCtx as never);

    // startup NEVER presents the menu
    expect(startMenuSpy.length).toBe(0);
    // the stale_startup abort must NOT clobber the human-owned state
    const m = cmdCtx.session.getMeta() as SessionMeta;
    expect(getFlowState(m)).toBe("running");
    expect(m.terminateReason).toBeUndefined();
    expect(m.designReview!.phase).toBe("paused");
    expect(m.designReview!.decision!.state).toBe("pending");
    // read-only notice shown to the operator
    expect(
      startupCtx.notifications.some((n: string) => n.includes("Design-review recovery: decision_pending")),
    ).toBe(true);
  });

  it("startup with a domain verify_failed: consumed once, NO stale_startup abort", async () => {
    await toReviewRunning();
    fs.writeFileSync(deriveReportPath(planDoc, 1), "not a contract report\n", "utf-8");

    const sends: string[] = [];
    const startupCtx = createMockCtx(cmdCtx.session.getMeta() as SessionMeta, {
      sessionFile: OWNER,
      sessionName: "owner",
      event: { reason: "startup" },
      pi: { sendUserMessage: (m: string) => { sends.push(m); } },
    });

    const hook = createSessionStarter(config);
    await hook.handler(startupCtx as never);

    // ONE honest budget attempt (tool method — no wake)
    const m = cmdCtx.session.getMeta() as SessionMeta;
    expect(m.verifyAttempts).toBe(1);
    expect(sends.length).toBe(0);
    // and NEVER the stale_startup abort that used to follow
    expect(getFlowState(m)).toBe("running");
    expect(m.terminateReason).toBeUndefined();
    expect(m.designReview!.phase).toBe("review_running");
  });
});
