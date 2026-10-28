/**
 * 217 Phase 3 (T3.2): owner-approval unit tests.
 * Plan boundaries: fingerprint stability, idempotent enqueue, oldest-first
 * consumption, no-UI retention (fail-closed AND visible), approve writes /
 * deny does not write `sessionAllowedCommands`, and the queue is cleared in
 * every terminal outcome.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  commandFingerprint,
  enqueueOwnerApproval,
  consumeOnePendingOwnerApproval,
} from "../../core/owner-approval";
import { __setSafeWriteAuditLogOverride } from "../../utils/auditLog";
import { makeTestMeta, makeTestConfig } from "../helpers";
import type { PipelineConfig, SessionMeta } from "../../types";

const audits: Array<{ event: string; message: Record<string, string | boolean> | undefined; level?: string }> = [];

beforeEach(() => {
  audits.length = 0;
  __setSafeWriteAuditLogOverride(async (event, message, level) => {
    audits.push({ event, message, level });
  });
});

afterEach(() => {
  __setSafeWriteAuditLogOverride(null);
});

function makeHarness(init?: Partial<SessionMeta>) {
  const meta = makeTestMeta({ currentStage: "fix", pipelineId: "pipe-217-approval", ...init });
  const session = {
    getMeta: () => meta,
    updateMeta: (patch: Partial<SessionMeta>) => { Object.assign(meta, patch); return meta; },
  };
  return { meta, session };
}

describe("commandFingerprint (T3.2)", () => {
  it("is stable for identical commands and distinct for different ones", () => {
    expect(commandFingerprint("rm -rf node_modules")).toBe(commandFingerprint("rm -rf node_modules"));
    expect(commandFingerprint("rm -rf node_modules")).not.toBe(commandFingerprint("git push --force"));
  });
});

describe("enqueueOwnerApproval", () => {
  it("enqueues keyed by fingerprint with the requested stage + zero attempts", () => {
    const { meta, session } = makeHarness();
    const result = enqueueOwnerApproval(session, "fix", "rm -rf node_modules");

    expect(result.queued).toBe(true);
    expect(result.fingerprint).toBe(commandFingerprint("rm -rf node_modules"));
    const entry = meta.pendingOwnerApprovals?.[result.fingerprint];
    expect(entry).toMatchObject({
      command: "rm -rf node_modules",
      stage: "fix",
      attempts: 0,
    });
    expect(typeof entry?.requestedAt).toBe("number");
  });

  it("re-escalating the SAME command is idempotent (single queue item)", () => {
    const { session } = makeHarness();
    const first = enqueueOwnerApproval(session, "fix", "rm -rf node_modules");
    const second = enqueueOwnerApproval(session, "fix", "rm -rf node_modules");

    expect(first.queued).toBe(true);
    expect(second.queued).toBe(false);
    expect(second.fingerprint).toBe(first.fingerprint);
    // Distinct commands DO accumulate a second entry.
    const third = enqueueOwnerApproval(session, "review", "git push --force");
    expect(third.queued).toBe(true);
  });
});

describe("consumeOnePendingOwnerApproval", () => {
  it("friendliest case first: approve → sessionAllowedCommands gains the command, queue cleared", async () => {
    const { meta, session } = makeHarness();
    enqueueOwnerApproval(session, "fix", "rm -rf node_modules");
    const selects: string[][] = [];
    const outcome = await consumeOnePendingOwnerApproval({
      session,
      ui: {
        select: async (_m, options) => { selects.push(options); return "Allow for this session"; },
        notify: () => {},
      },
    }, makeTestConfig());

    expect(outcome).toBe("approved");
    expect(selects).toHaveLength(1);
    expect(meta.sessionAllowedCommands).toContain("rm -rf node_modules");
    expect(meta.pendingOwnerApprovals).toStrictEqual({});
    expect(audits.some((a) => a.event === "destructive_command_approved")).toBe(true);
  });

  it("deny → NOT written, queue cleared, audit destructive_command_denied", async () => {
    const { meta, session } = makeHarness();
    enqueueOwnerApproval(session, "fix", "rm -rf node_modules");

    const outcome = await consumeOnePendingOwnerApproval({
      session,
      ui: { select: async () => "Deny (block)" },
    }, makeTestConfig());

    expect(outcome).toBe("denied");
    expect(meta.sessionAllowedCommands ?? []).not.toContain("rm -rf node_modules");
    expect(meta.pendingOwnerApprovals).toStrictEqual({});
    expect(audits.some((a) => a.event === "destructive_command_denied")).toBe(true);
  });

  it("no UI → owner_approval_no_ui (warn) + hint, request RETAINED (fail-closed)", async () => {
    const { meta, session } = makeHarness();
    enqueueOwnerApproval(session, "fix", "rm -rf node_modules");
    const notified: string[] = [];

    const outcome = await consumeOnePendingOwnerApproval({
      session,
      ui: { notify: (m) => { notified.push(m); } },
    }, makeTestConfig());

    expect(outcome).toBe("no_ui");
    expect(meta.pendingOwnerApprovals?.[commandFingerprint("rm -rf node_modules")]).toBeDefined();
    expect(notified.length).toBeGreaterThan(0);
    const noUi = audits.find((a) => a.event === "owner_approval_no_ui");
    expect(noUi).toBeDefined();
    expect(noUi?.level).toBe("warn");
  });

  it("oldest requestedAt is consumed first", async () => {
    const oldMeta = makeTestMeta({ currentStage: "fix", pipelineId: "pipe-217-order" });
    const session = {
      getMeta: () => oldMeta,
      updateMeta: (patch: Partial<SessionMeta>) => { Object.assign(oldMeta, patch); return oldMeta; },
    };
    enqueueOwnerApproval(session, "fix", "rm -rf node_modules"); // requestedAt = now
    // Plant an OLDER manual entry (git push): oldest must be served first.
    // (origin pipelineId: stamped by enqueue since review round 4 / issue 3)
    const older = {
      command: "git push --force", stage: "review" as const, requestedAt: 1000, attempts: 0,
      pipelineId: "pipe-217-order",
    };
    session.updateMeta({
      pendingOwnerApprovals: {
        ...(oldMeta.pendingOwnerApprovals ?? {}),
        [commandFingerprint("git push --force")]: older,
      },
    });

    const outcome = await consumeOnePendingOwnerApproval({
      session,
      ui: { select: async () => "Deny (block)" },
    }, makeTestConfig());

    expect(outcome).toBe("denied");
    // The OLDER entry (git push) was consumed: gone; the newer stays queued.
    expect(oldMeta.pendingOwnerApprovals?.[commandFingerprint("git push --force")]).toBeUndefined();
    expect(oldMeta.pendingOwnerApprovals?.[commandFingerprint("rm -rf node_modules")]).toBeDefined();
  });

  it("empty queue → outcome none (no menu, no audit)", async () => {
    const { session } = makeHarness();
    const selectCalled: unknown[] = [];
    const outcome = await consumeOnePendingOwnerApproval({
      session,
      ui: { select: async (...args: unknown[]) => { selectCalled.push(args); return "Allow for this session"; } },
    }, makeTestConfig());
    expect(outcome).toBe("none");
    expect(selectCalled).toHaveLength(0);
    expect(audits.length).toBe(0);
  });
});

/**
 * 217 review round 4 (issue 2, Medium): the owner approval menu MUST reuse the
 * Phase 2 capability predicate (P4 / R1-Q4=A unification). A host declaring
 * `hasUI=false` must never be driven through a select() call even when it
 * hands over a select control — fail closed + visible, request RETAINED.
 */
describe("consumeOnePendingOwnerApproval: declared-capability gate (review issue 2)", () => {
  it("declared hasUI=false × select present → ZERO select calls, request retained, owner_approval_no_ui", async () => {
    const { meta, session } = makeHarness();
    enqueueOwnerApproval(session, "fix", "rm -rf node_modules");
    const selectCalls: string[][] = [];
    const fingerprint = commandFingerprint("rm -rf node_modules");

    const outcome = await consumeOnePendingOwnerApproval({
      session,
      hasUI: false,
      ui: {
        select: async (_m, options) => { selectCalls.push(options); return "Allow for this session"; },
        notify: () => {},
      },
    }, makeTestConfig());

    expect(outcome).toBe("no_ui");
    expect(selectCalls).toHaveLength(0); // declared false WINS over ui.select
    // Fail-closed: the request STAYS queued for a UI-capable turn.
    expect(meta.pendingOwnerApprovals?.[fingerprint]).toBeDefined();
    const noUi = audits.find((a) => a.event === "owner_approval_no_ui");
    expect(noUi).toBeDefined();
    expect(noUi?.level).toBe("warn");
    // NOT approved — the command never enters sessionAllowedCommands.
    expect(meta.sessionAllowedCommands ?? []).not.toContain("rm -rf node_modules");
  });

  it("declared false (function form) × select present → same retention", async () => {
    const { meta, session } = makeHarness();
    enqueueOwnerApproval(session, "fix", "git push --force");
    const selectCalls: string[][] = [];

    const outcome = await consumeOnePendingOwnerApproval({
      session,
      hasUI: () => false,
      ui: { select: async (_m, options) => { selectCalls.push(options); return "Allow for this session"; } },
    }, makeTestConfig());

    expect(outcome).toBe("no_ui");
    expect(selectCalls).toHaveLength(0);
    expect(meta.pendingOwnerApprovals?.[commandFingerprint("git push --force")]).toBeDefined();
    expect(audits.some((a) => a.event === "owner_approval_no_ui")).toBe(true);
  });

  it("declared hasUI=true × select present → menu opens (unchanged)", async () => {
    const { session } = makeHarness();
    enqueueOwnerApproval(session, "fix", "rm -rf node_modules");
    const selectCalls: string[][] = [];

    const outcome = await consumeOnePendingOwnerApproval({
      session,
      hasUI: true,
      ui: { select: async (_m, options) => { selectCalls.push(options); return "Deny (block)"; } },
    }, makeTestConfig());

    expect(outcome).toBe("denied");
    expect(selectCalls).toHaveLength(1);
  });
});

/**
 * 217 review round 4 (issue 3, Medium): the approval queue is scoped to ONE
 * pipeline — enqueue stamps the origin pipelineId, boundary events clear the
 * queue, and the consumer rejects/drops anything from another pipeline so a
 * new pipeline's first settle never surfaces an unrelated approval.
 */
describe("consumeOnePendingOwnerApproval: cross-pipeline residue guard (review issue 3)", () => {
  it("enqueue stamps the origin pipelineId into the entry", () => {
    const { meta, session } = makeHarness();
    enqueueOwnerApproval(session, "fix", "rm -rf node_modules");
    const entry = meta.pendingOwnerApprovals?.[commandFingerprint("rm -rf node_modules")];
    expect(entry?.pipelineId).toBe("pipe-217-approval");
  });

  it("entry from ANOTHER pipeline → dropped (audited), never consumed or whitelisted", async () => {
    const { meta, session } = makeHarness(); // current pipeline: pipe-217-approval
    // Residue surviving from a PREVIOUS pipeline (boundary clear missed it).
    session.updateMeta({
      pendingOwnerApprovals: {
        [commandFingerprint("git push --force")]: {
          command: "git push --force", stage: "develop" as const,
          requestedAt: 1000, attempts: 0, pipelineId: "pipe-OLD",
        },
      },
    });
    const selectCalls: string[][] = [];

    const outcome = await consumeOnePendingOwnerApproval({
      session,
      ui: { select: async (_m, options) => { selectCalls.push(options); return "Allow for this session"; } },
    }, makeTestConfig());

    expect(outcome).toBe("none"); // nothing consumable for THIS pipeline
    expect(selectCalls).toHaveLength(0); // no approval dialog for foreign requests
    expect(meta.sessionAllowedCommands ?? []).not.toContain("git push --force"); // no whitelist leak
    const dropped = audits.find((a) => a.event === "owner_approval_stale_dropped");
    expect(dropped).toBeDefined();
    expect(dropped?.level).toBe("warn");
    expect(String(dropped?.message?.dropped)).toContain(":pipe-OLD");
  });

  it("current-pipeline entry survives a stale-drop pass and is still consumable", async () => {
    const { meta, session } = makeHarness(); // current pipeline: pipe-217-approval
    enqueueOwnerApproval(session, "fix", "rm -rf node_modules");
    // Mix in foreign residue alongside the current entry.
    session.updateMeta({
      pendingOwnerApprovals: {
        ...(meta.pendingOwnerApprovals ?? {}),
        [commandFingerprint("git push --force")]: {
          command: "git push --force", stage: "develop" as const,
          requestedAt: 500, attempts: 0, pipelineId: "pipe-OLD",
        },
      },
    });
    const selectCalls: string[][] = [];

    const outcome = await consumeOnePendingOwnerApproval({
      session,
      ui: { select: async (_m, options) => { selectCalls.push(options); return "Allow for this session"; } },
    }, makeTestConfig());

    // The foreign (older) entry is dropped, NOT served oldest-first.
    expect(outcome).toBe("approved");
    expect(meta.sessionAllowedCommands).toContain("rm -rf node_modules");
    expect(meta.sessionAllowedCommands).not.toContain("git push --force");
    expect(meta.pendingOwnerApprovals).toStrictEqual({}); // both gone (consumed + dropped)
  });
});
