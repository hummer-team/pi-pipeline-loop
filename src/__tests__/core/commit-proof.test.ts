/**
 * 210 Phase 6 unit tests — commit-proof reconciliation.
 *
 * Covers the plan acceptance list for `checkCommitProof` (pure git checks with
 * a FAKE execFn — real git is never touched): the three violation classes
 * (C1 existence / C2 freshness with the 300s tolerance boundaries / C3 plan-doc
 * binding), exec-absence and exec-throw fail-open, empty commit ids, the
 * `reconcileCommitProof` orchestration (switch precedence + the
 * commit_proof_skipped / commit_proof_checked / commit_proof_error /
 * commit_proof_violation audit trail), and the 210 review issue 1 C2 clock
 * baseline (`resolveCommitProofClockBaseline`: develop first visit vs run
 * start for every later stage / re-visit).
 */

import { describe, it, expect, afterEach } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkCommitProof,
  reconcileCommitProof,
  resolveCommitProofClockBaseline,
  parseDevCommitIds,
  parsePlanDocClaim,
  COMMIT_TIME_TOLERANCE_MS,
} from "../../core/commit-proof";
import { __setSafeWriteAuditLogOverride } from "../../utils/auditLog";
import { makeTestConfig, makeTestMeta } from "../helpers";
import type { ExecFn, PipelineConfig, SessionMeta, VerifyConfig } from "../../types";

// ─── Harness ──────────────────────────────────────────────────────────────────

let seq = 0;
const uniq = (label: string) => `pipe-210-${label}-${Date.now()}-${++seq}`;

interface GitRes {
  stdout: string;
  stderr: string;
  code: number;
}

const ok = (stdout = ""): GitRes => ({ stdout, stderr: "", code: 0 });
const fail = (stderr: string, code = 1): GitRes => ({ stdout: "", stderr, code });

/**
 * Fake git driver: the LONGEST matching prefix on `args.join(" ")` wins
 * (specific overrides beat generic rules regardless of insertion order);
 * unmocked calls fail with exit 1 (loud, never silently "successful").
 */
function makeGit(rules: Record<string, GitRes>): { execFn: ExecFn; calls: string[] } {
  const calls: string[] = [];
  const ordered = Object.entries(rules).sort((a, b) => b[0].length - a[0].length);
  const execFn: ExecFn = async (_cmd, args) => {
    const key = args.join(" ");
    calls.push(key);
    for (const [prefix, res] of ordered) {
      if (key.startsWith(prefix)) return res;
    }
    return fail(`unmocked git call: ${key}`);
  };
  return { execFn, calls };
}

/** Baseline "everything is fine" rule set (fresh commit at `now`). */
const healthyRules = (ct = Math.floor(Date.now() / 1000)): Record<string, GitRes> => ({
  "rev-parse --git-dir": ok(".git"),
  "cat-file -e": ok(),
  "show -s --format=%ct": ok(String(ct)),
});

// ─── Pure commit id / plan doc parsing ────────────────────────────────────────

describe("parseDevCommitIds / parsePlanDocClaim", () => {
  it("parses the comma-separated **dev commit id** line (backticks tolerated)", () => {
    const doc = "# plan & commit id's\n**plan doc**: `docs/design/210_Feat_Plan.md`\n\n**dev commit id**: `61eadf8`,`13803b4`,abf58f1\n";
    expect(parseDevCommitIds(doc)).toEqual(["61eadf8", "13803b4", "abf58f1"]);
    expect(parsePlanDocClaim(doc)).toBe("docs/design/210_Feat_Plan.md");
  });

  it("is case-insensitive on the key, accumulates lines and de-duplicates", () => {
    const doc = "**Dev Commit ID**: aaaa1111,bbbb2222\n**dev commit id**: bbbb2222 cccc3333\n";
    expect(parseDevCommitIds(doc)).toEqual(["aaaa1111", "bbbb2222", "cccc3333"]);
  });

  it("drops malformed tokens and returns [] when the key is absent", () => {
    expect(parseDevCommitIds("**dev commit id**: not an id, ab\n")).toEqual([]);
    expect(parseDevCommitIds("nothing here")).toEqual([]);
    expect(parsePlanDocClaim("no key")).toBeNull();
  });
});

// ─── checkCommitProof — pure git reconciliation ───────────────────────────────

describe("checkCommitProof", () => {
  const base = {
    stage: "develop" as const,
    stageStartTime: 0,
  };

  it("C1: unknown revision → commit_exists violation, group commit_proof", async () => {
    const { execFn } = makeGit({
      ...healthyRules(),
      "cat-file -e dead0001": fail("fatal: Not a valid object name dead0001^{commit}", 128),
    });
    const r = await checkCommitProof({ ...base, projectRoot: "/unused", execFn, commitIds: ["dead0001"] });
    expect(r.checked).toBe(0);
    expect(r.violations).toHaveLength(1);
    expect(r.violations[0].ruleType).toBe("commit_exists");
    expect(r.violations[0].group).toBe("commit_proof");
    expect(r.violations[0].detail).toContain("dead0001");
    expect(r.error).toBeUndefined();
  });

  it("C1: malformed id is rejected BEFORE shelling git (no arg injection)", async () => {
    const { execFn, calls } = makeGit(healthyRules());
    const r = await checkCommitProof({ ...base, projectRoot: "/unused", execFn, commitIds: ["; rm -rf /", "a!b"] });
    expect(r.violations.every((v) => v.ruleType === "commit_exists")).toBe(true);
    expect(r.violations).toHaveLength(2);
    // Only the repository probe may have run — no per-id git calls.
    expect(calls.filter((c) => c.startsWith("cat-file"))).toHaveLength(0);
  });

  it("C2: commit exactly 300s before stage start PASSES (strict boundary)", async () => {
    const stageStartTime = 1_700_000_000_000;
    const ct = (stageStartTime - COMMIT_TIME_TOLERANCE_MS) / 1000;
    const { execFn } = makeGit(healthyRules(ct));
    const r = await checkCommitProof({ ...base, stageStartTime, projectRoot: "/unused", execFn, commitIds: ["aaaa1111"] });
    expect(r.violations).toEqual([]);
    expect(r.checked).toBe(1);
  });

  it("C2: commit 301s before stage start → commit_after_stage_start", async () => {
    const stageStartTime = 1_700_000_000_000;
    const ct = (stageStartTime - COMMIT_TIME_TOLERANCE_MS - 1000) / 1000;
    const { execFn } = makeGit(healthyRules(ct));
    const r = await checkCommitProof({ ...base, stageStartTime, projectRoot: "/unused", execFn, commitIds: ["aaaa1111"] });
    expect(r.violations).toHaveLength(1);
    expect(r.violations[0].ruleType).toBe("commit_after_stage_start");
    expect(r.violations[0].detail).toContain("aaaa1111");
  });

  it("C2: skipped entirely when stageStartTime is 0 (no timestamp probe)", async () => {
    const { execFn, calls } = makeGit(healthyRules());
    const r = await checkCommitProof({ ...base, stageStartTime: 0, projectRoot: "/unused", execFn, commitIds: ["aaaa1111"] });
    expect(r.violations).toEqual([]);
    expect(calls.filter((c) => c.startsWith("show -s"))).toHaveLength(0);
  });

  it("C3: plan-doc claim mismatch → plan_doc_mismatch (normalized relative compare)", async () => {
    const root = join(tmpdir(), `pi-210-proof-c3-${Date.now()}-${++seq}`);
    await mkdir(join(root, "docs", "design"), { recursive: true });
    const docPath = "docs/design/210_Feat_Develop_Commit.md";
    await writeFile(
      join(root, docPath),
      "# plan & commit id's\n**plan doc**: `docs/design/999_Other_Plan.md`\n**dev commit id**: aaaa1111\n",
      "utf-8",
    );
    try {
      const { execFn } = makeGit(healthyRules());
      const r = await checkCommitProof({
        projectRoot: root,
        execFn,
        stage: "develop",
        stageStartTime: 0,
        commitIds: ["aaaa1111"],
        commitDocPath: docPath,
        expectedPlanDoc: join(root, "docs/design/210_Feat_Plan.md"),
      });
      expect(r.violations).toHaveLength(1);
      expect(r.violations[0].ruleType).toBe("plan_doc_mismatch");
      expect(r.violations[0].detail).toContain("docs/design/999_Other_Plan.md");
      expect(r.violations[0].detail).toContain("docs/design/210_Feat_Plan.md");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("C3: absolute claim normalizes to a match; missing claim / unreadable doc skip", async () => {
    const root = join(tmpdir(), `pi-210-proof-c3ok-${Date.now()}-${++seq}`);
    await mkdir(join(root, "docs", "design"), { recursive: true });
    const docPath = "docs/design/210_Feat_Develop_Commit.md";
    const expected = join(root, "docs/design/210_Feat_Plan.md");
    const { execFn } = makeGit(healthyRules());
    try {
      // Absolute claim → equal after relativization.
      await writeFile(join(root, docPath), `**plan doc**: \`${expected}\`\n**dev commit id**: aaaa1111\n`, "utf-8");
      expect((await checkCommitProof({ projectRoot: root, execFn, stage: "develop", stageStartTime: 0, commitIds: ["aaaa1111"], commitDocPath: docPath, expectedPlanDoc: expected })).violations).toEqual([]);

      // No plan-doc key at all → C3 skips (absence is not a lie).
      await writeFile(join(root, docPath), "**dev commit id**: aaaa1111\n", "utf-8");
      expect((await checkCommitProof({ projectRoot: root, execFn, stage: "develop", stageStartTime: 0, commitIds: ["aaaa1111"], commitDocPath: docPath, expectedPlanDoc: expected })).violations).toEqual([]);

      // Unreadable commit doc → C3 skips, never errors.
      expect((await checkCommitProof({ projectRoot: root, execFn, stage: "develop", stageStartTime: 0, commitIds: ["aaaa1111"], commitDocPath: "docs/design/Nope_Develop_Commit.md", expectedPlanDoc: expected })).violations).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("fail-open: no execFn → error field, zero violations", async () => {
    const r = await checkCommitProof({ ...base, projectRoot: "/unused", commitIds: ["aaaa1111"] });
    expect(r.violations).toEqual([]);
    expect(r.error).toContain("execFn unavailable");
  });

  it("fail-open: execFn throws → error field, partial violations dropped", async () => {
    const boom: ExecFn = async (_c, args) => {
      if (args[0] === "rev-parse") return ok(".git");
      throw new Error("child_process exploded");
    };
    const r = await checkCommitProof({ ...base, projectRoot: "/unused", execFn: boom, commitIds: ["aaaa1111"] });
    expect(r.violations).toEqual([]);
    expect(r.error).toContain("child_process exploded");
  });

  it("fail-open: not a git repository → error, no per-id false positives", async () => {
    const { execFn, calls } = makeGit({ "rev-parse --git-dir": fail("fatal: not a git repository", 128) });
    const r = await checkCommitProof({ ...base, projectRoot: "/unused", execFn, commitIds: ["aaaa1111", "bbbb2222"] });
    expect(r.error).toContain("not a git repository");
    expect(r.violations).toEqual([]);
    expect(calls).toHaveLength(1);
  });

  it("empty commitIds → checked 0, no violations", async () => {
    const { execFn } = makeGit(healthyRules());
    const r = await checkCommitProof({ ...base, projectRoot: "/unused", execFn, commitIds: [] });
    expect(r).toEqual({ checked: 0, violations: [] });
  });
});

// ─── reconcileCommitProof — switch resolution + audit trail ──────────────────

interface CapturedAudit {
  event: string;
  fields: Record<string, string | boolean>;
  level?: string;
}

function captureAudits(sink: CapturedAudit[]): void {
  __setSafeWriteAuditLogOverride(async (event, message, level) => {
    sink.push({ event, fields: (message ?? {}) as Record<string, string | boolean>, level });
  });
}

afterEach(() => {
  __setSafeWriteAuditLogOverride(null);
});

async function proofEnv(docContent: string | null): Promise<{ config: PipelineConfig; meta: SessionMeta; root: string }> {
  const root = join(tmpdir(), `pi-210-proof-env-${Date.now()}-${++seq}`);
  await mkdir(join(root, "docs", "design"), { recursive: true });
  if (docContent !== null) {
    await writeFile(join(root, "docs/design/210_Feat_Develop_Commit.md"), docContent, "utf-8");
  }
  const config = makeTestConfig({ projectRoot: root });
  const meta = makeTestMeta({
    pipelineId: uniq("proof"),
    currentStage: "develop",
    requirementDoc: "docs/design/210_Feat.md",
    stageStartTime: Date.now(),
  });
  return { config, meta, root };
}

const BAD_ID_DOC = "# plan & commit id's\n**plan doc**: `docs/design/210_Feat_Plan.md`\n**dev commit id**: dead0001\n";

// ─── 210 review issue 1 (High): C2 clock baseline per stage / per visit ──────

describe("resolveCommitProofClockBaseline", () => {
  const RUN_START = 1_700_000_000_000;
  const STAGE_START = RUN_START + 600_000;

  it("develop FIRST visit keeps the strict develop-entry clock", () => {
    const meta = makeTestMeta({
      currentStage: "develop",
      stageStartTime: STAGE_START,
      pipelineStartedAt: RUN_START,
      stageVisitOrder: ["clarify", "plan", "develop"],
    });
    expect(resolveCommitProofClockBaseline(meta)).toEqual({
      baselineMs: STAGE_START,
      label: "develop stage entry (first visit)",
    });
  });

  it("review / fix / awaiting_human compare against the RUN start, not the verifying stage entry", () => {
    for (const stage of ["review", "fix", "awaiting_human", "completed"] as const) {
      const meta = makeTestMeta({
        currentStage: stage,
        stageStartTime: STAGE_START,
        pipelineStartedAt: RUN_START,
        stageVisitOrder: ["clarify", "plan", "develop", "review", stage],
      });
      const b = resolveCommitProofClockBaseline(meta);
      expect(b.baselineMs).toBe(RUN_START);
      expect(b.label).toBe("pipeline run start");
    }
  });

  it("develop RE-VISIT (rework loop) uses the run start — its own entry clock is too late", () => {
    const meta = makeTestMeta({
      currentStage: "develop",
      stageStartTime: STAGE_START,
      pipelineStartedAt: RUN_START,
      stageVisitOrder: ["clarify", "plan", "develop", "review", "develop"],
    });
    expect(resolveCommitProofClockBaseline(meta).baselineMs).toBe(RUN_START);
  });

  it("no clock at all → 0, so C2 is skipped instead of guessing (fail-open)", () => {
    const meta = makeTestMeta({
      currentStage: "review",
      stageStartTime: undefined,
      pipelineStartedAt: undefined,
    });
    const b = resolveCommitProofClockBaseline(meta);
    expect(b.baselineMs).toBe(0);
    expect(b.label).toContain("C2 skipped");
  });
});

describe("reconcileCommitProof", () => {
  it("no requirement doc → completely silent (baseline untouched)", async () => {
    const sink: CapturedAudit[] = [];
    captureAudits(sink);
    const config = makeTestConfig();
    const meta = makeTestMeta({ pipelineId: uniq("proof"), requirementDoc: undefined });
    const { execFn } = makeGit({ "cat-file -e": fail("nope", 128) });
    const out = await reconcileCommitProof(config, meta, { require: true }, execFn);
    expect(out).toEqual([]);
    expect(sink).toEqual([]);
  });

  it("missing commit doc → commit_proof_skipped (commit_doc_unreadable), never blocks", async () => {
    const sink: CapturedAudit[] = [];
    captureAudits(sink);
    const { config, meta, root } = await proofEnv(null);
    try {
      const { execFn } = makeGit(healthyRules());
      expect(await reconcileCommitProof(config, meta, { require: true }, execFn)).toEqual([]);
      const skipped = sink.find((e) => e.event === "commit_proof_skipped");
      expect(skipped?.fields.reason).toBe("commit_doc_unreadable");
      expect(skipped?.fields.stage).toBe("develop");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("commit doc without parsable ids → commit_proof_skipped (no_commit_ids)", async () => {
    const sink: CapturedAudit[] = [];
    captureAudits(sink);
    const { config, meta, root } = await proofEnv("# notes\nno ids here\n");
    try {
      const { execFn } = makeGit(healthyRules());
      expect(await reconcileCommitProof(config, meta, { require: true }, execFn)).toEqual([]);
      expect(sink.find((e) => e.event === "commit_proof_skipped")?.fields.reason).toBe("no_commit_ids");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("switch OFF: violations are WARN-audited only and NOT returned", async () => {
    const sink: CapturedAudit[] = [];
    captureAudits(sink);
    const { config, meta, root } = await proofEnv(BAD_ID_DOC);
    try {
      const { execFn } = makeGit({
        ...healthyRules(),
        "cat-file -e dead0001": fail("fatal: Not a valid object name", 128),
      });
      const out = await reconcileCommitProof(config, meta, { require: true }, execFn);
      expect(out).toEqual([]);
      const violation = sink.find((e) => e.event === "commit_proof_violation");
      expect(violation?.level).toBe("warn");
      expect(violation?.fields.ruleType).toBe("commit_exists");
      expect(violation?.fields.enforced).toBe("false");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("switch ON: violations are returned (folded into failures) with enforced=true", async () => {
    const sink: CapturedAudit[] = [];
    captureAudits(sink);
    const { config, meta, root } = await proofEnv(BAD_ID_DOC);
    try {
      const { execFn } = makeGit({
        ...healthyRules(),
        "cat-file -e dead0001": fail("fatal: Not a valid object name", 128),
      });
      const verifyConfig: VerifyConfig = { require: true, requireCommitProof: true };
      const out = await reconcileCommitProof(config, meta, verifyConfig, execFn);
      expect(out).toHaveLength(1);
      expect(out[0].group).toBe("commit_proof");
      expect(out[0].ruleType).toBe("commit_exists");
      expect(sink.find((e) => e.event === "commit_proof_violation")?.fields.enforced).toBe("true");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("stage-level false beats global true (precedence chain)", async () => {
    const sink: CapturedAudit[] = [];
    captureAudits(sink);
    const { config, meta, root } = await proofEnv(BAD_ID_DOC);
    try {
      config.verify = { requireCommitProof: true };
      const { execFn } = makeGit({
        ...healthyRules(),
        "cat-file -e dead0001": fail("fatal: Not a valid object name", 128),
      });
      const out = await reconcileCommitProof(config, meta, { require: true, requireCommitProof: false }, execFn);
      expect(out).toEqual([]);
      expect(sink.find((e) => e.event === "commit_proof_violation")?.fields.enforced).toBe("false");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("global true applies when the stage omits the switch", async () => {
    const sink: CapturedAudit[] = [];
    captureAudits(sink);
    const { config, meta, root } = await proofEnv(BAD_ID_DOC);
    try {
      config.verify = { requireCommitProof: true };
      const { execFn } = makeGit({
        ...healthyRules(),
        "cat-file -e dead0001": fail("fatal: Not a valid object name", 128),
      });
      const out = await reconcileCommitProof(config, meta, { require: true }, execFn);
      expect(out).toHaveLength(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("switch ON without execFn → commit_proof_error (error level), fail-open", async () => {
    const sink: CapturedAudit[] = [];
    captureAudits(sink);
    const { config, meta, root } = await proofEnv(BAD_ID_DOC);
    try {
      const out = await reconcileCommitProof(config, meta, { require: true, requireCommitProof: true }, undefined);
      expect(out).toEqual([]);
      const err = sink.find((e) => e.event === "commit_proof_error");
      expect(err?.level).toBe("error");
      expect(String(err?.fields.error)).toContain("execFn unavailable");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("switch OFF without execFn → completely silent (no error-audit spam)", async () => {
    const sink: CapturedAudit[] = [];
    captureAudits(sink);
    const { config, meta, root } = await proofEnv(BAD_ID_DOC);
    try {
      expect(await reconcileCommitProof(config, meta, { require: true }, undefined)).toEqual([]);
      expect(sink).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("clean run (fresh commits, matching plan doc) → only commit_proof_checked, no violations", async () => {
    const sink: CapturedAudit[] = [];
    captureAudits(sink);
    const { config, meta, root } = await proofEnv(BAD_ID_DOC);
    try {
      // dead0001 now EXISTS and is fresh → nothing to report at all.
      const { execFn } = makeGit(healthyRules());
      const out = await reconcileCommitProof(config, meta, { require: true, requireCommitProof: true }, execFn);
      expect(out).toEqual([]);
      // 210 review issue 10 (requirement 5.7): a reconciled-clean run must be
      // distinguishable from "never reconciled" — exactly one info-level
      // `commit_proof_checked` row, and no violation/skip/error rows.
      const proofEvents = sink.filter((e) => e.event.startsWith("commit_proof"));
      expect(proofEvents.map((e) => e.event)).toEqual(["commit_proof_checked"]);
      expect(proofEvents[0]!.level).toBe("info");
      expect(proofEvents[0]!.fields["checked"]).toBe("1");
      expect(proofEvents[0]!.fields["violations"]).toBe("0");
      expect(proofEvents[0]!.fields["enforced"]).toBe("true");
      // Develop FIRST visit keeps the strict stage-entry baseline (issue 1).
      expect(proofEvents[0]!.fields["c2Baseline"]).toBe("develop stage entry (first visit)");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  // 210 review issue 1 (High) — the exact false-positive scenario: a develop
  // commit is legitimately older than the REVIEW stage's entry clock, because
  // review starts after develop finished. Comparing to `meta.stageStartTime`
  // flagged every valid commit as `commit_after_stage_start`.
  it("review stage: a develop commit predating the review entry still PASSES", async () => {
    const sink: CapturedAudit[] = [];
    captureAudits(sink);
    const { config, meta, root } = await proofEnv(BAD_ID_DOC);
    try {
      const now = Date.now();
      meta.currentStage = "review";
      meta.previousStage = "develop";
      meta.pipelineStartedAt = now - 2 * 3_600_000;
      meta.stageStartTime = now;
      meta.stageVisitOrder = ["clarify", "plan", "develop", "review"];
      // dead0001 was created an hour ago: inside the run, long before review.
      const { execFn } = makeGit(healthyRules(Math.floor((now - 3_600_000) / 1000)));
      const out = await reconcileCommitProof(config, meta, { require: true, requireCommitProof: true }, execFn);
      expect(out).toEqual([]);
      const checked = sink.find((e) => e.event === "commit_proof_checked");
      expect(checked?.fields["c2Baseline"]).toBe("pipeline run start");
      expect(checked?.fields["violations"]).toBe("0");
      expect(sink.filter((e) => e.event === "commit_proof_violation")).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("review stage: a commit predating the RUN is still flagged (no over-relaxation)", async () => {
    const sink: CapturedAudit[] = [];
    captureAudits(sink);
    const { config, meta, root } = await proofEnv(BAD_ID_DOC);
    try {
      const now = Date.now();
      meta.currentStage = "review";
      meta.pipelineStartedAt = now - 2 * 3_600_000;
      meta.stageStartTime = now;
      meta.stageVisitOrder = ["clarify", "plan", "develop", "review"];
      // Ten hours old — from a previous run/branch → must still fail C2.
      const { execFn } = makeGit(healthyRules(Math.floor((now - 10 * 3_600_000) / 1000)));
      const out = await reconcileCommitProof(config, meta, { require: true, requireCommitProof: true }, execFn);
      expect(out.map((f) => f.ruleType)).toEqual(["commit_after_stage_start"]);
      expect(out[0]!.detail).toContain("pipeline run start");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
