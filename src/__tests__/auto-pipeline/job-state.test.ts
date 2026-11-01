/**
 * 219 Phase 1: auto-pipeline sidecar (`job-state.ts`).
 *
 * Key behaviors:
 * - atomic write (tmp + rename — no half file left behind when killed)
 * - corrupt JSON / foreign schemaVersion → null + error log (no throw)
 * - M3: idempotency (`hasFinalizeKey`) is decoupled from `docIndex`;
 *   finalize never advances `docIndex`
 * - H4: `noteDocStage` roundtrip; legacy sidecars missing the optional fields
 *   read back without throw and are never re-written
 * - `deriveLoopsSinceLastSeen` clamps counter rewinds to 0 (never negative)
 * - `listRunningJobs` is bounded and tolerant of unreadable entries
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  createJobState,
  deriveLoopsSinceLastSeen,
  hasFinalizeKey,
  isValidJobId,
  listRunningJobs,
  nextPendingDoc,
  noteDocStage,
  readJobState,
  resolveJobStatePath,
  writeJobState,
  type AutoJobState,
} from "../../core/auto-pipeline/job-state";
import { hashJobBytes } from "../../core/auto-pipeline/job-schema";
import { __setSafeWriteAuditLogOverride } from "../../utils/auditLog";
import * as fs from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";
import type { AutoJobDoc } from "../../core/auto-pipeline/job-schema";

let ROOT: string;
let diagnostics: string[];

const DOCS: AutoJobDoc[] = [{ doc: "docs/design/a.md" }, { doc: "docs/design/b.md" }];

function makeState(overrides?: Partial<AutoJobState>): AutoJobState {
  const state = createJobState({
    jobId: "alpha_loop",
    jobPath: path.join(ROOT, "docs", "jobs", "alpha_loop.yaml"),
    jobHash: hashJobBytes("version: 1\n"),
    docs: DOCS,
    ...overrides,
  });
  return { ...state, ...overrides };
}

beforeEach(() => {
  ROOT = fs.mkdtempSync(path.join(tmpdir(), "pi-219-jobstate-"));
  diagnostics = [];
  // Review round 2 (issue 6): diagnostics go to the AUDIT LOG, never console.
  __setSafeWriteAuditLogOverride(async (stage, message) => {
    if (stage !== "pipeline_auto_diagnostic") return;
    diagnostics.push(String((message as { action?: string } | undefined)?.action ?? ""));
  });
});

afterEach(() => {
  __setSafeWriteAuditLogOverride(null);
  fs.rmSync(ROOT, { recursive: true, force: true });
});

describe("job-state — create + write + read", () => {
  it("write → read roundtrip preserves fields including optional ones", async () => {
    const state = makeState();
    noteDocStage(state, 0, "develop", 111);
    await writeJobState(ROOT, state);
    const loaded = readJobState(ROOT, state.jobId);
    expect(loaded).not.toBeNull();
    expect(loaded?.docs[0]?.lastStage).toBe("develop");
    expect(loaded?.docs[0]?.lastStageStartedAt).toBe(111);
    expect(loaded?.docs[0]?.status).toBe("pending");
    expect(loaded?.schemaVersion).toBe(1);
  });

  it("legacy sidecar missing optional fields reads back without throw (no back-fill)", async () => {
    const legacy = {
      schemaVersion: 1,
      jobId: "alpha_loop",
      jobPath: "/x",
      jobHash: "h",
      jobTotalDocs: 2,
      docIndex: 0,
      status: "running",
      startedAt: 1,
      updatedAt: 1,
      counters: { totalLoops: 0, totalFreezes: 0, consecutiveVerifyFailures: 0, autoResumes: 0, finalGraceUsed: {} },
      docs: [{ doc: "docs/a.md", status: "running", updatedAt: 1 }],
    };
    const statePath = resolveJobStatePath(ROOT, "alpha_loop");
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    fs.writeFileSync(statePath, JSON.stringify(legacy), "utf8");
    const loaded = readJobState(ROOT, "alpha_loop");
    expect(loaded?.docs[0]?.lastStage).toBeUndefined();
    // Reading is read-only — no back-fill file rewrite.
    expect(fs.readFileSync(statePath, "utf8")).toBe(JSON.stringify(legacy));
  });

  it("atomicity: no tmp residue after write; a killed process cannot produce a half file", async () => {
    const state = makeState();
    await writeJobState(ROOT, state);
    const dir = path.dirname(resolveJobStatePath(ROOT, state.jobId));
    const entries = fs.readdirSync(dir).filter((name) => name !== "state.json");
    expect(entries).toHaveLength(0); // tmp + rename leaves nothing behind
    expect(readJobState(ROOT, state.jobId)?.status).toBe("idle");
  });

  it("write failure throws and logs (fail-closed contract)", async () => {
    const state = makeState({ jobId: ".." as string });
    // Invalid jobId path escapes the state dir; mkdir of the parent throws on
    // some systems — force a deterministic failure via a read-only parent.
    const readOnlyRoot = fs.mkdtempSync(path.join(tmpdir(), "pi-219-readonly-"));
    fs.mkdirSync(path.join(readOnlyRoot, ".pi"), { recursive: true });
    fs.chmodSync(path.join(readOnlyRoot, ".pi"), 0o444);
    await expect(writeJobState(readOnlyRoot, state)).rejects.toBeDefined();
    expect(diagnostics).toContain("sidecar_write_failed");
    fs.chmodSync(path.join(readOnlyRoot, ".pi"), 0o755);
    fs.rmSync(readOnlyRoot, { recursive: true, force: true });
  });

  it("corrupt JSON → null + error log; foreign schemaVersion → null", async () => {
    const statePath = resolveJobStatePath(ROOT, "alpha_loop");
    fs.mkdirSync(path.dirname(statePath), { recursive: true });

    fs.writeFileSync(statePath, "{ not json", "utf8");
    expect(readJobState(ROOT, "alpha_loop")).toBeNull();

    fs.writeFileSync(statePath, JSON.stringify({ ...makeState(), schemaVersion: 2 }), "utf8");
    expect(readJobState(ROOT, "alpha_loop")).toBeNull();
    expect(diagnostics).toContain("sidecar_corrupt");
    expect(diagnostics).toContain("sidecar_schema_unknown");
  });

  it("missing file → null WITHOUT error log", async () => {
    expect(readJobState(ROOT, "never-created")).toBeNull();
    expect(diagnostics).toHaveLength(0);
  });
});

describe("job-state — M3 semantics", () => {
  it("hasFinalizeKey is decoupled from docIndex (hit at any position)", () => {
    const state = makeState();
    state.docIndex = 0;
    state.docs[0]!.finalizeKey = "alpha:1:completed";
    state.docIndex = 1; // index advanced afterwards
    expect(hasFinalizeKey(state, "alpha:1:completed")).toBe(true);
    expect(hasFinalizeKey(state, "alpha:0:completed")).toBe(false);
  });

  it("nextPendingDoc returns the first pending entry; null when all consumed", () => {
    const state = makeState();
    expect(nextPendingDoc(state)).toEqual({ index: 0, doc: state.docs[0] });
    state.docs[0]!.status = "completed";
    expect(nextPendingDoc(state)).toEqual({ index: 1, doc: state.docs[1] });
    state.docs[1]!.status = "skipped";
    expect(nextPendingDoc(state)).toBeNull();
  });

  it("createJobState does NOT advance docIndex; finalize contract", () => {
    const state = makeState();
    expect(state.docIndex).toBe(0);
    expect(state.docs.map((d) => d.status)).toEqual(["pending", "pending"]);
  });
});

describe("job-state — H4 noteDocStage", () => {
  it("updates lastStage/lastStageStartedAt for the given doc only", () => {
    const state = makeState();
    noteDocStage(state, 1, "review", 42);
    expect(state.docs[1]?.lastStage).toBe("review");
    expect(state.docs[1]?.lastStageStartedAt).toBe(42);
    expect(state.docs[0]?.lastStage).toBeUndefined();
  });

  it("ignores out-of-range docIndex (no throw)", () => {
    const state = makeState();
    expect(() => noteDocStage(state, 9, "fix", 1)).not.toThrow();
  });
});

describe("job-state — deriveLoopsSinceLastSeen", () => {
  it("delta of the monotonic counter; rewind clamps to 0", () => {
    const state = makeState();
    state.docs[0]!.lastLoopCycleCount = 5;
    expect(deriveLoopsSinceLastSeen(state, 0, 8)).toBe(3);
    expect(deriveLoopsSinceLastSeen(state, 0, 5)).toBe(0);
    expect(deriveLoopsSinceLastSeen(state, 0, 1)).toBe(0); // never negative
    expect(deriveLoopsSinceLastSeen(state, 0, 0)).toBe(0);
  });

  it("missing lastLoopCycleCount treats 0 as baseline", () => {
    const state = makeState();
    expect(deriveLoopsSinceLastSeen(state, 0, 2)).toBe(2);
  });
});

describe("job-state — listRunningJobs", () => {
  it("returns only running jobs; corrupt files skipped with error log", async () => {
    const running = makeState();
    running.status = "running";
    await writeJobState(ROOT, running);

    const done = makeState({ jobId: "beta" });
    done.status = "completed";
    await writeJobState(ROOT, done);

    const corruptDir = path.join(ROOT, ".pi", "auto_pipeline", "gamma");
    fs.mkdirSync(corruptDir, { recursive: true });
    fs.writeFileSync(path.join(corruptDir, "state.json"), "garbage", "utf8");

    const runningJobs = listRunningJobs(ROOT);
    expect(runningJobs.map((j) => j.jobId)).toEqual(["alpha_loop"]);
    expect(diagnostics).toEqual(["sidecar_unreadable"]); // the corrupt entry
  });

  it("empty/missing directory → []", () => {
    expect(listRunningJobs(ROOT)).toEqual([]);
  });
});

describe("job-state — isValidJobId", () => {
  it("accepts safe ids; rejects traversal, separators and control chars", () => {
    expect(isValidJobId("feat-alpha_1.2")).toBe(true);
    expect(isValidJobId("")).toBe(false);
    expect(isValidJobId(".")).toBe(false);
    expect(isValidJobId("..")).toBe(false);
    expect(isValidJobId("a/b")).toBe(false);
    expect(isValidJobId("a\\b")).toBe(false);
    expect(isValidJobId("a\0b")).toBe(false);
  });
});
