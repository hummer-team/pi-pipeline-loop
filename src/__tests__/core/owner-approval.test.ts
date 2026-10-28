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
    const older = { command: "git push --force", stage: "review" as const, requestedAt: 1000, attempts: 0 };
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
