/**
 * 217 Phase 0 (T0.x): owner-wake delivery regression.
 *
 * Reproduces the 217 incident shape (`pipe-1792915432897-hxekq4`): the
 * `review → fix` transition was already advanced, `pendingSpawns[fix]` was
 * queued, a review child observed a terminal event — the owner was NEVER
 * woken (`owner_wake_skipped reason=dedup` × 10) because the wake was stamped
 * before delivery and aimed at the last hook runner (the review child).
 *
 * Plan acceptance ①②④:
 * ① in a two-session shape the delivery lands on the OWNER handle and the
 *    child's handle is never selected;
 * ② a FAILED delivery does NOT consume the `terminalWake` stamp and emits at
 *    most one `owner_wake_undeliverable` per (pipelineId, stage) per window;
 * ③ (dedup) repeated terminal events after a delivered wake stay deduped
 *    exactly as before (the 216 semantics are untouched);
 * ④ the owner settle chain (`consumePendingSpawns`) still consumes the queued
 *    `fix` entry once the owner is woken.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  registerOwnerDelivery,
  unregisterOwnerDelivery,
  __resetOwnerDeliveryRegistry,
  type OwnerDeliveryHandle,
} from "../../core/owner-delivery-registry";
import { deliverOwnerWake } from "../../core/owner-delivery";
import {
  setOwnerWakeDeps,
  registerOwnerWakeObserver,
  type OwnerWakeDeps,
} from "../../core/owner-wake";
import { consumePendingSpawns } from "../../utils/subagent-rpc";
import { registerTerminal, __resetLifecycleRegistry } from "../../utils/subagent-lifecycle-registry";
import { __resetMemoryThrottle } from "../../utils/audit-throttle";
import { initAuditLog, safeWriteAuditLog, __resetAuditDirPath, __resetAuditRoutingState } from "../../utils/auditLog";
import { makeTestConfig, makeTestMeta, deployDispatchAssets } from "../helpers";
import type { PipelineConfig, SessionMeta } from "../../types";

// ─── Harness ──────────────────────────────────────────────────────────────────

let seq = 0;
const nextPid = () => `pipe-217-wake-${Date.now()}-${++seq}`;

/** Concatenate EVERY audit file under the case root (pipeline AND system). */
function readAllAudit(root: string): string {
  const base = join(root, ".pi", "audit");
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else out.push(fs.readFileSync(p, "utf-8"));
    }
  };
  if (fs.existsSync(base)) walk(base);
  return out.join("\n");
}

interface SessionShape {
  sessionFile: string;
  isChild: boolean;
  /** followUp messages accepted by THIS session's raw sender. */
  sent: string[];
}

/**
 * A registered delivery handle mirroring the T0.4 production wiring: the raw
 * sender records into `sent` and reports acceptance truthfully.
 */
function makeOwnershipHandle(shape: SessionShape, getMeta: () => SessionMeta | undefined): OwnerDeliveryHandle {
  return {
    sessionFile: shape.sessionFile,
    isChild: shape.isChild,
    getMeta,
    sendFollowUp: (summary) => { shape.sent.push(summary); return true; },
    notify: () => {},
    audit: () => {},
  };
}

interface WakeHarness {
  root: string;
  config: PipelineConfig;
  meta: SessionMeta;
  owner: SessionShape;
  reviewChild: SessionShape;
  cleanup: () => void;
}

/**
 * Create the incident state: shared meta (both sessions read the same
 * pipeline state), the review child ran the LAST hook (registered last), and
 * the fix stage was already advanced with a queued spawn.
 */
async function makeIncidentHarness(incidentMeta?: Partial<SessionMeta>): Promise<WakeHarness> {
  const root = join(tmpdir(), `pi-217-wake-${Date.now()}-${seq}`);
  await mkdir(join(root, ".pi", "audit"), { recursive: true });
  const config = makeTestConfig({ projectRoot: root });
  deployDispatchAssets(config); // every stage agent ships name: test-agent
  await initAuditLog(config);
  seq++;
  const meta = makeTestMeta({
    currentStage: "fix",
    pipelineId: nextPid(),
    // The review child is the terminal observer; the fix spawn is queued.
    activeSpawns: { review: { agentId: "agent-review", agentName: "test-agent", startedAt: Date.now() } },
    pendingSpawns: { fix: { agentName: "test-agent", requestedAt: Date.now(), attempts: 0 } },
    ...(incidentMeta ?? {}),
  });

  const owner: SessionShape = { sessionFile: "/sessions/owner.jsonl", isChild: false, sent: [] };
  const reviewChild: SessionShape = { sessionFile: "/sessions/review-child.jsonl", isChild: true, sent: [] };
  const getMeta = () => meta;

  return {
    root,
    config,
    meta,
    owner,
    reviewChild,
    cleanup: () => {
      for (const shape of [owner, reviewChild]) unregisterOwnerDelivery(shape.sessionFile);
    },
  };
}

/**
 * Mirror of the T0.4 index.ts writer-side wiring (owner-scoped): module deps
 * route delivery through the registry with the raw followUp as fallback.
 */
function installOwnerWriterSide(meta: SessionMeta): void {
  const rawFollowUp = (_summary: string): boolean => false; // unavailable in tests
  setOwnerWakeDeps({
    getMeta: () => meta,
    updateMeta: (patch) => { Object.assign(meta, patch); },
    sendFollowUp: (summary) => {
      void deliverOwnerWake(summary, meta, () => rawFollowUp(summary)).delivered;
    },
    deliver: (summary, m) => deliverOwnerWake(summary, m, () => rawFollowUp(summary)),
    // Production-faithful: audits go through the real (disk) audit subsystem.
    audit: (event, payload) => { void safeWriteAuditLog(event, payload as Record<string, string | boolean>); },
    syncStatusBar: () => {},
  });
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("217 regression: owner-wake delivery targets and stamp semantics", () => {
  let cleanupObserver: () => void;

  beforeEach(() => {
    __resetLifecycleRegistry();
    __resetOwnerDeliveryRegistry();
    __resetMemoryThrottle();
    cleanupObserver = registerOwnerWakeObserver();
  });

  afterEach(() => {
    if (cleanupObserver) cleanupObserver();
    __resetAuditRoutingState();
    __resetAuditDirPath();
    __resetLifecycleRegistry();
    __resetOwnerDeliveryRegistry();
    __resetMemoryThrottle();
  });

  it("①③④ owner first, child last: delivery lands on the OWNER; dedup holds; settle consumes fix", async () => {
    const h = await makeIncidentHarness();
    try {
      // Owner registers FIRST (owner hook ran first), review child LAST
      // (the child ran the hook that saw the terminal event — 217 incident).
      const ownerHandle = makeOwnershipHandle(h.owner, () => h.meta);
      registerOwnerDelivery(ownerHandle);
      const childHandle = makeOwnershipHandle(h.reviewChild, () => h.meta);
      registerOwnerDelivery(childHandle);

      installOwnerWriterSide(h.meta);

      const stamps: { atDeliveredCount?: number } = {};
      const originalUpdate = h.meta;
      // Track stamp time vs delivery: wrap deps.updateMeta to observe order.
      setOwnerWakeDeps({
        getMeta: () => h.meta,
        updateMeta: (patch) => {
          if (patch.terminalWake) stamps.atDeliveredCount = h.owner.sent.length;
          Object.assign(originalUpdate, patch);
        },
        sendFollowUp: () => {},
        deliver: (summary, m) => deliverOwnerWake(summary, m, () => false),
        // Production-faithful: audits go through the real (disk) subsystem.
        audit: (event, payload) => { void safeWriteAuditLog(event, payload as Record<string, string | boolean>); },
        syncStatusBar: () => {},
      });

      // Terminal event observed by the review child.
      registerTerminal("test-agent", "agent-review", "terminal", "completed", "review", h.meta.pipelineId);

      // ① The OWNER received the wake, the child never did.
      expect(h.owner.sent).toHaveLength(1);
      expect(h.owner.sent[0]).toContain("agent-review");
      expect(h.reviewChild.sent).toHaveLength(0);

      // 214/217 core: the stamp is written AFTER successful delivery...
      expect(stamps.atDeliveredCount).toBe(1);
      expect(h.meta.terminalWake).toMatchObject({ agentId: "agent-review", stage: "review", visitOrder: 0 });

      // ③ A repeated terminal event hits the dedup guard — zero extra sends.
      registerTerminal("test-agent", "agent-review", "terminal", "completed", "review", h.meta.pipelineId);
      expect(h.owner.sent).toHaveLength(1);
      await new Promise((r) => setTimeout(r, 10));
      expect(readAllAudit(h.root)).toContain("owner_wake_skipped");

      // ④ The owner settle chain consumes the queued fix entry.
      const session = {
        getMeta: () => h.meta,
        updateMeta: (patch: Partial<SessionMeta>) => { Object.assign(h.meta, patch); return h.meta; },
      };
      const ownerPi = { sendUserMessage: (msg: string) => { h.owner.sent.push(msg); } };
      const consumed = await consumePendingSpawns(ownerPi, h.config, h.meta, {
        ui: { notify: () => {} },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        session: session as any,
      });
      expect(consumed).toEqual(["fix"]);
      expect(h.meta.pendingSpawns?.fix).toBeUndefined();
    } finally {
      h.cleanup();
    }
  });

  it("② failed delivery: no terminalWake stamp, at most one undeliverable audit per window", async () => {
    const h = await makeIncidentHarness({
      // Owner binding exists but its session is gone / unregistered.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      stageExecutorRun: { binding: { ownerSessionFile: "/sessions/owner.jsonl" } } as any,
    });
    try {
      // ONLY the child is registered here (owner went away) — mirrors the
      // incident where the owner handle was never installed.
      const childHandle = makeOwnershipHandle(h.reviewChild, () => h.meta);
      registerOwnerDelivery(childHandle);

      const rawFollowUp = (_summary: string): boolean => false; // raw send unavailable
      const audits: Array<{ event: string; payload: Record<string, unknown> }> = [];
      setOwnerWakeDeps({
        getMeta: () => h.meta,
        updateMeta: (patch) => { Object.assign(h.meta, patch); },
        sendFollowUp: (summary) => { void deliverOwnerWake(summary, h.meta, () => rawFollowUp(summary)).delivered; },
        deliver: (summary, m) => deliverOwnerWake(summary, m, () => rawFollowUp(summary)),
        audit: (event, payload) => {
          void safeWriteAuditLog(event, payload as Record<string, string | boolean>); audits.push({ event, payload });
        },
        syncStatusBar: () => {},
      });

      registerTerminal("test-agent", "agent-review", "terminal", "completed", "review", h.meta.pipelineId);

      // ② FAILED delivery: the dedup stamp must NOT be consumed...
      expect(h.meta.terminalWake).toBeUndefined();
      expect(h.reviewChild.sent).toHaveLength(0); // child never receives the wake

      const failAudit = audits.find((e) => e.event === "owner_wake_undeliverable");
      expect(failAudit).toBeDefined();
      expect(failAudit?.payload.targetSessionFile).toBe("/sessions/owner.jsonl");
      expect(failAudit?.payload.reason).toBe("owner_target_not_registered");

      // ...and repeated failures stay throttled to ONE audit per window.
      registerTerminal("test-agent", "agent-review", "terminal", "completed", "review", h.meta.pipelineId);
      expect(audits.filter((e) => e.event === "owner_wake_undeliverable")).toHaveLength(1);
    } finally {
      h.cleanup();
    }
  });
});
