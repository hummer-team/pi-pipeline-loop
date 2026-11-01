/**
 * 220 Phase 2 (B13 / B7) — per-doc sidecar fields.
 *
 * `clarify.*` counters and the start-stage evidence live on
 * `AutoJobDocProgress`, NEVER on `meta.autoJob`: meta is per-pipelineId and is
 * wiped between documents, so a round counter kept there would silently reset
 * (an unbounded clarify loop) and a "stalled" flag would leak across docs.
 *
 * Contract pinned here:
 * - the nine new optional fields round-trip through the atomic sidecar write;
 * - `schemaVersion` stays 1 — a 219-era sidecar (no new fields) reads back
 *   without throwing and WITHOUT any back-fill write (no migration pass);
 * - accounting is per docKey: populating doc 0 does not touch doc 1.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";
import {
  createJobState,
  readJobState,
  resolveJobStatePath,
  writeJobState,
  type AutoJobState,
} from "../../core/auto-pipeline/job-state";

const JOB_ID = "delta";
let ROOT: string;

beforeEach(() => {
  ROOT = fs.mkdtempSync(path.join(tmpdir(), "pi-220-doc-fields-"));
});

afterEach(() => {
  fs.rmSync(ROOT, { recursive: true, force: true });
});

function baseState(): AutoJobState {
  const state = createJobState({
    jobId: JOB_ID,
    jobPath: "docs/jobs/delta.yaml",
    jobHash: "h",
    docs: [{ doc: "docs/design/a.md" }, { doc: "docs/design/b.md" }],
  });
  state.status = "running";
  return state;
}

describe("job-state — 220 per-doc fields round-trip", () => {
  it("all nine new optional fields survive a write/read cycle", async () => {
    const state = baseState();
    const doc = state.docs[0]!;
    doc.clarifyRounds = 4;
    doc.clarifyLastRound = 3;
    doc.clarifyDispatchedAt = 1_700_000_000_000;
    doc.clarifyStalls = 2;
    doc.clarifyStallSignature = "md5:abc123";
    doc.clarifyStallDocLength = 640;
    doc.clarifyNeedsClarifyStreak = 1;
    doc.startStageBasis = "plan-confirmed";
    doc.startStageDerivation = "auto";

    await writeJobState(ROOT, state);
    const read = readJobState(ROOT, JOB_ID)!;

    expect(read.schemaVersion).toBe(1);
    expect(read.docs[0]).toMatchObject({
      doc: "docs/design/a.md",
      clarifyRounds: 4,
      clarifyLastRound: 3,
      clarifyDispatchedAt: 1_700_000_000_000,
      clarifyStalls: 2,
      clarifyStallSignature: "md5:abc123",
      clarifyStallDocLength: 640,
      clarifyNeedsClarifyStreak: 1,
      startStageBasis: "plan-confirmed",
      startStageDerivation: "auto",
    });
  });

  it("accounting is per docKey — a second doc starts clean (no cross-doc inheritance)", async () => {
    const state = baseState();
    state.docs[0]!.clarifyRounds = 5;
    state.docs[0]!.clarifyStalls = 3;
    await writeJobState(ROOT, state);

    const read = readJobState(ROOT, JOB_ID)!;
    expect(read.docs[1]!.clarifyRounds).toBeUndefined();
    expect(read.docs[1]!.clarifyStalls).toBeUndefined();
    expect(read.docs[1]!.startStageBasis).toBeUndefined();
  });

  it("writes atomically — no tmp file is left behind", async () => {
    await writeJobState(ROOT, baseState());
    const dir = path.dirname(resolveJobStatePath(ROOT, JOB_ID));
    const leftovers = fs.readdirSync(dir).filter((entry) => entry.includes(".tmp-"));
    expect(leftovers).toEqual([]);
  });
});

describe("job-state — 219-era sidecar compatibility (no back-fill)", () => {
  it("an old sidecar (no 220 fields) reads back unchanged and is not rewritten", async () => {
    const state = baseState();
    await writeJobState(ROOT, state);

    // Strip every 220 field to emulate a file written by 219.
    const statePath = resolveJobStatePath(ROOT, JOB_ID);
    const raw = JSON.parse(fs.readFileSync(statePath, "utf8")) as {
      docs: Array<Record<string, unknown>>;
    };
    for (const doc of raw.docs) {
      for (const key of Object.keys(doc)) {
        if (key.startsWith("clarify") || key.startsWith("startStage")) delete doc[key];
      }
    }
    fs.writeFileSync(statePath, JSON.stringify(raw, null, 2), "utf8");
    const bytesBefore = fs.readFileSync(statePath, "utf8");

    const read = readJobState(ROOT, JOB_ID);
    expect(read).not.toBeNull();
    expect(read!.docs[0]!.clarifyRounds).toBeUndefined();
    expect(read!.docs[0]!.startStageBasis).toBeUndefined();

    // Reading NEVER migrates: the file on disk is byte-identical afterwards.
    expect(fs.readFileSync(statePath, "utf8")).toBe(bytesBefore);
  });

  it("a sidecar with a foreign schemaVersion is refused (never defaulted)", async () => {
    await writeJobState(ROOT, baseState());
    const statePath = resolveJobStatePath(ROOT, JOB_ID);
    const raw = JSON.parse(fs.readFileSync(statePath, "utf8")) as Record<string, unknown>;
    raw.schemaVersion = 2;
    fs.writeFileSync(statePath, JSON.stringify(raw, null, 2), "utf8");
    expect(readJobState(ROOT, JOB_ID)).toBeNull();
  });
});
