/**
 * 193 Phase 3 (tasks 1/4): the shared runtime-context builder and the
 * interaction-provenance rule.
 *
 * Acceptance covered here:
 * - ONE builder for every entry: notify/select/transition are bound
 *   RECEIVER-PRESERVING (the original `this` survives), the gated
 *   PipelineUI is preferred for notify/transition (commands/startup) while
 *   select ALWAYS comes from the raw SDK UI, role evidence is recorded
 *   honestly (fail-closed `unknown` when the runtime ctx cannot prove a
 *   file), and the interactionSource is the entry's tag — never a model
 *   argument;
 * - provenance gating inside the coordinator: only an explicit RESUME
 *   re-presents a pending decision menu; ordinary settle ("auto"), tool
 *   entries and session STARTUP are read-only waits for the SAME persisted
 *   pending decision.
 */

import { describe, it, expect, beforeEach, afterEach, afterAll } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";
import type { PipelineConfig, SessionMeta } from "../../types";
import {
  createDesignReviewRuntimeContext,
  type DesignReviewRuntimeInput,
} from "../../core/design-review/runtime-context";
import {
  coordinateDesignReview,
  type CoordinatorContext,
} from "../../core/design-review/coordinator";
import { makeTestConfig, makeTestMeta, makeStrictSession } from "../helpers";
import {
  clearAllHumanDecisionMenus,
  HUMAN_DECISION_TITLE,
} from "../../core/design-review/human-decision";
import { clearAllDecisionTimers } from "../../core/flow-state";
import { computeHash, createInitialState, deriveReportPath } from "../../core/design-review/state";

const PIPE = "pipe-test-001";
const OWNER = "/x/owner-session.json";

// ─── builder unit tests ──────────────────────────────────────────────────────

interface ProbeUi {
  label: string;
  notified: string[];
  selected: { title: string; options: readonly string[] }[];
  transitioned: string[];
  notify(msg: string): void;
  select(title: string, options: string[]): Promise<string | undefined>;
  transition(ctxArg: unknown, from: string, to: string): void;
}

function makeProbeUi(label: string): ProbeUi & { [k: string]: unknown } {
  return {
    label,
    notified: [],
    selected: [],
    transitioned: [],
    notify(this: ProbeUi, msg: string) {
      this.notified.push(`${this.label}:${msg}`);
    },
    async select(this: ProbeUi, title: string, options: string[]) {
      this.selected.push({ title, options: [...options] });
      // `this` must still be the receiver inside the wrapped call
      return `selected-for-${this.label}`;
    },
    transition(this: ProbeUi, _ctxArg: unknown, from: string, to: string) {
      this.transitioned.push(`${this.label}:${from}->${to}`);
    },
  };
}

function sessionStub(): DesignReviewRuntimeInput["session"] {
  const meta = makeTestMeta();
  return {
    getMeta: () => meta,
    updateMeta: () => meta,
  } as unknown as DesignReviewRuntimeInput["session"];
}

function baseInput(
  over: Partial<DesignReviewRuntimeInput> = {},
): DesignReviewRuntimeInput {
  return {
    config: makeTestConfig(),
    session: sessionStub(),
    interactionSource: "auto",
    ...over,
  };
}

describe("193 Phase 3: createDesignReviewRuntimeContext", () => {
  it("binds raw notify/select/receiver-preserving (this survives the wrapper)", async () => {
    const rawUi = makeProbeUi("RAW");
    const ctx = createDesignReviewRuntimeContext(baseInput({ rawUi }));

    expect(typeof ctx.ui?.notify).toBe("function");
    ctx.ui!.notify!("hello");
    expect(rawUi.notified).toEqual(["RAW:hello"]);

    expect(typeof ctx.ui?.select).toBe("function");
    const choice = await ctx.ui!.select!("title", ["A", "B"]);
    expect(choice).toBe("selected-for-RAW");
    expect(rawUi.selected[0]).toEqual({ title: "title", options: ["A", "B"] });

    expect(typeof ctx.ui?.transition).toBe("function");
    ctx.ui!.transition!("whatever", "design-review", "plan");
    expect(rawUi.transitioned).toEqual(["RAW:design-review->plan"]);
  });

  it("prefers the GATED PipelineUI for notify/transition (closed over the entry ctx)", () => {
    const rawUi = makeProbeUi("RAW");
    const gateCalls: string[] = [];
    const gateCtxObj = { marker: "ENTRY-CTX" };
    const ctx = createDesignReviewRuntimeContext(baseInput({
      rawUi,
      pipelineUi: {
        notify: (_c: unknown, msg: string) => { gateCalls.push(`gate:${msg}`); },
        transition: (c: unknown, from: string, to: string) => {
          gateCalls.push(`gate:${from}->${to}:${(c as { marker?: string }).marker}`);
        },
      },
      pipelineUiCtx: gateCtxObj,
    }));

    ctx.ui!.notify!("ping");
    ctx.ui!.transition!(undefined, "plan", "design-review");
    // gated channels win — and the entry ctx is carried
    expect(gateCalls).toEqual(["gate:ping", "gate:plan->design-review:ENTRY-CTX"]);
    // raw channels untouched
    expect(rawUi.notified).toEqual([]);
    expect(rawUi.transitioned).toEqual([]);
  });

  it("select NEVER comes from the gated PipelineUI — only the raw SDK control", async () => {
    const rawUi = makeProbeUi("RAW");
    const gateSelect: string[] = [];
    const ctx = createDesignReviewRuntimeContext(baseInput({
      rawUi,
      pipelineUi: {
        notify: () => {},
        // a pipelineUi that (mis)carries select must never be used for menus
        ...( { select: (msg: string) => { gateSelect.push(msg); return Promise.resolve("GATED"); } } as object),
      },
    }));

    const choice = await ctx.ui!.select!("menu", ["Cancel"]);
    expect(choice).toBe("selected-for-RAW");
    expect(gateSelect).toEqual([]);
  });

  it("records honest actor evidence: owner file, fail-closed empty, child flag", () => {
    const ownerCtx = {
      _ctx: { sessionManager: {
        getHeader: () => undefined,
        getSessionName: () => "owner",
        getSessionFile: () => OWNER,
      } },
    };
    const ownerBuilt = createDesignReviewRuntimeContext(baseInput({ roleCtx: ownerCtx }));
    expect(ownerBuilt.actor).toEqual({ isChild: false, sessionFile: OWNER });

    // no raw runtime ctx at all → NO evidence recorded (the coordinator then
    // resolves "unknown" and fails closed — never a guessed authority)
    const blindBuilt = createDesignReviewRuntimeContext(baseInput({}));
    expect(blindBuilt.actor).toBeUndefined();

    const childBuilt = createDesignReviewRuntimeContext(baseInput({
      roleCtx: { _ctx: { sessionManager: {
        getHeader: () => ({ parentSession: "p.json" }),
        getSessionName: () => "child",
        getSessionFile: () => "/x/child.json",
      } } },
    }));
    expect(childBuilt.actor!.isChild).toBe(true);
  });

  it("tags the interactionSource and forwards pi/spawn/verification passthroughs", () => {
    const pi = { sendUserMessage: () => {} };
    const spawn = async () => ({ spawned: true, fallback: false, deferred: false, dispatchOutcome: "deferred" as const });
    const ctx = createDesignReviewRuntimeContext(baseInput({
      interactionSource: "resume",
      pi,
      spawnOverride: spawn as never,
      verificationOptions: { x: 1 } as never,
    }));
    expect(ctx.interactionSource).toBe("resume");
    expect(ctx.pi).toBe(pi);
    expect(ctx.spawnOverride).toBeDefined();
    expect(ctx.verificationOptions).toBeDefined();
  });
});

// ─── provenance gating over a REAL pending decision ─────────────────────────

describe("193 Phase 3: only an explicit resume re-presents a pending decision", () => {
  let projectRoot: string;
  let planDoc: string;
  let config: PipelineConfig;
  let session: ReturnType<typeof makeStrictSession>;

  beforeEach(() => {
    projectRoot = fs.mkdtempSync(path.join(tmpdir(), "dr-entrypoints-"));
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

    const meta = makeTestMeta({
      currentStage: "design-review",
      designReview: createInitialState(
        planDoc,
        "menu",
        computeHash(fs.readFileSync(planDoc, "utf-8")),
        OWNER,
        { pipelineId: PIPE },
      ),
    });
    session = makeStrictSession(meta);
  });

  afterEach(() => {
    clearAllHumanDecisionMenus();
    fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  afterAll(() => {
    clearAllDecisionTimers();
  });

  let menuTitles: string[];

  function coordFor(source: DesignReviewRuntimeInput["interactionSource"]): CoordinatorContext {
    return createDesignReviewRuntimeContext({
      config,
      session,
      interactionSource: source,
      roleCtx: {
        _ctx: { sessionManager: {
          getHeader: () => undefined,
          getSessionName: () => "owner",
          getSessionFile: () => OWNER,
        } },
      },
      rawUi: {
        notify: (_m: string) => {},
        select: async (title: string, options: readonly string[]) => {
          menuTitles.push(title);
          // first presentation: Cancel keeps the decision pending
          return menuTitles.length === 1 ? "Cancel" : "Proceed to Develop";
        },
      },
      pi: { sendUserMessage: () => {} },
      spawnOverride: async () => ({
        spawned: true,
        fallback: false,
        deferred: false,
        agentId: "agent-x",
        dispatchOutcome: "spawned_id" as const,
      }),
    });
  }

  function failReport(): string {
    const st = session.getMeta()!.designReview!;
    const reportDoc = deriveReportPath(planDoc, 1);
    fs.writeFileSync(
      reportDoc,
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
    return reportDoc;
  }

  /** Create a REAL persisted pending decision (manual FAIL + Cancel). */
  async function createPendingDecision(): Promise<void> {
    // dispatch the review agent
    const r1 = await coordinateDesignReview(coordFor("auto"), session.getMeta()!, "advance");
    expect(r1.status === "handled" && r1.action === "routed").toBe(true);
    failReport();
    // settle -> valid FAIL -> menu -> Cancel -> pending stays
    const r2 = await coordinateDesignReview(coordFor("auto"), session.getMeta()!, "settle");
    expect(r2.status === "handled" && r2.action === "pending").toBe(true);
    expect(session.getMeta()!.designReview!.phase).toBe("paused");
    expect(session.getMeta()!.designReview!.pauseReason).toBe("decision-pending");
    expect(session.getMeta()!.designReview!.decision!.state).toBe("pending");
  }

  it("creation flow presents exactly ONE menu and Cancel keeps it pending", async () => {
    menuTitles = [];
    await createPendingDecision();
    expect(menuTitles.filter((t) => t === HUMAN_DECISION_TITLE).length).toBe(1);
  });

  it("ordinary settle (auto) does NOT re-present the pending menu", async () => {
    menuTitles = [];
    await createPendingDecision();
    const before = menuTitles.filter((t) => t === HUMAN_DECISION_TITLE).length;
    const r = await coordinateDesignReview(coordFor("auto"), session.getMeta()!, "settle");
    expect(r.status === "handled" && r.action === "pending").toBe(true);
    expect((r as { reason?: string }).reason).toBe("decision_pending");
    expect(menuTitles.filter((t) => t === HUMAN_DECISION_TITLE).length).toBe(before);
  });

  it("tool entries do NOT re-present the pending menu", async () => {
    menuTitles = [];
    await createPendingDecision();
    const before = menuTitles.filter((t) => t === HUMAN_DECISION_TITLE).length;
    const r = await coordinateDesignReview(coordFor("tool"), session.getMeta()!, "verify");
    expect(r.status === "handled" && r.action === "pending").toBe(true);
    expect(menuTitles.filter((t) => t === HUMAN_DECISION_TITLE).length).toBe(before);
  });

  it("session STARTUP does NOT re-present the pending menu (read-only wait)", async () => {
    menuTitles = [];
    await createPendingDecision();
    const before = menuTitles.filter((t) => t === HUMAN_DECISION_TITLE).length;
    const r = await coordinateDesignReview(coordFor("startup"), session.getMeta()!, "settle");
    expect(r.status === "handled" && r.action === "pending").toBe(true);
    expect(menuTitles.filter((t) => t === HUMAN_DECISION_TITLE).length).toBe(before);
  });

  it("explicit RESUME re-presents the SAME menu and acts on the chosen recovery", async () => {
    menuTitles = [];
    await createPendingDecision();
    const before = menuTitles.filter((t) => t === HUMAN_DECISION_TITLE).length;
    expect(before).toBe(1);

    const r = await coordinateDesignReview(coordFor("resume"), session.getMeta()!, "settle");
    // second presentation happened...
    expect(menuTitles.filter((t) => t === HUMAN_DECISION_TITLE).length).toBe(2);
    // ...and the chosen "Proceed to Develop" was executed WITHOUT re-verification
    expect(r.status === "handled" && r.action === "advanced"
      && (r as { toStage?: string }).toStage === "develop").toBe(true);
    const after = session.getMeta()!.designReview!;
    expect(after.decision!.state).toBe("chosen");
    expect((after.decision as { choice?: string }).choice).toBe("proceed-develop");
    // the release mirrors the Phase-2 contract: finished + stage advanced
    expect(after.phase).toBe("finished");
    expect(session.getMeta()!.currentStage).toBe("develop");
  });
});
