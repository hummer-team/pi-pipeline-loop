/**
 * 225 Phase 3 (T1): the review exit gate.
 *
 * Contract points:
 * - conclusion ONLY from this round's exact `_N.md` that is FRESH
 *   (mtime >= enteredAt); freshness is judged BEFORE liveness (a freshly
 *   written report is never suppressed by a same-turn dispatch marker);
 * - missing report → no-conclusion/missing; older-than-entry → stale;
 * - liveness: probe_live / reserved window boundary (59s vs 61s) /
 *   `reviewDispatchedAt` same-stageStartTime marker — and the marker MUST NOT
 *   fire across stage visits;
 * - round unknown → legacy fallback (wide-glob latest report decides),
 *   audited `review_round_missing_fallback`;
 * - contract-unavailable rides through verbatim (fail-open untouched).
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { utimesSync } from "node:fs";
import { evaluateReviewExitGate, isReviewExecutorLive } from "../../core/review-exit-gate";
import { makeTestConfig, makeTestMeta, makeRealisticManagerRegistry } from "../helpers";
import type { PipelineConfig, SessionMeta } from "../../types";

const MANAGER_KEY = Symbol.for("pi-subagents:manager");

let projectRoot: string;
let config: PipelineConfig;

beforeEach(() => {
  projectRoot = fs.mkdtempSync(join(tmpdir(), "review-exit-gate-"));
  config = makeTestConfig({ projectRoot });
  fs.mkdirSync(join(projectRoot, "docs", "review"), { recursive: true });
  // Deploy a review verify.md with the verdict runtime anchor (like a real
  // /pipeline-init project) so the parser resolves real verdicts.
  const specDir = join(projectRoot, ".pi", "references", "review_spec");
  fs.mkdirSync(specDir, { recursive: true });
  fs.writeFileSync(
    join(specDir, "verify.md"),
    "---\nrules:\n  path: \"{reviewDir}/*\"\n  groups:\n    - name: conclusion\n      ruleMode: and\n      rules:\n        - type: fileContentPattern\n          runtime: verdict\n          patterns:\n            - \"结论\\\\s*[:：]\\\\s*[*_]{0,2}(不通过|通过)[*_]{0,2}\"\n            - \"Verdict\\\\s*[:：]\\\\s*[*_]{0,2}(PASS|FAIL)[*_]{0,2}\"\n---\n验证结论。",
    "utf-8",
  );
});

afterEach(() => {
  delete (globalThis as Record<symbol, unknown>)[MANAGER_KEY];
  fs.rmSync(projectRoot, { recursive: true, force: true });
  delete (globalThis as Record<symbol, unknown>)[Symbol.for("pi-pipeline:subagent-state")];
});

function writeReport(rel: string, body: string): void {
  const abs = join(projectRoot, rel);
  fs.mkdirSync(join(abs, ".."), { recursive: true });
  fs.writeFileSync(abs, body, "utf-8");
}

function meta(defaults?: Partial<SessionMeta>): SessionMeta {
  const base = makeTestMeta({
    currentStage: "review",
    stageStartTime: 1760000000000,
    requirementDoc: "docs/design/225_Bug.md",
    pipelineId: "pipe-gate",
    ...defaults,
  });
  // No fresh report by default: timestamp the write AFTER entry (default
  // fixture uses in-visit entry clocks) by rewriting mtimes below.
  return base;
}

const PASS_REPORT =
  "# Code Review\n\n## Summary\nok\n\n## Verdict\n\n**Verdict: PASS**\n";
const FAIL_REPORT =
  "# Code Review\n\n- 等级：Blocker: crash\n\n## Verdict\n\n**Verdict: FAIL**\n";

describe("review exit gate — four exit states", () => {
  it("no ledger round + legacy report on disk → audited fallback, conclusion from mtime-latest", async () => {
    const m = meta();
    const legacyPath = "docs/review/code_review_old.md";
    writeReport(legacyPath, PASS_REPORT);
    const gate = await evaluateReviewExitGate(config, m);
    expect(gate.state).toBe("conclusion");
    expect(gate.verdict?.verdict).toBe("pass");
    expect(gate.expectedPath?.endsWith("code_review_old.md")).toBe(true);
  });

  it("round of the CURRENT visit → exact `_N.md`; fresh file → conclusion", async () => {
    const m = meta({
      reviewRound: { index: 2, stageStartTime: 1760000000000, enteredAt: 1760000000010, pipelineId: "pipe-gate" },
    });
    writeReport("docs/review/Code_Review_225_Bug_Develop_Commit_2.md", FAIL_REPORT);
    // mtime >= enteredAt (just written).
    const gate = await evaluateReviewExitGate(config, m);
    expect(gate.state).toBe("conclusion");
    expect(gate.verdict?.verdict).toBe("fail");
    expect(gate.expectedPath).toBe("docs/review/Code_Review_225_Bug_Develop_Commit_2.md");
  });

  it("a FRESH current-round report is NOT deferred even with a live executor (freshness first)", async () => {
    const m = meta({
      reviewRound: { index: 1, stageStartTime: 1760000000000, enteredAt: 1760000000010, pipelineId: "pipe-gate" },
      activeSpawns: { review: { agentName: "review-agent", agentId: "live-1", startedAt: Date.now() } },
      reviewDispatchedAt: { stageStartTime: 1760000000000, at: Date.now() },
    });
    (globalThis as Record<symbol, unknown>)[MANAGER_KEY] = makeRealisticManagerRegistry({ "live-1": "running" });
    writeReport("docs/review/Code_Review_225_Bug_Develop_Commit_1.md", FAIL_REPORT);
    const gate = await evaluateReviewExitGate(config, m);
    expect(gate.state).toBe("conclusion"); // NEVER defer a fresh conclusion
    expect(gate.verdict?.verdict).toBe("fail");
  });

  it("expected file MISSing → no-conclusion/missing (precheck-fallback friendly)", async () => {
    const m = meta({
      reviewRound: { index: 2, stageStartTime: 1760000000000, enteredAt: 1760000000010, pipelineId: "pipe-gate" },
    });
    writeReport("docs/review/Code_Review_225_Bug_Develop_Commit_1.md", PASS_REPORT); // another round only
    const gate = await evaluateReviewExitGate(config, m);
    expect(gate.state).toBe("no-conclusion");
    expect(gate.reason).toBe("missing");
    expect(gate.expectedPath).toContain("_2.md");
  });

  it("expected file OLDER than the round entry → no-conclusion/stale", async () => {
    const m = meta({
      reviewRound: { index: 1, stageStartTime: 1760000000000, enteredAt: 1760000005000, pipelineId: "pipe-gate" },
    });
    const rel = "docs/review/Code_Review_225_Bug_Develop_Commit_1.md";
    writeReport(rel, FAIL_REPORT);
    // Push the mtime BEFORE the enteredAt baseline.
    const past = new Date(1760000000000);
    utimesSync(join(projectRoot, rel), past, past);
    const gate = await evaluateReviewExitGate(config, m);
    expect(gate.state).toBe("no-conclusion");
    expect(gate.reason).toBe("stale");
  });

  it("mtime EQUAL to enteredAt counts as fresh (boundary)", async () => {
    const m = meta({
      reviewRound: { index: 1, stageStartTime: 1760000000000, enteredAt: 1760005000000, pipelineId: "pipe-gate" },
    });
    const rel = "docs/review/Code_Review_225_Bug_Develop_Commit_1.md";
    writeReport(rel, PASS_REPORT);
    utimesSync(join(projectRoot, rel), new Date(1760005000000), new Date(1760005000000));
    const gate = await evaluateReviewExitGate(config, m);
    expect(gate.state).toBe("conclusion");
  });
});

describe("review exit gate — liveness evidence", () => {
  const enteredFuture = 1760000000010;

  beforeEach(() => {
    // 225 code-review fix (issue 6): liveness scans through the shared
    // scanner by AGENT MENTION — resolveAgentMention(config, "review") reads
    // the deployed review agent file, so the fixture deploys one.
    const agentRel = ".pi/agents/review-agent.md";
    fs.mkdirSync(join(projectRoot, ".pi", "agents"), { recursive: true });
    fs.writeFileSync(join(projectRoot, agentRel), "---\nname: review-agent\n---\nbody\n", "utf-8");
    config.stages.review.agentPath = agentRel;
  });

  it("probe_live: registry-driven liveness (executor present → live)", () => {
    const m = meta({ activeSpawns: { review: { agentName: "review-agent", agentId: "live-1", startedAt: 1 } } });
    expect(isReviewExecutorLive(config, m)).toBe(false); // no manager installed → settled
    (globalThis as Record<symbol, unknown>)[MANAGER_KEY] = makeRealisticManagerRegistry({ "live-1": "running" });
    expect(isReviewExecutorLive(config, m)).toBe(true);
  });

  it("evidence registered under a NON-review stage key still counts as live (cross-key scan)", () => {
    // The point of reusing scanActiveSpawnEvidence (issue 6): the single-key
    // reimplementation was blind to evidence hanging on any other stage key —
    // exactly the shape a late ledger cleanup or a borrowed executor leaves.
    const m = meta({
      activeSpawns: { develop: { agentName: "review-agent", agentId: "live-9", startedAt: 1 } },
    });
    expect(isReviewExecutorLive(config, m)).toBe(false);
    (globalThis as Record<symbol, unknown>)[MANAGER_KEY] = makeRealisticManagerRegistry({ "live-9": "running" });
    expect(isReviewExecutorLive(config, m)).toBe(true);
  });

  it("a FOREIGN agent name on another stage key is NOT liveness evidence", () => {
    const m = meta({
      activeSpawns: { develop: { agentName: "develop-agent", agentId: "live-x", startedAt: 1 } },
    });
    (globalThis as Record<symbol, unknown>)[MANAGER_KEY] = makeRealisticManagerRegistry({ "live-x": "running" });
    expect(isReviewExecutorLive(config, m)).toBe(false);
  });

  it("reserved evidence: 59s inside the window is live", () => {
    const m = meta({
      activeSpawns: { review: { agentName: "review-agent", startedAt: Date.now() - 59_000, reserved: true } },
    });
    expect(isReviewExecutorLive(config, m)).toBe(true);
  });

  it("reserved evidence: 61s outside the window is NOT live", () => {
    const m = meta({
      activeSpawns: { review: { agentName: "review-agent", startedAt: Date.now() - 61_000, reserved: true } },
    });
    expect(isReviewExecutorLive(config, m)).toBe(false);
  });

  it("same-turn dispatch marker hits only the matching stageStartTime", () => {
    const m = meta({ reviewDispatchedAt: { stageStartTime: 1760000000000, at: Date.now() } });
    expect(isReviewExecutorLive(config, m)).toBe(true);
    // A foreign visit's marker never revives this one.
    const foreign = meta({ stageStartTime: 9999999999, reviewDispatchedAt: { stageStartTime: 1760000000000, at: Date.now() } });
    expect(isReviewExecutorLive(config, foreign)).toBe(false);
  });

  it("live executor + missing fresh report → live-executor (keep waiting)", async () => {
    const m = meta({
      reviewRound: { index: 2, stageStartTime: 1760000000000, enteredAt: enteredFuture, pipelineId: "pipe-gate" },
      reviewDispatchedAt: { stageStartTime: 1760000000000, at: Date.now() },
    });
    const gate = await evaluateReviewExitGate(config, m);
    expect(gate.state).toBe("live-executor");
    expect(gate.reason).toBe("live");
  });

  it("stale report + NO live executor → no-conclusion/stale (recovers the stale answer)", async () => {
    const m = meta({
      reviewRound: { index: 1, stageStartTime: 1760000000000, enteredAt: 1760000005000, pipelineId: "pipe-gate" },
    });
    const rel = "docs/review/Code_Review_225_Bug_Develop_Commit_1.md";
    writeReport(rel, FAIL_REPORT);
    const past = new Date(1760000000000);
    utimesSync(join(projectRoot, rel), past, past);
    const gate = await evaluateReviewExitGate(config, m);
    expect(gate.state).toBe("no-conclusion");
    expect(gate.reason).toBe("stale");
  });
});

describe("review exit gate — round-unknown fallback audits", () => {
  it("legacy latest report decides and the fallback is audited", async () => {
    const m = meta({ stageVisitOrder: ["clarify", "plan", "develop", "review"] });
    writeReport("docs/review/code_review_legacy.md", FAIL_REPORT);
    const gate = await evaluateReviewExitGate(config, m);
    expect(gate.state).toBe("conclusion");
    expect(gate.verdict?.verdict).toBe("fail");
    // Audit existence is exercised by the agent-settled/replay suites with
    // the audit capture; here we only pin the resolution semantics.
  });
});
