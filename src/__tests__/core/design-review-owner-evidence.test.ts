/**
 * 212 Bug Phase 0 (Unit Tests Core): the owner-evidence chain.
 *
 * Covers the locked evidence contract end to end:
 * - `normalizeSessionFile`: empty/blank strings are ABSENT evidence (never a
 *   session identity); real files are trimmed;
 * - `resolveOwnerSessionFile`: non-child speaks for itself, a child speaks for
 *   its DIRECT parent, a child without an observable ancestor fails closed;
 * - `resolveDecisionOwnerFile`: the read-side `""` normalization that the old
 *   `??` fallback masked (this bug's direct regression);
 * - `isBlockedChildWithoutOwnerEvidence`: the ONLY provably-unauthorized
 *   actor — a child with no ancestor; absent actor / non-child without a file
 *   keep the pre-212 behaviour;
 * - coordinator-level creation binding: a child creator must record its
 *   PARENT as owner and itself as `armedBySessionFile` (never its own file)
 *   with zero menu presentations; an owner creator binds itself;
 * - unanswerable boundary: a decision recorded WITHOUT owner evidence makes
 *   `settle` and `resume` both fail closed — `ui.select` 0 times, audit logs
 *   `decision_menu_skipped{role:"unknown", source:"session-file"}` plus the
 *   read-only `decision_owner_evidence_insufficient`, state stays `pending`,
 *   and zero visits / RPC / choices happen;
 * - legacy data: a persisted decision whose `ownerSessionFile` points at a
 *   foreign session file is never rewritten by the read-side normalization
 *   — the owner still resolves to "unknown" (never a guessed authority).
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";
import type { PipelineConfig, SessionMeta } from "../../types";
import {
  coordinateDesignReview,
  type CoordinatorContext,
  type CoordinatorResult,
} from "../../core/design-review/coordinator";
import {
  isBlockedChildWithoutOwnerEvidence,
  normalizeSessionFile,
  resolveDecisionOwnerFile,
  resolveOwnerSessionFile,
} from "../../core/design-review/owner-evidence";
import { buildPendingHumanDecision, clearAllHumanDecisionMenus } from "../../core/design-review/human-decision";
import { createInitialState, computeHash, deriveReportPath } from "../../core/design-review/state";
import { __setSafeWriteAuditLogOverride } from "../../utils/auditLog";
import { makeTestConfig, makeTestMeta, makeStrictSession } from "../helpers";

const CHILD = "/x/child-session.json";
const PARENT = "/x/owner-session.json";
const FOREIGN = "/x/foreign-session.json";

interface AuditRec {
  event: string;
  message: Record<string, unknown>;
  level?: string;
}

// ─── contract-valid report fixture (manual mode: NO decision section) ────────

function report(o: {
  pipelineId: string;
  planDoc: string;
  operationId: string;
  inputHash: string;
  verdict: "PASS" | "FAIL";
  issues?: string[];
}): string {
  return [
    "# Design Review Report",
    "",
    `**pipeline**: ${o.pipelineId}`,
    `**plan**: ${o.planDoc}`,
    `**round**: 1`,
    `**operation**: ${o.operationId}`,
    `**input hash**: ${o.inputHash}`,
    "",
    "## Summary",
    "",
    "Reviewed the plan against the requirement document; gaps are listed below.",
    "",
    "## Recommendations",
    "",
    "Close every listed gap before entering development.",
    "",
    "## Verdict",
    "",
    `**Design Review: ${o.verdict}**`,
    "",
    "## Issues",
    "",
    ...(o.verdict === "PASS" ? ["None"] : (o.issues ?? ["1. Missing rollback plan for the migration phase"])),
    "",
  ].join("\n");
}

interface AuditApi {
  records: AuditRec[];
  use(): void;
  reset(): void;
  findBy(action: string): AuditRec[];
}

function makeAuditCapture(): AuditApi {
  const records: AuditRec[] = [];
  return {
    records,
    use() {
      // Per-test capture: start empty so cross-test leakage can never
      // satisfy a later `findBy` count accidentally.
      records.length = 0;
      __setSafeWriteAuditLogOverride(async (event, message) => {
        records.push({ event, message: message as Record<string, unknown> });
      });
    },
    reset() {
      __setSafeWriteAuditLogOverride(null);
    },
    findBy(action: string): AuditRec[] {
      return records.filter((r) => r.message?.action === action);
    },
  };
}

describe("212 Phase 0: owner evidence pure resolvers", () => {
  it("normalizeSessionFile: absent/blank ⇒ undefined, real paths trim", () => {
    expect(normalizeSessionFile(undefined)).toBeUndefined();
    expect(normalizeSessionFile(null)).toBeUndefined();
    expect(normalizeSessionFile("")).toBeUndefined();
    expect(normalizeSessionFile("   ")).toBeUndefined();
    expect(normalizeSessionFile(" /a/b.json ")).toBe("/a/b.json");
  });

  it("resolveOwnerSessionFile: non-child ⇒ own file, child ⇒ parent, child without parent ⇒ undefined", () => {
    expect(resolveOwnerSessionFile({ isChild: false, sessionFile: PARENT })).toBe(PARENT);
    expect(resolveOwnerSessionFile({ isChild: true, sessionFile: CHILD, parentSessionFile: PARENT })).toBe(PARENT);
    expect(resolveOwnerSessionFile({ isChild: true, sessionFile: CHILD })).toBeUndefined();
    expect(resolveOwnerSessionFile({ isChild: true, sessionFile: CHILD, parentSessionFile: "" })).toBeUndefined();
    expect(resolveOwnerSessionFile(undefined)).toBeUndefined();
    expect(resolveOwnerSessionFile({ isChild: false })).toBeUndefined();
  });

  it("resolveDecisionOwnerFile: state '' falls back to the decision record; both empty ⇒ undefined", () => {
    // THE 212 regression: a persisted "" on the state masked the `??` fallback.
    expect(resolveDecisionOwnerFile("", PARENT)).toBe(PARENT);
    expect(resolveDecisionOwnerFile(PARENT, CHILD)).toBe(PARENT); // state wins when non-empty
    expect(resolveDecisionOwnerFile(undefined, CHILD)).toBe(CHILD);
    expect(resolveDecisionOwnerFile("", "")).toBeUndefined();
    expect(resolveDecisionOwnerFile(undefined, undefined)).toBeUndefined();
  });

  it("isBlockedChildWithoutOwnerEvidence: only a child without an ancestor is provably blocked", () => {
    // child + parent ⇒ false (Phase 2 lets the handoff speak for the owner)
    expect(isBlockedChildWithoutOwnerEvidence({ isChild: true, sessionFile: CHILD, parentSessionFile: PARENT })).toBe(false);
    // child without ancestor ⇒ true (the blocked handoff)
    expect(isBlockedChildWithoutOwnerEvidence({ isChild: true, sessionFile: CHILD })).toBe(true);
    // non-child without a file / absent actor keep pre-212 behaviour (NOT blocked)
    expect(isBlockedChildWithoutOwnerEvidence({ isChild: false })).toBe(false);
    expect(isBlockedChildWithoutOwnerEvidence(undefined)).toBe(false);
  });
});

describe("212 Phase 0: coordinator creation binding (child never owns a decision)", () => {
  let projectRoot: string;
  let planDoc: string;
  let config: PipelineConfig;
  const audit = makeAuditCapture();

  beforeEach(() => {
    projectRoot = fs.mkdtempSync(path.join(tmpdir(), "dr-owner-evidence-"));
    fs.mkdirSync(path.join(projectRoot, "docs"), { recursive: true });
    planDoc = path.join(projectRoot, "docs", "212_Bug_plan.md");
    fs.writeFileSync(planDoc, "# Plan\n\nOriginal content.\n", "utf-8");
    config = makeTestConfig({ projectRoot });
    config.stages["design-review"] = {
      ...config.stages["design-review"],
      confirm: { mode: "manual" },
    };
  });

  afterEach(() => {
    audit.reset();
    clearAllHumanDecisionMenus();
    fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  interface SpawnRec {
    stage: string;
  }

  function makeCtx(
    meta: SessionMeta,
    spawnLog: SpawnRec[],
    opts: {
      select?: (title: string, options: readonly string[]) => Promise<string | undefined>;
      actor?: { isChild: boolean; sessionFile?: string; parentSessionFile?: string };
      interactionSource?: CoordinatorContext["interactionSource"];
    },
  ): { ctx: CoordinatorContext; session: ReturnType<typeof makeStrictSession>; notifications: string[] } {
    const session = makeStrictSession(meta);
    const notifications: string[] = [];
    const ctx: CoordinatorContext = {
      config,
      session,
      ui: {
        notify: (m) => notifications.push(m),
        ...(opts.select !== undefined ? { select: opts.select } : {}),
      },
      ...(opts.actor !== undefined ? { actor: opts.actor } : {}),
      ...(opts.interactionSource !== undefined ? { interactionSource: opts.interactionSource } : {}),
      pi: { sendUserMessage: () => {} },
      spawnOverride: async () => {
        spawnLog.push({ stage: "design-review" });
        return {
          spawned: true,
          fallback: false,
          deferred: false,
          agentId: `agent-${spawnLog.length}`,
          dispatchOutcome: "spawned_id" as const,
        };
      },
    };
    return { ctx, session, notifications };
  }

  function makeMeta(ownerSessionFile?: string): SessionMeta {
    return makeTestMeta({
      currentStage: "design-review",
      pipelineId: "pipe-212-ev",
      designReview: createInitialState(
        planDoc,
        "menu",
        computeHash(fs.readFileSync(planDoc, "utf-8")),
        ownerSessionFile,
        { pipelineId: "pipe-212-ev" },
      ),
    });
  }

  async function dispatchReview(
    ctx: CoordinatorContext,
    session: ReturnType<typeof makeStrictSession>,
  ): Promise<{ reviewOpId: string; planHash: string }> {
    const planHash = computeHash(fs.readFileSync(planDoc, "utf-8"));
    const r = await coordinateDesignReview(ctx, session.getMeta()!, "advance");
    expect(r.status === "handled" && r.action === "routed").toBe(true);
    const st = session.getMeta()!.designReview!;
    expect(st.phase).toBe("review_running");
    return { reviewOpId: st.operation!.operationId, planHash };
  }

  function writeReport(reviewOpId: string, planHash: string): string {
    const reportDoc = deriveReportPath(planDoc, 1);
    fs.writeFileSync(
      reportDoc,
      report({ pipelineId: "pipe-212-ev", planDoc, operationId: reviewOpId, inputHash: planHash, verdict: "FAIL" }),
      "utf-8",
    );
    return reportDoc;
  }

  it("a child creator binds the PARENT as owner and itself (child file) as armedBySessionFile — zero menus", async () => {
    audit.use();
    const spawnLog: SpawnRec[] = [];
    let menuShown = 0;
    const { ctx, session } = makeCtx(makeMeta(), spawnLog, {
      // child evidence WITHOUT a working UI: consistent with the incident
      // (child sessions have no UI — noOpUIContext.select ⇒ undefined)
      actor: { isChild: true, sessionFile: CHILD, parentSessionFile: PARENT },
      select: async () => {
        menuShown++;
        return undefined;
      },
    });
    const { reviewOpId, planHash } = await dispatchReview(ctx, session);
    writeReport(reviewOpId, planHash);

    const r = await coordinateDesignReview(ctx, session.getMeta()!, "settle");
    expect(r.status === "handled" && r.action === "pending" && r.reason === "decision_pending").toBe(true);
    expect(menuShown).toBe(0);

    const after = session.getMeta()!.designReview!;
    expect(after.phase).toBe("paused");
    expect(after.pauseReason).toBe("decision-pending");
    expect(after.decision?.state).toBe("pending");
    // THE contract: the decision speaks for the OWNER (parent), never the child
    expect(after.decision?.ownerSessionFile).toBe(PARENT);
    expect(after.decision?.armedBySessionFile).toBe(CHILD);
    // audit answers "who armed, who owns" without granting any authority
    const created = audit.findBy("decision_pending_created");
    expect(created.length).toBe(1);
    expect(created[0]!.message.ownerSessionFile).toBe(PARENT);
    expect(created[0]!.message.armedBySessionFile).toBe(CHILD);
    // child presentation is skipped honestly (no UI, child role)
    const skipped = audit.findBy("decision_menu_skipped");
    expect(skipped.some((s) => s.message.role === "child")).toBe(true);
    expect(spawnLog.length).toBe(1);
  });

  it("an owner creator binds itself as owner; armedBySessionFile records the same creator", async () => {
    audit.use();
    const spawnLog: SpawnRec[] = [];
    // no select control: creation shows nothing (honest "no select" skip)
    const { ctx, session } = makeCtx(makeMeta(), spawnLog, {
      actor: { isChild: false, sessionFile: PARENT },
    });
    const { reviewOpId, planHash } = await dispatchReview(ctx, session);
    writeReport(reviewOpId, planHash);

    const r = await coordinateDesignReview(ctx, session.getMeta()!, "settle");
    expect(r.status === "handled" && r.action === "pending" && r.reason === "decision_pending").toBe(true);

    const after = session.getMeta()!.designReview!;
    expect(after.decision?.state).toBe("pending");
    expect(after.decision?.ownerSessionFile).toBe(PARENT);
    expect(after.decision?.armedBySessionFile).toBe(PARENT);
    // no owner field ever degrades to an empty string
    expect(after.decision?.ownerSessionFile).not.toBe("");
    expect(after.decision?.armedBySessionFile).not.toBe("");
    const skipped = audit.findBy("decision_menu_skipped");
    expect(skipped.some((s) => s.message.reason === "no select control available")).toBe(true);
  });
});

describe("212 Phase 0: unanswerable decisions fail closed on settle AND resume", () => {
  let projectRoot: string;
  let planDoc: string;
  let config: PipelineConfig;
  const audit = makeAuditCapture();

  beforeEach(() => {
    projectRoot = fs.mkdtempSync(path.join(tmpdir(), "dr-owner-absent-"));
    fs.mkdirSync(path.join(projectRoot, "docs"), { recursive: true });
    planDoc = path.join(projectRoot, "docs", "212_Bug_plan2.md");
    fs.writeFileSync(planDoc, "# Plan\n\nPending without owner evidence.\n", "utf-8");
    config = makeTestConfig({ projectRoot });
    config.stages["design-review"] = {
      ...config.stages["design-review"],
      confirm: { mode: "manual" },
    };
  });

  afterEach(() => {
    audit.reset();
    clearAllHumanDecisionMenus();
    fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  function makePendingMeta(decisionOwner?: string): SessionMeta {
    const planHash = computeHash(fs.readFileSync(planDoc, "utf-8"));
    const pending = buildPendingHumanDecision({
      reviewIdentity: {
        pipelineId: "pipe-212-absent",
        planDoc,
        authorizationId: "authz-212",
        round: 1,
        operationId: "op-212",
        stageVisitId: 1,
      },
      reportDoc: deriveReportPath(planDoc, 1),
      reportHash: "0123456789abcdef",
      planHash,
      issues: [{ issueId: "1", text: "Missing rollback plan" }],
      mode: "manual",
      ...(decisionOwner !== undefined ? { ownerSessionFile: decisionOwner } : {}),
    });
    // Broker the pending record directly into a decision-pending PAUSE —
    // Phase 0 verifies only the presentation gates, not the FAIL consumption.
    const base = createInitialState(planDoc, "menu", planHash, undefined, { pipelineId: "pipe-212-absent" });
    const paused: NonNullable<SessionMeta["designReview"]> = {
      ...base,
      phase: "paused",
      pauseReason: "decision-pending",
      decision: pending,
      updatedAt: base.updatedAt + 1,
    };
    return makeTestMeta({
      currentStage: "design-review",
      pipelineId: "pipe-212-absent",
      designReview: paused,
    });
  }

  function makeActorCtx(
    meta: SessionMeta,
    opts: {
      actor?: { isChild: boolean; sessionFile?: string };
      interactionSource?: CoordinatorContext["interactionSource"];
    } = {},
  ): { ctx: CoordinatorContext; session: ReturnType<typeof makeStrictSession>; notifications: string[]; selectCalls: number } {
    const session = makeStrictSession(meta);
    const notifications: string[] = [];
    let selectCalls = 0;
    const ctx: CoordinatorContext = {
      config,
      session,
      ui: {
        notify: (m) => notifications.push(m),
        select: async () => {
          selectCalls++;
          return "Proceed to Develop"; // an evil selection must never be reachable
        },
      },
      ...(opts.actor !== undefined ? { actor: opts.actor } : {}),
      ...(opts.interactionSource !== undefined ? { interactionSource: opts.interactionSource } : {}),
    };
    return { ctx, session, notifications, selectCalls };
  }

  it("settle without owner evidence: 0 selections, skip audits, state stays pending, zero visits/RPC", async () => {
    audit.use();
    const { ctx, session, selectCalls } = makeActorCtx(makePendingMeta(), {
      actor: { isChild: false, sessionFile: PARENT },
    });
    const r = await coordinateDesignReview(ctx, session.getMeta()!, "settle");
    expect((r as { status: string }).status).toBe("handled");
    expect((r as { action: string }).action).toBe("pending");
    expect(selectCalls).toBe(0);
    const after = session.getMeta()!.designReview!;
    expect(after.decision?.state).toBe("pending");
    expect(after.phase).toBe("paused");
    expect(after.pauseReason).toBe("decision-pending");
    // the failure is auditable in the exact refusal vocabulary
    const skipped = audit.findBy("decision_menu_skipped");
    expect(skipped.length).toBe(1);
    expect(skipped[0]!.message.role).toBe("unknown");
    expect(skipped[0]!.message.source).toBe("session-file");
    expect(skipped[0]!.message.reason).toBe("owner session file was not recorded on the decision");
    const insufficient = audit.findBy("decision_owner_evidence_insufficient");
    expect(insufficient.length).toBe(1);
    expect(insufficient[0]!.message.stage).toBe("settle");
    // zero dispatch/RPC side effects (no spawnOverride ⇒ spawnLog stays empty)
    expect(session.getMeta()!.loopCycleCount).toBe(makeTestMeta().loopCycleCount);
  });

  it("resume without owner evidence: 0 selections, stage=resume audit, state stays pending", async () => {
    audit.use();
    const { ctx, session, selectCalls } = makeActorCtx(makePendingMeta(), {
      actor: { isChild: false, sessionFile: PARENT },
      interactionSource: "resume",
    });
    const r = await coordinateDesignReview(ctx, session.getMeta()!, "settle");
    expect((r as { status: string }).status).toBe("handled");
    expect((r as { action: string }).action).toBe("pending");
    expect(selectCalls).toBe(0);
    const after = session.getMeta()!.designReview!;
    expect(after.decision?.state).toBe("pending");
    const skipped = audit.findBy("decision_menu_skipped");
    expect(skipped.length).toBe(1);
    expect(skipped[0]!.message.role).toBe("unknown");
    expect(skipped[0]!.message.source).toBe("session-file");
    const insufficient = audit.findBy("decision_owner_evidence_insufficient");
    expect(insufficient.length).toBe(1);
    expect(insufficient[0]!.message.stage).toBe("resume");
  });

  it("legacy data: a foreign recorded owner file is NEVER rewritten and still judges unknown", async () => {
    audit.use();
    const { ctx, session, selectCalls } = makeActorCtx(makePendingMeta(FOREIGN), {
      actor: { isChild: false, sessionFile: PARENT },
      interactionSource: "resume",
    });
    const before = session.getMeta()!.designReview!.decision?.ownerSessionFile;
    const r: CoordinatorResult = await coordinateDesignReview(ctx, session.getMeta()!, "settle");
    expect((r as { status: string }).status).toBe("handled");
    expect(selectCalls).toBe(0);
    // read-side normalization is pure: the persisted field is untouched
    const after = session.getMeta()!.designReview!.decision?.ownerSessionFile;
    expect(after).toBe(before);
    expect(after).toBe(FOREIGN);
    expect(session.getMeta()!.designReview!.decision?.state).toBe("pending");
    expect(audit.findBy("decision_menu_skipped").length).toBe(1);
  });
});
