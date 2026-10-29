/**
 * @module owner-approval-write
 * 218 Phase 2 (T2.4, F.3-2/F.4-2/Q15-B): the queued child WRITE approvals —
 * fingerprint stability, batched owner menu (ONE interaction per settle for
 * the current stage), deterministic cross-kind/cross-stage selection order,
 * the explicit-Deny breaker and the 217 command regression.
 *
 * Plan case table: 1 / 2 / 3 / 3b / 3c / 4 / 5.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  writeFingerprint,
  enqueueWriteApproval,
  writeApprovalBlockReason,
  consumeOnePendingOwnerApproval,
  consumePendingOwnerApprovalDetailed,
} from "../../core/owner-approval";
import { __setSafeWriteAuditLogOverride } from "../../utils/auditLog";
import { makeTestMeta, makeTestConfig } from "../helpers";
import { isFrozen } from "../../core/flow-state";
import type { PipelineConfig, SessionMeta } from "../../types";
import type { WriteCandidate } from "../../core/write-scope/types";

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

/** Minimal owner ctx with a scripted select queue + notification capture. */
function makeHarness(
  init?: Partial<SessionMeta>,
  selectScript: Array<string | undefined> = [],
) {
  const meta = makeTestMeta({ currentStage: "develop", pipelineId: "pipe-218-write", ...init });
  const session = {
    getMeta: () => meta,
    updateMeta: (patch: Partial<SessionMeta>) => { Object.assign(meta, patch); return meta; },
  };
  const menus: Array<{ title: string; options: string[] }> = [];
  const notices: string[] = [];
  let selectIndex = 0;
  const ctx = {
    session,
    ui: {
      select: async (title: string, options: string[]) => {
        menus.push({ title, options });
        return selectIndex < selectScript.length ? selectScript[selectIndex++] : undefined;
      },
      notify: (msg: string) => { notices.push(msg); },
    },
  };
  return { meta, session, ctx, menus, notices };
}

const candidate = (path: string, category: WriteCandidate["category"] = "whitelist_miss"): WriteCandidate => ({
  path,
  category,
  source: "bash",
  pathClass: path.split("/")[0] === "@outside" || path.startsWith("/") ? "@outside" : path.split("/")[0],
});

describe("writeFingerprint / enqueueWriteApproval (case 1)", () => {
  it("fingerprint is order-independent; same target set → queued:false, no duplicate entry", () => {
    expect(writeFingerprint(["tmp/a", "tmp/b"])).toBe(writeFingerprint(["tmp/b", "tmp/a"]));
    expect(writeFingerprint(["tmp/a"])).not.toBe(writeFingerprint(["tmp/b"]));

    const { meta, session } = makeHarness();
    const first = enqueueWriteApproval(session, "develop", [candidate("tmp/a"), candidate("tmp/b")]);
    const dup = enqueueWriteApproval(session, "develop", [candidate("tmp/b"), candidate("tmp/a")]); // reordered
    expect(first.queued).toBe(true);
    expect(dup.queued).toBe(false);
    expect(dup.fingerprint).toBe(first.fingerprint);
    expect(Object.keys(meta.pendingOwnerApprovals ?? {})).toHaveLength(1);

    // Distinct target set accumulates a SECOND entry.
    const other = enqueueWriteApproval(session, "develop", [candidate("tmp/c")]);
    expect(other.queued).toBe(true);
    expect(Object.keys(meta.pendingOwnerApprovals ?? {})).toHaveLength(2);

    const entry = meta.pendingOwnerApprovals?.[first.fingerprint];
    expect(entry?.kind).toBe("write");
    if (entry?.kind === "write") {
      expect(entry.targets.sort()).toEqual(["tmp/a", "tmp/b"]);
      expect(entry.stage).toBe("develop");
      expect(entry.pathClass).toBe("tmp");
      expect(entry.pipelineId).toBe("pipe-218-write");
    }
    expect(audits.some((a) => a.event === "write_approval_queued")).toBe(true);
  });

  it("block reason carries the fingerprint + the do-NOT-retry instruction (case 2)", () => {
    const reason = writeApprovalBlockReason([candidate("tmp/a"), candidate("tmp/b")], "w:deadbeefcafe1234", "develop");
    expect(reason).toContain("w:deadbeefcafe1234");
    expect(reason).toContain("do NOT retry");
    expect(reason).toContain("tmp/a");
    expect(reason).toContain("develop");
  });

  it("long batches fold the menu list to 5 targets + …+N", async () => {
    const { meta, session, ctx, menus } = makeHarness();
    for (let i = 0; i < 7; i++) {
      enqueueWriteApproval(session, "develop", [candidate(`tmp/big${i}`)]);
    }
    await consumePendingOwnerApprovalDetailed(ctx as never, makeTestConfig());
    expect(menus.length).toBe(1);
    expect(menus[0]!.title).toContain("…+2");
    expect(menus[0]!.options).toEqual(["Deny (block)", "Allow for this session"]);
    void meta;
  });
});

describe("owner batched write menu (case 3 / 3b)", () => {
  it("Allow for this session → all targets allowed, denials cleared, resume hint notified, entries removed", async () => {
    const config = makeTestConfig();
    const { meta, session, ctx, notices } = makeHarness(
      { whitelistMissDenials: { stage: "develop", counts: { tmp: 2 }, updatedAt: Date.now() } },
      ["Allow for this session"],
    );
    const f1 = enqueueWriteApproval(session, "develop", [candidate("tmp/a")]).fingerprint;
    const f2 = enqueueWriteApproval(session, "develop", [candidate("tmp/b"), candidate("other/c")]).fingerprint;

    const result = await consumePendingOwnerApprovalDetailed(ctx as never, config);
    expect(result).toEqual({ outcome: "approved", kind: "write", fingerprint: f1 });

    // BOTH entries consumed by the ONE menu; ALL merged targets allowed.
    expect(meta.pendingOwnerApprovals ?? {}).toEqual({});
    expect(meta.sessionAllowedWritePaths?.sort()).toEqual(["other/c", "tmp/a", "tmp/b"]);
    expect(meta.whitelistMissDenials).toBeUndefined(); // any Allow clears the breaker
    expect(notices.some((n) => n.includes("/pipeline-resume") && n.includes("develop"))).toBe(true);

    const approved = audits.find((a) => a.event === "write_approval_approved");
    expect(approved).toBeDefined();
    expect(approved!.message).toMatchObject({
      stage: "develop",
      count: "3",
      fingerprints: `${f1},${f2}`,
    });
  });

  it("3 same-stage entries → ONE menu; other-stage writes stay queued untouched (case 3b)", async () => {
    const config = makeTestConfig();
    const { meta, session, ctx, menus } = makeHarness(undefined, ["Allow for this session"]);
    enqueueWriteApproval(session, "develop", [candidate("tmp/x1")]);
    enqueueWriteApproval(session, "develop", [candidate("tmp/x2")]);
    enqueueWriteApproval(session, "develop", [candidate("tmp/x3")]);
    const foreign = enqueueWriteApproval(session, "fix", [candidate("tmp/foreign")]);

    const result = await consumePendingOwnerApprovalDetailed(ctx as never, config);
    expect(result.outcome).toBe("approved");
    expect(menus.length).toBe(1); // F.4-2: three blocked calls → ONE owner ask
    expect(menus[0]!.title).toContain("tmp/x1");
    expect(menus[0]!.title).toContain("tmp/x3");
    expect(menus[0]!.title).not.toContain("tmp/foreign"); // other stage NEVER in this menu

    const remaining = meta.pendingOwnerApprovals ?? {};
    expect(Object.keys(remaining)).toEqual([foreign.fingerprint]); // fix entry untouched
    expect(remaining[foreign.fingerprint]?.stage).toBe("fix");

    // Same paths are now session-allowed: a follow-up consume finds nothing to ask.
    const again = await consumePendingOwnerApprovalDetailed(ctx as never, config);
    expect(again.outcome).toBe("none");
  });

  it("no select → fail-closed and visible: entries stay queued, owner_approval_no_ui (kind write)", async () => {
    const config = makeTestConfig();
    const { meta, session, ctx } = makeHarness();
    delete (ctx.ui as { select?: unknown }).select;
    enqueueWriteApproval(session, "develop", [candidate("tmp/a")]);

    const result = await consumePendingOwnerApprovalDetailed(ctx as never, config);
    expect(result.outcome).toBe("no_ui");
    expect(result.kind).toBe("write");
    expect(Object.keys(meta.pendingOwnerApprovals ?? {})).toHaveLength(1); // NOT dropped
    expect(audits.some((a) => a.event === "owner_approval_no_ui")).toBe(true);
  });
});

describe("selection order across kind/stage (case 3c)", () => {
  it("review settle consumes the COMMAND (fix write is older but stays); fix settle consumes the write batch", async () => {
    const config = makeTestConfig();
    const { meta, session, ctx, menus } = makeHarness(
      { currentStage: "review" },
      ["Allow for this session", "Allow for this session"], // command menu, then write menu
    );
    // OLDER fix-stage WRITE entry …
    const writeEntry = enqueueWriteApproval(session, "fix", [candidate("tmp/late")]);
    // … and a NEWER review-stage COMMAND entry.
    session.updateMeta({
      pendingOwnerApprovals: {
        ...(ctx.session.getMeta()?.pendingOwnerApprovals ?? {}),
        "c:cmd1": {
          kind: "command", command: "rm -rf node_modules", stage: "review",
          requestedAt: Date.now() + 1000, attempts: 0, pipelineId: "pipe-218-write",
        },
      },
    });

    // Review settle: current stage has NO writes → oldest COMMAND (not the older
    // foreign-stage write — selection order is stage-batched, then command).
    const r1 = await consumePendingOwnerApprovalDetailed(ctx as never, config);
    expect(r1.kind).toBe("command");
    expect(menus[0]!.title).toContain("destructive command");
    // fix write SURVIVES untouched.
    expect(Object.keys(meta.pendingOwnerApprovals ?? {})).toEqual([writeEntry.fingerprint]);

    // Fix settle: the write batch is consumed for its own stage now.
    meta.currentStage = "fix";
    const r2 = await consumePendingOwnerApprovalDetailed(ctx as never, config);
    expect(r2.kind).toBe("write");
    expect(r2.outcome).toBe("approved");
    expect(meta.pendingOwnerApprovals ?? {}).toEqual({});
    expect(meta.sessionAllowedWritePaths).toContain("tmp/late");
  });

  it("current-stage writes are preferred over an OLDER command entry", async () => {
    const config = makeTestConfig();
    const { session, ctx, menus } = makeHarness({ currentStage: "develop" }, ["Allow for this session"]);
    session.updateMeta({
      pendingOwnerApprovals: {
        "c:cmd0": {
          kind: "command", command: "sudo reboot", stage: "develop",
          requestedAt: 1, attempts: 0, pipelineId: "pipe-218-write", // ancient
        },
      },
    });
    enqueueWriteApproval(session, "develop", [candidate("tmp/a")]);

    const r = await consumePendingOwnerApprovalDetailed(ctx as never, config);
    expect(r.kind).toBe("write"); // step 2 beats step 3 regardless of age
    expect(menus[0]!.title).toContain("writes");
  });
});

describe("Deny breaker via the owner menu (case 4)", () => {
  it("Deny ×3 (same stage+pathClass) → per-entry +1, denial_overflow + freeze at the threshold", async () => {
    const config = makeTestConfig();
    // Every consume answers "Deny (block)"; a trailing decision-menu call gets
    // undefined (dismissed → the freeze simply stays in place).
    const { meta, session, ctx, menus } = makeHarness(
      undefined,
      ["Deny (block)", "Deny (block)", "Deny (block)"],
    );
    for (let i = 0; i < 3; i++) {
      // DISTINCT fingerprints — each settle consumes a new batch of one entry.
      enqueueWriteApproval(session, "develop", [candidate(`tmp/d${i}`)]);
      const r = await consumePendingOwnerApprovalDetailed(ctx as never, config);
      expect(r.outcome).toBe("denied");
      expect(r.kind).toBe("write");
    }
    // Three denies, ONE breaker unit each (deduped per distinct pathClass).
    expect(meta.whitelistMissDenials?.counts["tmp"]).toBe(3);
    expect(isFrozen(meta)).toBe(true);
    expect(audits.some((a) => a.event === "whitelist_miss_denial_overflow")).toBe(true);
    expect(audits.filter((a) => a.event === "write_approval_denied")).toHaveLength(3);
    expect(menus.filter((m) => m.title.includes("request these writes")).length).toBe(3);
  });

  // ── 218 review #4: a MERGED batch denies EVERY class it covers ───────────
  it("Deny of a multi-class batch counts EVERY pathClass, not just the first", async () => {
    const config = makeTestConfig();
    const { meta, session, ctx } = makeHarness(undefined, ["Deny (block)"]);
    // One batch spanning TWO coarse classes: `tmp/…` and `other/…`.
    const enq = enqueueWriteApproval(session, "develop", [
      candidate("tmp/m0"),
      candidate("other/m1"),
      candidate("tmp/m2"),
    ]);
    expect(enq.queued).toBe(true);
    // The stored entry carries the FULL deduped class set (display keeps the first).
    const fp = Object.keys(meta.pendingOwnerApprovals ?? {})[0]!;
    const entry = meta.pendingOwnerApprovals![fp]!;
    expect(entry.kind).toBe("write");
    if (entry.kind === "write") {
      expect(entry.pathClass).toBe("tmp");
      expect(entry.pathClasses).toEqual(["tmp", "other"]);
    }

    const r = await consumePendingOwnerApprovalDetailed(ctx as never, config);
    expect(r.outcome).toBe("denied");

    // BOTH classes took a strike (pre-fix only `tmp` did — the `other`
    // paths' stage-scoped pressure was silently lost).
    expect(meta.whitelistMissDenials?.counts["tmp"]).toBe(1);
    expect(meta.whitelistMissDenials?.counts["other"]).toBe(1);
    // Period stamp + audit class list make the record reviewable.
    expect(meta.whitelistMissDenials?.pipelineId).toBe("pipe-218-write");
    const denied = audits.find((a) => a.event === "write_approval_denied");
    expect(denied?.message?.classes).toBe("tmp,other");
    const queued = audits.find((a) => a.event === "write_approval_queued");
    expect(queued?.message?.classes).toBe("tmp,other");
  });

  it("×2 denies stay below the breaker; a stage switch recounts from zero (self-invalidating)", async () => {
    const config = makeTestConfig();
    const { meta, session, ctx } = makeHarness(undefined, ["Deny (block)", "Deny (block)", "Deny (block)"]);
    enqueueWriteApproval(session, "develop", [candidate("tmp/e0")]);
    await consumePendingOwnerApprovalDetailed(ctx as never, config);
    enqueueWriteApproval(session, "develop", [candidate("tmp/e1")]);
    await consumePendingOwnerApprovalDetailed(ctx as never, config);
    expect(isFrozen(meta)).toBe(false);
    expect(meta.whitelistMissDenials?.counts["tmp"]).toBe(2);

    // Stage transition: the develop pressure must NOT carry into fix.
    meta.currentStage = "fix";
    enqueueWriteApproval(session, "fix", [candidate("tmp/e2")]);
    const r = await consumePendingOwnerApprovalDetailed(ctx as never, config);
    expect(r.outcome).toBe("denied");
    expect(meta.whitelistMissDenials?.stage).toBe("fix");
    expect(meta.whitelistMissDenials?.counts["tmp"]).toBe(1); // recounted
    expect(isFrozen(meta)).toBe(false);
  });
});

// ── 218 round-3 review #1 (Medium): a DISMISSAL is NOT a human Deny ──────
describe("write-menu dismissal (Esc / auto-dismiss / select error) keeps the queue", () => {
  it("Esc / auto-dismiss (undefined choice) → entries KEEP, breaker untouched, no freeze", async () => {
    const config = makeTestConfig();
    // Script EMPTY: the harness select resolves `undefined` — the 173 C11
    // confirmed host shapes (user Esc, streaming-output auto-dismiss).
    const { meta, session, ctx, notices } = makeHarness(undefined, []);
    const enq = enqueueWriteApproval(session, "develop", [candidate("tmp/dis1")]);

    const r = await consumePendingOwnerApprovalDetailed(ctx as never, config);
    expect(r).toEqual({ outcome: "dismissed", kind: "write", fingerprint: enq.fingerprint });

    // THE defect this review fixed: dismissals no longer feed the breaker…
    expect(meta.whitelistMissDenials).toBeUndefined();
    expect(isFrozen(meta)).toBe(false);
    // …and the request is no longer silently dropped (contrast the old
    // removeBatch + write_approval_denied path that mimicked a human rejection).
    expect(Object.keys(meta.pendingOwnerApprovals ?? {})).toEqual([enq.fingerprint]);

    const dismissed = audits.find((a) => a.event === "write_approval_dismissed");
    expect(dismissed).toBeDefined();
    expect(dismissed!.message).toMatchObject({ stage: "develop", reason: "dismissed", fingerprints: enq.fingerprint });
    expect(dismissed!.level).toBe("warn");
    expect(audits.some((a) => a.event === "write_approval_denied")).toBe(false);
    expect(notices.some((n) => n.includes("stay queued"))).toBe(true);
  });

  it("3 dismissals across 3 distinct target sets → ZERO breaker pressure, nothing dropped (incident shape)", async () => {
    const config = makeTestConfig();
    const { meta, session, ctx } = makeHarness(undefined, []); // every menu → undefined
    for (let i = 0; i < 3; i++) {
      enqueueWriteApproval(session, "develop", [candidate(`tmp/ds${i}`)]);
      const r = await consumePendingOwnerApprovalDetailed(ctx as never, config);
      expect(r.outcome).toBe("dismissed");
    }
    // Pre-fix this EXACT sequence (3 × undefined) triggered violation_overflow.
    expect(meta.whitelistMissDenials).toBeUndefined();
    expect(isFrozen(meta)).toBe(false);
    expect(audits.some((a) => a.event === "whitelist_miss_denial_overflow")).toBe(false);
    // All three batches survive for a turn that delivers a real choice.
    expect(Object.keys(meta.pendingOwnerApprovals ?? {})).toHaveLength(3);
  });

  it("unknown option string → dismissed (kept queued), never a Deny", async () => {
    const config = makeTestConfig();
    const { meta, session, ctx } = makeHarness(undefined, ["stale-host-label"]);
    const enq = enqueueWriteApproval(session, "develop", [candidate("tmp/unk")]);
    const r = await consumePendingOwnerApprovalDetailed(ctx as never, config);
    expect(r.outcome).toBe("dismissed");
    expect(meta.whitelistMissDenials).toBeUndefined();
    expect(Object.keys(meta.pendingOwnerApprovals ?? {})).toEqual([enq.fingerprint]);
  });

  it("select throws → error-level write_approval_dismissed (reason select_error), entries kept, no throw", async () => {
    const config = makeTestConfig();
    const { meta, session, ctx } = makeHarness(undefined, ["Allow for this session"]); // script irrelevant
    (ctx.ui as { select?: unknown }).select = async () => {
      throw new Error("host stream reset");
    };
    const enq = enqueueWriteApproval(session, "develop", [candidate("tmp/boom")]);

    const r = await consumePendingOwnerApprovalDetailed(ctx as never, config);
    expect(r.outcome).toBe("dismissed");
    expect(meta.whitelistMissDenials).toBeUndefined();
    expect(isFrozen(meta)).toBe(false);
    expect(Object.keys(meta.pendingOwnerApprovals ?? {})).toEqual([enq.fingerprint]);

    const dismissed = audits.find((a) => a.event === "write_approval_dismissed");
    expect(dismissed!.message?.reason).toBe("select_error");
    expect(dismissed!.message?.error).toContain("host stream reset");
    expect(dismissed!.level).toBe("error");
  });

  it("explicit Deny still works AFTER dismissals mixed in (tri-state not defanged)", async () => {
    const config = makeTestConfig();
    const { meta, session, ctx } = makeHarness(undefined, [undefined, "Deny (block)"]);
    enqueueWriteApproval(session, "develop", [candidate("tmp/mix1")]);
    const d1 = await consumePendingOwnerApprovalDetailed(ctx as never, config); // dismissed → kept
    expect(d1.outcome).toBe("dismissed");
    enqueueWriteApproval(session, "develop", [candidate("tmp/mix2")]); // batch now covers BOTH
    const d2 = await consumePendingOwnerApprovalDetailed(ctx as never, config); // explicit Deny
    expect(d2.outcome).toBe("denied");
    // ONE strike (per distinct class), not two — only the explicit Deny counted.
    expect(meta.whitelistMissDenials?.counts["tmp"]).toBe(1);
    expect(isFrozen(meta)).toBe(false);
  });
});

describe("legacy 217 compatibility (case 5)", () => {
  it("entries WITHOUT kind (historical) still consume through the command branch", async () => {
    const config = makeTestConfig();
    const { meta, ctx } = makeHarness(undefined, ["Allow for this session"]);
    // Raw legacy shape (217, pre-218): no kind field at all.
    meta.pendingOwnerApprovals = {
      "legacy-fp": {
        command: "git push --force", stage: "develop",
        requestedAt: Date.now(), attempts: 0, pipelineId: "pipe-218-write",
      },
    };

    const outcome = await consumeOnePendingOwnerApproval(ctx as never, config);
    expect(outcome).toBe("approved"); // legacy string API unchanged
    expect(meta.sessionAllowedCommands).toContain("git push --force");
    expect(meta.pendingOwnerApprovals ?? {}).toEqual({});
  });

  it("cross-pipeline residue is dropped before ANY consumption (217 review issue 3 regression)", async () => {
    const config = makeTestConfig();
    const { meta, ctx, menus } = makeHarness();
    meta.pendingOwnerApprovals = {
      "stale-w": {
        kind: "write", targets: ["tmp/a"], pathClass: "tmp", categories: ["whitelist_miss"],
        stage: "develop", requestedAt: 1, attempts: 0, pipelineId: "pipe-OTHER",
      },
    };

    const r = await consumePendingOwnerApprovalDetailed(ctx as never, config);
    expect(r.outcome).toBe("none");
    expect(menus.length).toBe(0); // stale residue never pops a menu
    expect(meta.pendingOwnerApprovals ?? {}).toEqual({});
    expect(audits.some((a) => a.event === "owner_approval_stale_dropped")).toBe(true);
  });
});
