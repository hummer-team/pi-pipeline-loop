/**
 * 208 Phase 4 — freeze escalation integration chains (four chains + three-
 * entry coverage + reason smoke), plus guide 13.3.1 sync (separate commit
 * content in the same phase).
 *
 * Chains (plan §Phase 4):
 * ① owner freeze → 1 select → Resume → unfrozen, exactly one menu;
 * ② child freeze → menu_escalation_armed → owner agent_settled →
 *    menu_escalation_consumed → popup (child timers=0);
 * ③ fast dismiss → 5s re-popup → slow Esc → cancelled, timer cleared;
 *    next settle re-presents;
 * ④ no ui.select → runtime notify + pipeline_decision_interrupted(no_ui),
 *    stays frozen;
 * ④-b command no-UI: /pipeline-resume notifies exactly once + audits
 *    resume_skipped_no_menu(no_ui); /pipeline-start notifies zero times and
 *    returns an error with stage + formatFrozenReason;
 * concurrency: in-flight freeze + /pipeline-resume → 1 select +
 *    decision_menu_joined_inflight;
 * reason smoke: loop_overflow / verify_failure_loop_overflow / loop_halt_overflow;
 * select throws → resume_skipped_no_menu(select_error).
 *
 * The chains run on the SAME production composition harness as the design-review
 * chains (`makeCompositionHarness` in `executor-chain-harness.ts`): a REAL
 * shared session store (`createSessionState`) with a REAL event bus, plus the
 * REAL production entries (freezeAndPrompt, agent_settled hook, both commands).
 * Only the TUI dialogs and the pi SDK boundary are scripted.
 */
import { describe, it, expect, beforeEach, afterEach, jest } from "bun:test";
import { createAgentSettled } from "../../core/agent-settled";
import {
  freezeAndPrompt,
  clearAllDecisionTimers,
  __decisionTimerCount,
  __hasDecisionTimer,
} from "../../core/flow-state";
import { createPipelineResumeCommand } from "../../commands/pipeline-resume";
import { createPipelineStartCommand } from "../../commands/pipeline-start";
import { registerEscalationObserver, PIPELINE_ESCALATION_EVENT } from "../../utils/escalation-bus";
import { __setSafeWriteAuditLogOverride } from "../../utils/auditLog";
import { makeCompositionHarness } from "./executor-chain-harness";
import { makeTestMeta } from "../helpers";
import type { FlowStateCtx } from "../../core/flow-state";
import type { SessionMeta } from "../../types";

type SelectCall = { message: string; options: string[] };
type CapturedAudit = {
  event: string;
  message: Record<string, string | boolean> | undefined;
  level: string | undefined;
};

// ─── shared capture ──────────────────────────────────────────────────────────

let audits: CapturedAudit[] = [];
let pidCounter = 0;

interface FreezeChain {
  projectRoot: string;
  config: ReturnType<typeof makeCompositionHarness>["config"];
  pipelineId: string;
  meta(): SessionMeta;
  ownerCtx: FlowStateCtx;
  childCtx: FlowStateCtx;
  settle(): Promise<void>;
  /** Queue the next select answers (undefined = dismiss). */
  q(...answers: Array<string | undefined>): void;
  /** Make the NEXT select park; release with releaseParked(). */
  parkNext(): void;
  parkedCount(): number;
  releaseParked(answer: string | undefined): void;
  selectCalls: SelectCall[];
  ownerNotifies: string[];
  childNotifies: string[];
  /** Escalation broadcasts observed through the composition-root analog. */
  escalations: unknown[];
  cleanup(): void;
}

/**
 * Freeze-escalation chain on top of the shared production composition
 * (`makeCompositionHarness`). Only the TUI dialogs are scripted here; the
 * session store, event bus and `agent_settled` listener come from the same
 * assembly the design-review chains use.
 */
function makeFreezeChain(seed?: Partial<SessionMeta>): FreezeChain {
  pidCounter++;
  const pipelineId = `pipe-frz-chain-${pidCounter}`;

  const selectQueue: Array<string | undefined> = [];
  const selectCalls: SelectCall[] = [];
  const ownerNotifies: string[] = [];
  const childNotifies: string[] = [];
  const escalations: unknown[] = [];

  let parkedResolve: ((v: string | undefined) => void) | null = null;
  let parkArmed = false;

  const composition = makeCompositionHarness();

  // Composition-root analog: index.ts registers exactly this wake observer.
  registerEscalationObserver(composition.ownerPi, (p) => escalations.push(p));

  composition.ownerSession.updateMeta(
    makeTestMeta({
      pipelineId,
      currentStage: "develop",
      requirementDoc: "docs/design/req.md",
      ...seed,
    }) as SessionMeta,
  );
  // Seed the child's local meta entry — in production the dispatcher/starter
  // appends the pipeline snapshot to the spawned child session, which is what
  // makes its local getMeta() resolve the shared pipelineId.
  composition.childSession.updateMeta(composition.ownerSession.getMeta() as SessionMeta);

  const captureNotifies = (target: string[]) => (...args: unknown[]) => {
    const firstString = args.find((a) => typeof a === "string");
    if (typeof firstString === "string") target.push(firstString);
  };

  const ownerUi = {
    select: async (message: unknown, options: unknown) => {
      selectCalls.push({ message: String(message), options: options as string[] });
      if (parkArmed && parkedResolve === null) {
        parkArmed = false;
        return new Promise<string | undefined>((res) => { parkedResolve = res; });
      }
      return selectQueue.shift();
    },
    notify: captureNotifies(ownerNotifies),
    setStatus: () => {},
    input: async () => undefined,
  };
  const childUi = {
    notify: captureNotifies(childNotifies),
    setStatus: () => {},
  };

  const ownerCtx = {
    session: composition.ownerSession,
    pi: composition.ownerPi,
    ui: ownerUi,
    _ctx: { sessionManager: composition.ownerManager },
  };
  const childCtx = {
    session: composition.childSession,
    pi: composition.childPi,
    ui: childUi,
    _ctx: { sessionManager: composition.childManager },
  };

  const hook = createAgentSettled(composition.config);

  return {
    projectRoot: composition.projectRoot,
    config: composition.config,
    pipelineId,
    meta: () => composition.ownerSession.getMeta() as SessionMeta,
    ownerCtx: ownerCtx as unknown as FlowStateCtx,
    childCtx: childCtx as unknown as FlowStateCtx,
    settle: async () => {
      await hook.handler(ownerCtx as never);
      await drainMicrotasks();
    },
    q: (...answers) => { selectQueue.push(...answers); },
    parkNext: () => { parkArmed = true; },
    parkedCount: () => (parkedResolve ? 1 : 0),
    releaseParked: (answer) => {
      const res = parkedResolve;
      parkedResolve = null;
      res?.(answer);
    },
    selectCalls,
    ownerNotifies,
    childNotifies,
    escalations,
    cleanup: () => composition.cleanup(),
  };
}

/** Flush pending microtasks (works under fake timers — no timer advances). */
async function drainMicrotasks(): Promise<void> {
  for (let i = 0; i < 120; i++) {
    // eslint-disable-next-line no-await-in-loop
    await Promise.resolve().then(() => {});
  }
}

beforeEach(() => {
  audits = [];
  __setSafeWriteAuditLogOverride(async (event, message, level) => {
    audits.push({ event, message, level });
  });
});

afterEach(() => {
  jest.useRealTimers();
  __setSafeWriteAuditLogOverride(null);
  clearAllDecisionTimers();
});

// ─── chain ①: owner freeze → single menu → Resume ────────────────────────────

describe("208 Phase 4 chain ①: owner freeze → Resume", () => {
  it("select exactly once, decision applied, no timers armed", async () => {
    const chain = makeFreezeChain();
    chain.q("Resume");
    try {
      const meta = chain.meta();
      await freezeAndPrompt(chain.ownerCtx as never, meta, "loop_overflow", chain.config);

      // Menu appeared exactly once and the decision unfroze the pipeline.
      expect(chain.selectCalls.length).toBe(1);
      expect(chain.meta().flowState).toBe("running");
      expect(chain.meta().blockedReason).toBeUndefined();
      expect(__decisionTimerCount()).toBe(0);
      // pipeline_blocked audit (warn) recorded the freeze moment
      const blocked = audits.find((a) => a.event === "pipeline_blocked");
      expect(blocked?.message?.["reason"]).toBe("loop_overflow");
      expect(blocked?.message?.["hostRole"]).toBe("owner");
      // applied resume leaves no stray presentation
      expect(audits.some((a) => a.event === "decision_menu_presented")).toBe(true);
    } finally {
      chain.cleanup();
    }
  });
});

// ─── chain ②: child freeze → escalation → owner settle → popup ───────────────

describe("208 Phase 4 chain ②: child freeze → owner settle popup", () => {
  it("child freezes silently; owner settle consumes the escalation and pops the menu", async () => {
    const chain = makeFreezeChain();
    chain.q("Resume");
    try {
      // Child session hits the threshold → freeze (running → blocked).
      const childMeta = chain.meta();
      await freezeAndPrompt(chain.childCtx as never, childMeta, "loop_overflow", chain.config);

      // Child must stay silent (no popup, no timer) and escalate.
      expect(chain.selectCalls.length).toBe(0);
      expect(__decisionTimerCount()).toBe(0);
      expect(chain.meta().menuEscalationPending).toBe(true);
      expect(audits.some((a) => a.event === "pipeline_menu_suppressed_child")).toBe(false);
      expect(audits.some((a) => a.event === "menu_escalation_armed")).toBe(true);
      // composition-root wake observer saw the broadcast exactly once
      expect(chain.escalations.length).toBe(1);

      // Owner settle → escalation consumed once + decision menu.
      await chain.settle();

      const consumed = audits.filter((a) => a.event === "menu_escalation_consumed");
      expect(consumed.length).toBe(1);
      expect(chain.selectCalls.length).toBe(1);
      expect(chain.meta().flowState).toBe("running");
      expect(chain.meta().menuEscalationPending).toBeFalsy();
      expect(__decisionTimerCount()).toBe(0);
    } finally {
      chain.cleanup();
    }
  });
});

// ─── chain ③: fast dismiss → retry → slow Esc → cancelled → settle re-popup ──

describe("208 Phase 4 chain ③: interrupted → backoff → Esc cancel → settle re-popup", () => {
  // FAKE timers only (plan Phase 4 boundary: "使用 fake timers"). Bun's fake
  // clock advances Date.now with advanceTimersByTime, so the 5s backoff and
  // the >= 1500ms slow-Esc threshold are both driven deterministically without
  // any real waiting (the previous version slept 5.3s + 1.6s per run).
  it("5s re-popup after fast dismiss; slow Esc stops retries; settle re-presents", async () => {
    const chain = makeFreezeChain();
    jest.useFakeTimers();
    try {
      const meta = chain.meta();
      chain.parkNext();

      const p1 = freezeAndPrompt(chain.ownerCtx as never, meta, "loop_overflow", chain.config);
      await drainMicrotasks();
      expect(chain.selectCalls.length).toBe(1); // first popup parked
      // Re-arm the park for the timer-fired second popup BEFORE releasing.
      chain.parkNext();

      // Streaming-like instant dismiss (fake elapsed 0 < 1500ms) →
      // interrupted → scheduler arms the 5s first-attempt backoff.
      chain.releaseParked(undefined);
      await drainMicrotasks();
      expect(__hasDecisionTimer(chain.pipelineId)).toBe(true);
      const armed = audits.filter((a) => a.event === "decision_menu_retry_armed");
      expect(armed.length).toBe(1);
      expect(armed[0].message?.["delayMs"]).toBe("5000");

      // G1: the armed timer re-opens the menu after 5s of fake time.
      jest.advanceTimersByTime(5000);
      await drainMicrotasks();
      expect(chain.selectCalls.length).toBe(2); // second popup parked
      expect(chain.parkedCount()).toBe(1);

      // Slow Esc: hold the dialog open 1600ms (>= threshold) on the fake clock,
      // then dismiss → cancelled, scheduler stops, no timer survives.
      jest.advanceTimersByTime(1600);
      chain.releaseParked(undefined);
      await drainMicrotasks();
      await (p1 as unknown as Promise<void>);
      expect(audits.some((a) => a.event === "pipeline_decision_cancelled")).toBe(true);
      expect(__hasDecisionTimer(chain.pipelineId)).toBe(false);
      expect(__decisionTimerCount()).toBe(0);

      // Next agent settle re-presents the menu (one more select).
      chain.q(undefined); // quick dismiss on the settle re-popup
      await chain.settle();
      expect(chain.selectCalls.length).toBe(3);
    } finally {
      chain.cleanup();
    }
  });
});

// ─── chain ④: no UI → runtime notify + interrupted(no_ui) + stay frozen ──────

describe("208 Phase 4 chain ④: no ui.select degradation", () => {
  it("freeze without select → notify + pipeline_decision_interrupted(no_ui) + stays frozen", async () => {
    const chain = makeFreezeChain();
    try {
      // Strip select from the owner UI (chain ④-b needs notify only)
      (chain.ownerCtx as { ui: Record<string, unknown> }).ui = {
        notify: (...args: unknown[]) => {
          const firstString = args.find((a) => typeof a === "string");
          if (typeof firstString === "string") chain.ownerNotifies.push(firstString);
        },
      };
      const meta = chain.meta();
      await freezeAndPrompt(chain.ownerCtx as never, meta, "loop_overflow", chain.config);

      expect(chain.meta().flowState).toBe("blocked");
      expect(chain.ownerNotifies.some((m) => m.includes("decision menu"))).toBe(true);
      const noUi = audits.filter(
        (a) => a.event === "pipeline_decision_interrupted" && a.message?.["context"] === "no_ui",
      );
      expect(noUi.length).toBe(1);
      expect(__decisionTimerCount()).toBe(0);
    } finally {
      chain.cleanup();
    }
  });

  it("chain ④-b: /pipeline-resume notifies once + audits no_ui; /pipeline-start zero notify", async () => {
    const chain = makeFreezeChain();
    try {
      const uiNoSelect = {
        notify: (...args: unknown[]) => {
          const firstString = args.find((a) => typeof a === "string");
          if (typeof firstString === "string") chain.ownerNotifies.push(firstString);
        },
      };
      // pre-freeze without select (no menu was ever shown)
      (chain.ownerCtx as { ui: unknown }).ui = uiNoSelect;
      const meta = chain.meta();
      await freezeAndPrompt(chain.ownerCtx as never, meta, "loop_overflow", chain.config);
      const beforeResume = chain.ownerNotifies.length;

      // /pipeline-resume — single command-owned no-menu notify
      const resumeCmd = createPipelineResumeCommand(chain.config);
      const resume: any = await resumeCmd.execute({}, chain.ownerCtx as any);
      expect(resume.message).toContain("No decision menu is available (no_ui)");
      const fromResume = chain.ownerNotifies.slice(beforeResume).filter((m) => m.includes("No decision menu is available"));
      expect(fromResume.length).toBe(1);
      const skipped = audits.filter((a) => a.event === "resume_skipped_no_menu");
      expect(skipped.length).toBe(1);
      expect(skipped[0].message?.["reason"]).toBe("no_ui");

      // /pipeline-start — zero notify, error keeps stage + frozen reason
      const startTail = chain.ownerNotifies.length;
      const startCmd = createPipelineStartCommand(chain.config);
      const start: any = await startCmd.execute({}, chain.ownerCtx as any);
      expect(start.success).toBe(false);
      expect(start.error).toContain(`Pipeline frozen at "${chain.meta().currentStage}"`);
      expect(chain.ownerNotifies.length).toBe(startTail);
    } finally {
      chain.cleanup();
    }
  });
});

// ─── concurrency: in-flight freeze + /pipeline-resume → single select ────────

describe("208 Phase 4 concurrency: freeze in-flight + /pipeline-resume", () => {
  it("single select, decision_menu_joined_inflight audited once", async () => {
    const chain = makeFreezeChain();
    jest.useFakeTimers();
    try {
      const meta = chain.meta();
      chain.parkNext();

      // Freeze starts a presentation that parks inside ui.select.
      const p1 = freezeAndPrompt(chain.ownerCtx as never, meta, "loop_overflow", chain.config);
      await drainMicrotasks();
      expect(chain.selectCalls.length).toBe(1);

      // The command entry joins the same in-flight presentation.
      const resumeCmd = createPipelineResumeCommand(chain.config);
      const resumePromise = resumeCmd.execute({}, chain.ownerCtx as any) as Promise<{ message?: string }>;
      await drainMicrotasks();
      expect(chain.selectCalls.length).toBe(1); // joined, no second dialog

      // 1600ms slow dismiss on the fake clock → cancelled (no retry timer,
      // no dispatch).
      jest.advanceTimersByTime(1600);
      chain.releaseParked(undefined);
      await drainMicrotasks();
      const [resume] = await Promise.all([resumePromise, p1 as unknown as Promise<void>]);
      expect(chain.selectCalls.length).toBe(1);
      expect(resume.message).toContain("Pipeline remains frozen");
      const joined = audits.filter((a) => a.event === "decision_menu_joined_inflight");
      expect(joined.length).toBe(1);
      expect(__hasDecisionTimer(chain.pipelineId)).toBe(false);
    } finally {
      chain.cleanup();
    }
  });
});

// ─── three freeze-reason smoke ────────────────────────────────────────────────

describe("208 Phase 4: freeze reason smoke", () => {
  for (const reason of ["loop_overflow", "verify_failure_loop_overflow", "loop_halt_overflow"]) {
    it(`reason ${reason}: blockedReason recorded, menu presented`, async () => {
      const chain = makeFreezeChain();
      chain.q("Resume");
      try {
        const meta = chain.meta();
        await freezeAndPrompt(chain.ownerCtx as never, meta, reason, chain.config);
        expect(chain.meta().blockedReason ?? chain.meta().flowState).toBeTruthy();
        expect(chain.meta().flowState).toBe("running"); // Resume applied
        expect(chain.selectCalls.length).toBe(1);
        const presented = audits.filter((a) => a.event === "decision_menu_presented");
        expect(presented.length).toBe(1);
        expect(presented[0].message?.["blockedReason"]).toBe(reason);
      } finally {
        chain.cleanup();
      }
    });
  }
});

// ─── select throws → select_error attribution through the command ────────────

describe("208 Phase 4: select_error chain", () => {
  it("select throws → resume_skipped_no_menu(select_error), pipeline stays frozen", async () => {
    const chain = makeFreezeChain();
    try {
      const meta = chain.meta();
      // Make the harness select throw: BOTH the freeze and the command see it.
      (chain.ownerCtx.ui as { select?: unknown }).select = async () => {
        throw new Error("dialog boom");
      };
      await freezeAndPrompt(chain.ownerCtx as never, meta, "loop_overflow", chain.config);

      expect(chain.meta().flowState).toBe("blocked");
      expect(audits.some((a) => a.event === "pipeline_decision_error")).toBe(true);
      expect(
        audits.filter(
          (a) => a.event === "pipeline_decision_interrupted" && a.message?.["context"] === "select_error",
        ).length,
      ).toBe(1);

      // Command side mirrors the same attribution (select still throws)
      const resumeCmd = createPipelineResumeCommand(chain.config);
      const resume: any = await resumeCmd.execute({}, chain.ownerCtx as any);
      const skipped = audits.filter((a) => a.event === "resume_skipped_no_menu");
      expect(skipped.length).toBe(1);
      expect(skipped[0].message?.["reason"]).toBe("select_error");
      expect(resume.message).toContain("select_error");
    } finally {
      chain.cleanup();
    }
  });
});

