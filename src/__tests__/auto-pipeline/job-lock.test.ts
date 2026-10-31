/**
 * 219 Phase 2: the PROCESS-level single-instance lock (`config-overlay.ts`).
 *
 * Key behaviors:
 * - One job at a time, even inside the same process (B6): a second acquire
 *   with a different jobId is `busy`, so two `applyOverlay` calls can never
 *   interleave and cross-restore each other's snapshots.
 * - Chain continuation in the same process adopts the recorded token
 *   (`adopted: true`) instead of minting a second token (M8).
 * - A dead holder pid is reclaimed (audited `stale_reclaimed`) — a permanent
 *   `busy` state cannot exist.
 * - `takeover: true` requires a MATCHING token while the holder is alive;
 *   anything else is `stale_token` (never yank a live lock).
 * - `isAutoJobActive` / `getActiveJobId` read the same in-process fact that a
 *   successful acquire sets, and `releaseJobLock` is idempotent.
 */
import { describe, it, expect, beforeEach, afterEach, spyOn } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";
import {
  acquireJobLock,
  getActiveJobId,
  isAutoJobActive,
  readJobLock,
  releaseJobLock,
  __resetAutoJobLockForTests,
  type LockInfo,
} from "../../core/auto-pipeline/config-overlay";
import { AUTO_PIPELINE_LOCK_FILE } from "../../constants";
import { __setSafeWriteAuditLogOverride } from "../../utils/auditLog";

const DEAD_PID = 4194303; // Above the usual pid_max on macOS/Linux — never alive.

let ROOT: string;
let auditEvents: string[];
let errorSpy: ReturnType<typeof spyOn>;
let warnSpy: ReturnType<typeof spyOn>;

function lockPath(): string {
  return path.join(ROOT, AUTO_PIPELINE_LOCK_FILE);
}

function writeRawLock(lock: Partial<LockInfo> | string): void {
  fs.mkdirSync(path.dirname(lockPath()), { recursive: true });
  fs.writeFileSync(
    lockPath(),
    typeof lock === "string" ? lock : JSON.stringify(lock, null, 2),
    "utf8",
  );
}

beforeEach(() => {
  ROOT = fs.mkdtempSync(path.join(tmpdir(), "pi-219-lock-"));
  __resetAutoJobLockForTests();
  auditEvents = [];
  errorSpy = spyOn(console, "error").mockImplementation(() => undefined);
  warnSpy = spyOn(console, "warn").mockImplementation(() => undefined);
  __setSafeWriteAuditLogOverride(async (stage) => {
    auditEvents.push(stage);
  });
});

afterEach(() => {
  __setSafeWriteAuditLogOverride(null);
  errorSpy.mockRestore();
  warnSpy.mockRestore();
  __resetAutoJobLockForTests();
  fs.rmSync(ROOT, { recursive: true, force: true });
});

describe("job-lock — fresh acquire / release", () => {
  it("mints a token, installs the lock and flips isAutoJobActive", () => {
    expect(isAutoJobActive()).toBe(false);
    const result = acquireJobLock({ projectRoot: ROOT, jobId: "alpha" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.adopted).toBe(false);
    expect(result.token.length).toBeGreaterThan(10);
    expect(isAutoJobActive()).toBe(true);
    expect(getActiveJobId()).toBe("alpha");

    const onDisk = readJobLock(ROOT);
    expect(onDisk?.token).toBe(result.token);
    expect(onDisk?.pid).toBe(process.pid);
  });

  it("release removes the lock file and clears the in-process fact (idempotent)", () => {
    const acquired = acquireJobLock({ projectRoot: ROOT, jobId: "alpha" });
    if (!acquired.ok) throw new Error("acquire failed");
    releaseJobLock({ projectRoot: ROOT, token: acquired.token });
    expect(isAutoJobActive()).toBe(false);
    expect(readJobLock(ROOT)).toBeNull();

    // Second release only warns, never throws.
    releaseJobLock({ projectRoot: ROOT, token: acquired.token });
    expect(warnSpy.mock.calls.length).toBeGreaterThan(0);
  });

  it("release with a mismatched token leaves the lock untouched", () => {
    const acquired = acquireJobLock({ projectRoot: ROOT, jobId: "alpha" });
    if (!acquired.ok) throw new Error("acquire failed");
    releaseJobLock({ projectRoot: ROOT, token: "someone-else" });
    expect(isAutoJobActive()).toBe(true);
    expect(readJobLock(ROOT)?.token).toBe(acquired.token);
  });
});

describe("job-lock — B6: one active job per process", () => {
  it("a second acquire with a different jobId is busy and keeps the first lock", () => {
    const first = acquireJobLock({ projectRoot: ROOT, jobId: "alpha" });
    if (!first.ok) throw new Error("acquire failed");
    const second = acquireJobLock({ projectRoot: ROOT, jobId: "beta" });
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.reason).toBe("busy");
    if (second.reason !== "busy") return;
    expect(second.holder.jobId).toBe("alpha");
    expect(readJobLock(ROOT)?.token).toBe(first.token);
    expect(getActiveJobId()).toBe("alpha");
  });

  it("same jobId in the same process adopts the recorded token (M8 chain continuation)", () => {
    const first = acquireJobLock({ projectRoot: ROOT, jobId: "alpha" });
    if (!first.ok) throw new Error("acquire failed");
    const adopt = acquireJobLock({ projectRoot: ROOT, jobId: "alpha" });
    expect(adopt.ok).toBe(true);
    if (!adopt.ok) return;
    expect(adopt.adopted).toBe(true);
    expect(adopt.token).toBe(first.token);
  });

  it("rejects an unsafe jobId without touching the lock file", () => {
    const result = acquireJobLock({ projectRoot: ROOT, jobId: "../escape" });
    expect(result.ok).toBe(false);
    expect(readJobLock(ROOT)).toBeNull();
  });
});

describe("job-lock — stale holder reclaim (M8)", () => {
  it("dead pid + no token → takeover succeeds and audits stale_reclaimed", async () => {
    writeRawLock({ token: "old-token", jobId: "alpha", pid: DEAD_PID, startedAt: 1 });
    const result = acquireJobLock({ projectRoot: ROOT, jobId: "alpha", takeover: true });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.token).not.toBe("old-token");
    expect(readJobLock(ROOT)?.pid).toBe(process.pid);
    // The async audit is fire-and-forget; let the microtask run.
    await Promise.resolve();
    expect(auditEvents).toContain("pipeline_auto_lock");
  });

  it("dead pid without takeover also reclaims (no permanent busy state)", () => {
    writeRawLock({ token: "old-token", jobId: "alpha", pid: DEAD_PID, startedAt: 1 });
    const result = acquireJobLock({ projectRoot: ROOT, jobId: "alpha" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.adopted).toBe(true);
  });

  it("dead pid + matching token keeps the same token (crash-restart rule 1)", () => {
    writeRawLock({ token: "crash-token", jobId: "alpha", pid: DEAD_PID, startedAt: 1 });
    const result = acquireJobLock({
      projectRoot: ROOT,
      jobId: "alpha",
      token: "crash-token",
      takeover: true,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.token).toBe("crash-token");
  });
});

describe("job-lock — live foreign holder (M8 rule 3)", () => {
  it("alive pid in another process → busy without takeover", () => {
    writeRawLock({ token: "foreign", jobId: "alpha", pid: 1, startedAt: 1 });
    const result = acquireJobLock({ projectRoot: ROOT, jobId: "alpha" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("busy");
    expect(isAutoJobActive()).toBe(false);
  });

  it("alive pid + wrong token + takeover → stale_token, lock untouched", () => {
    writeRawLock({ token: "foreign", jobId: "alpha", pid: 1, startedAt: 1 });
    const result = acquireJobLock({
      projectRoot: ROOT,
      jobId: "alpha",
      token: "not-the-holder",
      takeover: true,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("stale_token");
    expect(readJobLock(ROOT)?.pid).toBe(1);
    expect(isAutoJobActive()).toBe(false);
  });

  it("alive pid + matching token + takeover → adopted", () => {
    writeRawLock({ token: "foreign", jobId: "alpha", pid: 1, startedAt: 1 });
    const result = acquireJobLock({
      projectRoot: ROOT,
      jobId: "alpha",
      token: "foreign",
      takeover: true,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.adopted).toBe(true);
    expect(result.token).toBe("foreign");
  });
});

describe("job-lock — corrupt lock file", () => {
  it("corrupt JSON is treated as no lock + error log", () => {
    writeRawLock("{ not json");
    expect(readJobLock(ROOT)).toBeNull();
    expect(errorSpy.mock.calls.length).toBeGreaterThan(0);
    // And acquiring proceeds as if there were no lock.
    const result = acquireJobLock({ projectRoot: ROOT, jobId: "alpha" });
    expect(result.ok).toBe(true);
  });

  it("foreign schema / unsafe jobId is treated as no lock + error log", () => {
    writeRawLock({ token: "t", jobId: "../x", pid: process.pid, startedAt: 1 });
    expect(readJobLock(ROOT)).toBeNull();
    expect(errorSpy.mock.calls.length).toBeGreaterThan(0);
  });
});
