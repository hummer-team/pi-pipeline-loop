/**
 * 210 Phase 4 unit tests — `src/core/stage-evidence.ts`.
 *
 * Scope (plan Phase 4 "unit-test targets"):
 * - summary frontmatter commit_ids parsing: JSON / flow-list / block-list shapes,
 *   absence, corruption, and body-isolation (a `commit_ids` mention OUTSIDE the
 *   frontmatter must never leak into the evidence);
 * - missing `stageStartTime` → `durationMs = 0` AND `evidenceUnavailable = true`;
 * - `recordStageStats` single-snapshot merge semantics;
 * - `serializeStageStats` single-line vocabulary;
 * - `collectRunAggregate` key-set completeness against the requirement 5.5 table
 *   and fail-visible handling of unreadable summaries.
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  collectStageExitEvidence,
  recordStageStats,
  serializeStageStats,
  collectRunAggregate,
} from "../../core/stage-evidence";
import { initAuditLog, auditLogDirForPipeline } from "../../utils/auditLog";
import { makeTestConfig, makeTestMeta } from "../helpers";
import type { SessionMeta } from "../../types";

let TMP: string;

beforeAll(async () => {
  TMP = await mkdtemp(join(tmpdir(), "pi-210-evidence-"));
  // Audit path resolution inside the aggregate depends on the initialized root.
  await initAuditLog(makeTestConfig({ projectRoot: TMP }));
});

afterAll(async () => {
  await rm(TMP, { recursive: true, force: true });
});

/** Writes a summary fixture and returns its path. */
async function summaryFile(name: string, content: string): Promise<string> {
  const p = join(TMP, `summaries-${name}.md`);
  await writeFile(p, content, "utf-8");
  return p;
}

/** Meta fixture pointing at one summary for the current stage. */
function metaWithSummary(path: string, overrides?: Partial<SessionMeta>): SessionMeta {
  return makeTestMeta({
    currentStage: "develop",
    pipelineId: `pipe-evidence-${Math.random().toString(36).slice(2, 8)}`,
    stageStartTime: Date.now() - 5000,
    summaries: { develop: { path, hash: "h", status: "valid" } },
    ...overrides,
  });
}

// ─── collectStageExitEvidence: commit_ids frontmatter parsing ────────────────

describe("210 Phase 4: collectStageExitEvidence commit_ids parsing", () => {
  it("reads the JSON-frontmatter shape written by generate-summary (body mentions ignored)", async () => {
    // This is the EXACT shape `generate-summary` writes: a JSON blob between
    // the `---` fences. The body mentions `commit_ids` too — it must NOT leak.
    const p = await summaryFile(
      "json",
      [
        "---",
        "{",
        '  "stage": "develop",',
        '  "phase": "3/8",',
        '  "commit_ids": [',
        '    "61eadf8",',
        '    "13803b4"',
        "  ]",
        "}",
        "---",
        "# Develop Summary",
        "",
        "commit_ids: [leaked-body-id]",
        "",
      ].join("\n"),
    );
    const ev = await collectStageExitEvidence(metaWithSummary(p));
    expect(ev.commitIds).toEqual(["61eadf8", "13803b4"]);
    expect(ev.evidenceUnavailable).toBe(false);
    expect(ev.summaryPath).toBe(p);
  });

  it("tolerates a YAML flow list (commit_ids: [a, b])", async () => {
    const p = await summaryFile(
      "flow",
      ["---", "title: develop summary", "commit_ids: [aaa1111, bbb2222]", "---", "body", ""].join("\n"),
    );
    const ev = await collectStageExitEvidence(metaWithSummary(p));
    expect(ev.commitIds).toEqual(["aaa1111", "bbb2222"]);
    expect(ev.evidenceUnavailable).toBe(false);
  });

  it("tolerates a YAML block list (- id lines)", async () => {
    const p = await summaryFile(
      "block",
      ["---", "commit_ids:", "  - ccc3333", '  - "ddd4444",', "---", "body", ""].join("\n"),
    );
    const ev = await collectStageExitEvidence(metaWithSummary(p));
    expect(ev.commitIds).toEqual(["ccc3333", "ddd4444"]);
    expect(ev.evidenceUnavailable).toBe(false);
  });

  it("frontmatter WITHOUT commit_ids → empty ids, evidenceUnavailable=true", async () => {
    const p = await summaryFile(
      "noids",
      ["---", "{", '  "stage": "develop"', "}", "---", "body", ""].join("\n"),
    );
    const ev = await collectStageExitEvidence(metaWithSummary(p));
    expect(ev.commitIds).toEqual([]);
    expect(ev.evidenceUnavailable).toBe(true);
    // The stage facts are still captured — only the commit evidence is missing.
    expect(ev.durationMs).toBeGreaterThanOrEqual(5000);
  });

  it("corrupted frontmatter (truncated fences) never throws → evidenceUnavailable=true", async () => {
    const p = await summaryFile("corrupt", "---\n{ \"stage\": \"develop\",\n");
    const ev = await collectStageExitEvidence(metaWithSummary(p));
    expect(ev.commitIds).toEqual([]);
    expect(ev.evidenceUnavailable).toBe(true);
  });

  it("missing summary file → read failure degrades to evidenceUnavailable=true", async () => {
    const ev = await collectStageExitEvidence(
      metaWithSummary(join(TMP, "does-not-exist-210.md")),
    );
    expect(ev.commitIds).toEqual([]);
    expect(ev.evidenceUnavailable).toBe(true);
  });

  it("no summary recorded for the stage → summaryPath '' + evidenceUnavailable=true", async () => {
    const meta = makeTestMeta({
      currentStage: "develop",
      stageStartTime: Date.now() - 1000,
      summaries: {},
    });
    const ev = await collectStageExitEvidence(meta);
    expect(ev.summaryPath).toBe("");
    expect(ev.evidenceUnavailable).toBe(true);
  });
});

// ─── collectStageExitEvidence: clock + counters ──────────────────────────────

describe("210 Phase 4: collectStageExitEvidence clock and counters", () => {
  it("missing stageStartTime → stageEnteredAt=0, durationMs=0 AND flagged", async () => {
    const p = await summaryFile("clock", "---\ncommit_ids: [eee5555]\n---\n");
    const ev = await collectStageExitEvidence(metaWithSummary(p, { stageStartTime: 0 }));
    expect(ev.stageEnteredAt).toBe(0);
    expect(ev.durationMs).toBe(0);
    expect(ev.evidenceUnavailable).toBe(true);
  });

  it("measures durationMs against the pre-advance entry clock and passes counters through", async () => {
    const p = await summaryFile("counters", "---\ncommit_ids: [fff6666]\n---\n");
    const started = Date.now() - 1234;
    const ev = await collectStageExitEvidence(
      metaWithSummary(p, {
        stageStartTime: started,
        verifyAttempts: 2,
        confirmRejections: 1,
        loopCycleCount: 3,
      }),
    );
    expect(ev.stageEnteredAt).toBe(started);
    expect(ev.durationMs).toBeGreaterThanOrEqual(1234);
    expect(ev.durationMs).toBeLessThan(60_000); // sanity: not a garbage clock
    expect(ev.verifyAttempts).toBe(2);
    expect(ev.confirmRejections).toBe(1);
    expect(ev.loopCycleCount).toBe(3);
    expect(ev.evidenceUnavailable).toBe(false);
  });
});

// ─── recordStageStats ─────────────────────────────────────────────────────────

describe("210 Phase 4: recordStageStats", () => {
  it("writes ONE snapshot merging with the base meta's existing stats", () => {
    const base = makeTestMeta({
      currentStage: "review",
      stageStats: { clarify: { durationMs: 100, verifyAttempts: 0, confirmRejections: 0 } },
    });
    const writes: Partial<SessionMeta>[] = [];
    const session = { updateMeta: (p: Partial<SessionMeta>) => { writes.push(p); return undefined; } };

    recordStageStats(session, base, "develop", { durationMs: 222, verifyAttempts: 3, confirmRejections: 1 });

    expect(writes.length).toBe(1);
    expect(writes[0].stageStats).toEqual({
      clarify: { durationMs: 100, verifyAttempts: 0, confirmRejections: 0 },
      develop: { durationMs: 222, verifyAttempts: 3, confirmRejections: 1 },
    });
    // The base meta object itself must not be mutated (single write point through the session).
    expect(base.stageStats!.develop).toBeUndefined();
  });
});

// ─── serializeStageStats ──────────────────────────────────────────────────────

describe("210 Phase 4: serializeStageStats single-line vocabulary", () => {
  it("undefined map → empty string", () => {
    expect(serializeStageStats(undefined)).toBe("");
  });

  it("entries serialize as stage:durationMs:verifyAttempts:confirmRejections, comma-joined", () => {
    const s = serializeStageStats({
      clarify: { durationMs: 120000, verifyAttempts: 0, confirmRejections: 0 },
      plan: { durationMs: 90000, verifyAttempts: 2, confirmRejections: 1 },
    });
    expect(s).toBe("clarify:120000:0:0,plan:90000:2:1");
    // The audit line contract: no separator characters may appear in values.
    expect(s).not.toContain("|");
    expect(s).not.toContain("=");
  });

  it("never-written Partial keys (undefined snapshots) are skipped", () => {
    expect(serializeStageStats({ develop: undefined, plan: { durationMs: 1, verifyAttempts: 0, confirmRejections: 0 } }))
      .toBe("plan:1:0:0");
  });
});

// ─── collectRunAggregate ──────────────────────────────────────────────────────

describe("210 Phase 4: collectRunAggregate", () => {
  it("emits the requirement 5.5 key set VERBATIM (plus finalStage)", async () => {
    const meta = makeTestMeta({ currentStage: "review", requirementDoc: "docs/design/77_Config.md" });
    const agg = await collectRunAggregate(meta, "review", Date.now());
    expect(Object.keys(agg).sort()).toEqual([
      "auditPath",
      "commitIds",
      "confirmRejections",
      "durationMs",
      "finalStage",
      "loopCycleCount",
      "planDoc",
      "requirementDoc",
      "stageStats",
      "stageVisitOrder",
      "startedAt",
      "summaryPaths",
      "verifyAttempts",
    ]);
    // Every value is a plain string (audit `extra` contract).
    for (const v of Object.values(agg)) expect(typeof v).toBe("string");
  });

  it("aggregates durations, counters, docs and commit ids across all stage summaries", async () => {
    const p1 = await summaryFile("agg-a", "---\ncommit_ids: [aaa1111, bbb2222]\n---\n");
    const p2 = await summaryFile("agg-b", "---\n{\n  \"commit_ids\": [\"ccc3333\"]\n}\n---\n");
    const startedAt = Date.now() - 50_000;
    const finalEntry = Date.now() - 1500;
    const meta = makeTestMeta({
      currentStage: "review",
      requirementDoc: "docs/design/77_Config.md",
      pipelineStartedAt: startedAt,
      stageStartTime: finalEntry,
      verifyAttempts: 4,
      confirmRejections: 2,
      loopCycleCount: 1,
      stageVisitOrder: ["clarify", "plan", "develop", "review"],
      stageStats: {
        clarify: { durationMs: 10, verifyAttempts: 0, confirmRejections: 0 },
        plan: { durationMs: 20, verifyAttempts: 1, confirmRejections: 1 },
      },
      summaries: {
        develop: { path: p1, hash: "h1", status: "valid" },
        review: { path: p2, hash: "h2", status: "valid" },
      },
    });

    const agg = await collectRunAggregate(meta, "review", finalEntry);
    expect(agg.startedAt).toBe(String(startedAt));
    expect(Number(agg.durationMs)).toBeGreaterThanOrEqual(1500);
    expect(agg.stageStats).toBe("clarify:10:0:0,plan:20:1:1");
    expect(agg.verifyAttempts).toBe("4");
    expect(agg.confirmRejections).toBe("2");
    expect(agg.loopCycleCount).toBe("1");
    expect(agg.stageVisitOrder).toBe("clarify,plan,develop,review");
    expect(agg.requirementDoc).toBe("docs/design/77_Config.md");
    // planDoc is the canonical naming derivation from the requirement doc.
    expect(agg.planDoc).toBe("docs/design/77_Config_Plan.md");
    expect(agg.summaryPaths).toBe(`${p1},${p2}`);
    expect(agg.commitIds).toBe("aaa1111,bbb2222,ccc3333");
    expect(agg.finalStage).toBe("review");
    // auditPath is the accessible per-pipeline directory (initAuditLog ran in beforeAll).
    expect(agg.auditPath).toBe(auditLogDirForPipeline(meta.pipelineId) ?? "unavailable");
    expect(agg.auditPath!.length).toBeGreaterThan(0);
  });

  it("deduplicates commit ids across summaries and skips unreadable ones without throwing", async () => {
    const pGood = await summaryFile("dedup", "---\ncommit_ids: [same9999]\n---\n");
    const meta = makeTestMeta({
      currentStage: "review",
      summaries: {
        develop: { path: pGood, hash: "h", status: "valid" },
        review: { path: pGood, hash: "h", status: "valid" }, // same file → id must not double
        fix: { path: join(TMP, "gone-210.md"), hash: "h", status: "valid" }, // unreadable → skipped
      },
    });
    const agg = await collectRunAggregate(meta, "review", Date.now());
    expect(agg.commitIds).toBe("same9999");
    expect(agg.summaryPaths.split(",")).toContain(pGood);
  });

  it("missing requirementDoc → empty requirementDoc/planDoc; missing stageStartTime → durationMs=0", async () => {
    const meta = makeTestMeta({ currentStage: "plan", requirementDoc: undefined, stageStartTime: undefined });
    const agg = await collectRunAggregate(meta, "plan", 0);
    expect(agg.requirementDoc).toBe("");
    expect(agg.planDoc).toBe("");
    expect(agg.durationMs).toBe("0");
    // startedAt falls back to the stage clock — both missing → 0 (flagged by value).
    expect(agg.startedAt).toBe("0");
  });
});
