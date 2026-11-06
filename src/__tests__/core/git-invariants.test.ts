/**
 * 225 Phase 5 (T2/D8): branch + stash invariants.
 *
 * Contract points (all with a FAKE execFn — never real git):
 * - sampling: ONCE per visit (stageStartTime identity); exec failure / no exec
 *   ⇒ NO baseline (fail-open); stage must be a commit-contract stage;
 * - off-switch precedence: stage-level false > global true; contract default;
 * - assertions: branch drift (detached "" baseline never drifts), stash added,
 *   stash removed (NOT a failure), failures carry group `git_invariant`;
 * - manual-mode parity: the matrix-default allow WITHOUT a stage key still
 *   samples (the contract judgement, not `gitModify === "allow"`, is the gate);
 * - unobserved write: HEAD moved with `gitAllowedWrites === 0` → WARN only,
 *   no failure; any allowed write recorded → silent.
 */

import { describe, it, expect, afterEach } from "bun:test";
import { ensureGitInvariantBaseline, reconcileGitInvariants, GIT_INVARIANT_GROUP } from "../../core/git-invariants";
import { __setSafeWriteAuditLogOverride } from "../../utils/auditLog";
import { makeTestConfig, makeTestMeta, deployDispatchAssets } from "../helpers";
import type { ExecFn, PipelineConfig, SessionMeta } from "../../types";

const audits: { event: string; fields: Record<string, string | boolean>; level?: string }[] = [];

afterEach(() => {
  __setSafeWriteAuditLogOverride(null);
  audits.length = 0;
});

function installAuditCapture(): void {
  audits.length = 0;
  __setSafeWriteAuditLogOverride((stage: string, payload?: Record<string, string | boolean>, level?: string) => {
    audits.push({ event: stage, fields: (payload ?? {}) as Record<string, string | boolean>, level });
    return Promise.resolve();
  });
}

/** Fake git driver: longest-prefix match (mirror of commit-proof.test.ts's). */
function makeGit(rules: Record<string, { stdout?: string; stderr?: string; code?: number }>) {
  const ordered = Object.entries(rules).sort((a, b) => b[0].length - a[0].length);
  const execFn: ExecFn = async (_cmd, args) => {
    const key = args.join(" ");
    for (const [prefix, res] of ordered) {
      if (key.startsWith(prefix)) {
        return { stdout: res.stdout ?? "", stderr: res.stderr ?? "", code: res.code ?? 0 };
      }
    }
    return { stdout: "", stderr: `unmocked: ${key}`, code: 1 };
  };
  return { execFn };
}

function contractConfig(stage = "fix"): PipelineConfig {
  const config = makeTestConfig();
  // Commit-contract stage: deployed verify spec with requiredGit.
  const dir = (config.stages as Record<string, { agentPath?: string }>)[stage] ?? {};
  dir.agentPath = ".pi/agents/test-agent.md";
  (config.stages as Record<string, unknown>)[stage] = dir;
  deployDispatchAssets(config);
  const specDir = `${config.projectRoot}/.pi/references/${stage}_spec`;
  fsMkdir(specDir);
  fsWrite(`${specDir}/verify.md`, "---\nrules:\n  path: \"{designDir}/*_Develop_Commit.md\"\n  groups:\n    - name: commit-ready\n      ruleMode: and\n      rules:\n        - type: requiredGit\n          cleanWorkingTree: true\n---\nbody");
  return config;
}

import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function fsMkdir(p: string): void {
  fs.mkdirSync(p, { recursive: true });
}
function fsWrite(p: string, content: string): void {
  fs.writeFileSync(p, content, "utf-8");
}

const HEALTHY = {
  "branch --show-current": { stdout: "fix/my-branch\n" },
  "rev-parse HEAD": { stdout: "abc123def456\n" },
  "stash list": { stdout: "" },
};

function fixture(stage = "fix", now = Date.now()) {
  const config = contractConfig(stage);
  const meta = makeTestMeta({ currentStage: stage as never, stageStartTime: now });
  const session = {
    getMeta: () => meta,
    updateMeta: (patch: Partial<SessionMeta>) => {
      Object.assign(meta, patch);
      return meta;
    },
  };
  const { execFn } = makeGit(HEALTHY);
  return { config, meta, session, execFn };
}

// ─── Sampling ────────────────────────────────────────────────────────────────

describe("ensureGitInvariantBaseline — sampling", () => {
  it("records the baseline once per visit (idempotent)", async () => {
    installAuditCapture();
    const { config, meta, session, execFn } = fixture();
    await ensureGitInvariantBaseline(config, meta, session, "fix", execFn);
    const first = meta.gitInvariantBaseline;
    expect(first).toBeDefined();
    expect(first!.branch).toBe("fix/my-branch");
    expect(first!.stashCount).toBe(0);
    const recordedAt = first!.recordedAt;
    // A second git write in the same visit does NOT re-sample.
    await ensureGitInvariantBaseline(config, meta, session, "fix", execFn);
    expect(meta.gitInvariantBaseline!.recordedAt).toBe(recordedAt);
    expect(audits.filter((a) => a.event === "git_invariant_baseline")).toHaveLength(1);
  });

  it("exec failure ⇒ NO baseline (fail-open)", async () => {
    installAuditCapture();
    const { config, meta, session, execFn } = fixture();
    const broken = makeGit({
      "branch --show-current": { code: 128, stderr: "fatal" },
      "rev-parse HEAD": { stdout: "abc\n" },
      "stash list": { stdout: "" },
    });
    await ensureGitInvariantBaseline(config, meta, session, "fix", broken.execFn);
    expect(meta.gitInvariantBaseline).toBeUndefined();
    expect(audits.some((a) => a.event === "git_invariant_sample_skipped")).toBe(true);
  });

  it("no execFn ⇒ skip silently (no baseline, no throw)", async () => {
    installAuditCapture();
    const { config, meta, session } = fixture();
    await ensureGitInvariantBaseline(config, meta, session, "fix", undefined);
    expect(meta.gitInvariantBaseline).toBeUndefined();
  });

  it("MANUAL parity: matrix allow WITHOUT stage key still samples (contract gate)", async () => {
    installAuditCapture();
    const config = contractConfig(); // requiredGit spec deployed, no protect key
    // Global protect block simulates the job but the stage key stays absent
    // (this is the manual develop/fix shape: matrix=allow, no stage key).
    const meta = makeTestMeta({ currentStage: "fix" });
    const session = {
      getMeta: () => meta,
      updateMeta: (patch: Partial<SessionMeta>) => {
        Object.assign(meta, patch);
        return meta;
      },
    };
    const { execFn } = makeGit(HEALTHY);
    await ensureGitInvariantBaseline(config, meta, session, "fix", execFn);
    expect(meta.gitInvariantBaseline).toBeDefined();
  });

  it("non-contract stages (review / plan) never sample", async () => {
    installAuditCapture();
    const { config, meta, session } = fixture("review");
    const reviewDir = `${config.projectRoot}/.pi/references/review_spec`;
    fsMkdir(reviewDir);
    fsWrite(`${reviewDir}/verify.md`, "---\nrules:\n  path: \"{reviewDir}/*\"\n  groups:\n    - name: conclusion\n      ruleMode: and\n      rules:\n        - type: fileContentPattern\n---\nbody");
    const { execFn } = makeGit(HEALTHY);
    await ensureGitInvariantBaseline(config, meta, session, "review", execFn);
    expect(meta.gitInvariantBaseline).toBeUndefined();
    expect(audits.filter((a) => a.event === "git_invariant_baseline")).toHaveLength(0);
  });

  it("requireGitInvariants: stage-level false beats global true", async () => {
    installAuditCapture();
    const config = contractConfig();
    config.verify = { requireGitInvariants: true };
    config.stages.fix.verify = { require: true, requireGitInvariants: false };
    const meta = makeTestMeta({ currentStage: "fix" });
    const session = {
      getMeta: () => meta,
      updateMeta: (patch: Partial<SessionMeta>) => {
        Object.assign(meta, patch);
        return meta;
      },
    };
    const { execFn } = makeGit(HEALTHY);
    await ensureGitInvariantBaseline(config, meta, session, "fix", execFn);
    expect(meta.gitInvariantBaseline).toBeUndefined();
  });
});

// ─── Assertions ──────────────────────────────────────────────────────────────

describe("reconcileGitInvariants — assertions", () => {
  it("branch drift ⇒ failure with the git_invariant group", async () => {
    const { config, meta } = fixture();
    meta.gitInvariantBaseline = {
      branch: "fix/a",
      headSha: "aaa",
      stashCount: 0,
      allowedWritesAtBaseline: 0,
      stage: "fix",
      stageStartTime: meta.stageStartTime,
      recordedAt: 1,
    };
    const { execFn } = makeGit({
      "branch --show-current": { stdout: "fix/b\n" },
      "rev-parse HEAD": { stdout: "bbb\n" },
      "stash list": { stdout: "" },
    });
    const failures = await reconcileGitInvariants(config, meta, undefined, execFn);
    expect(failures).toHaveLength(1);
    expect(failures[0].ruleType).toBe("branch_drift");
    expect((failures[0] as { group?: string }).group).toBe(GIT_INVARIANT_GROUP);
  });

  it("detached-HEAD baseline (\"\") never drifts", async () => {
    const { config, meta } = fixture();
    meta.gitInvariantBaseline = {
      branch: "",
      headSha: "aaa",
      stashCount: 0,
      allowedWritesAtBaseline: 0,
      stage: "fix",
      stageStartTime: meta.stageStartTime,
      recordedAt: 1,
    };
    const { execFn } = makeGit({
      "branch --show-current": { stdout: "" },
      "rev-parse HEAD": { stdout: "bbb\n" },
      "stash list": { stdout: "" },
    });
    const failures = await reconcileGitInvariants(config, meta, undefined, execFn);
    expect(failures).toHaveLength(0);
  });

  it("stash ADDED ⇒ failure; stash REMOVED ⇒ not a failure", async () => {
    const { config, meta, } = fixture();
    meta.gitInvariantBaseline = {
      branch: "fix/a",
      headSha: "aaa",
      stashCount: 1,
      allowedWritesAtBaseline: 0,
      stage: "fix",
      stageStartTime: meta.stageStartTime,
      recordedAt: 1,
    };
    const added = makeGit({
      "branch --show-current": { stdout: "fix/a\n" },
      "rev-parse HEAD": { stdout: "aaa\n" },
      "stash list": { stdout: "stash@{0}\nstash@{1}\n" },
    });
    let failures = await reconcileGitInvariants(config, meta, undefined, added.execFn);
    expect(failures).toHaveLength(1);
    expect(failures[0].ruleType).toBe("stash_hidden");
    expect((failures[0] as { group?: string }).group).toBe(GIT_INVARIANT_GROUP);

    const removed = makeGit({
      "branch --show-current": { stdout: "fix/a\n" },
      "rev-parse HEAD": { stdout: "aaa\n" },
      "stash list": { stdout: "" },
    });
    failures = await reconcileGitInvariants(config, meta, undefined, removed.execFn);
    expect(failures).toHaveLength(0);
  });

  it("requireGitInvariants: stage-level false beats global true at reconcile too", async () => {
    const { config, meta } = fixture();
    config.verify = { requireGitInvariants: true };
    config.stages.fix.verify = { require: true, requireGitInvariants: false };
    meta.gitInvariantBaseline = {
      branch: "fix/a",
      headSha: "aaa",
      stashCount: 0,
      allowedWritesAtBaseline: 0,
      stage: "fix",
      stageStartTime: meta.stageStartTime,
      recordedAt: 1,
    };
    const { execFn } = makeGit({
      "branch --show-current": { stdout: "fix/other\n" },
      "rev-parse HEAD": { stdout: "bbb\n" },
      "stash list": { stdout: "" },
    });
    // auto-verifier passes the stage's RESOLVED verify block as the argument.
    expect(await reconcileGitInvariants(config, meta, config.stages.fix.verify, execFn)).toEqual([]);
  });
});

// ─── Unobserved write warning ────────────────────────────────────────────────

describe("reconcileGitInvariants — unobserved write warning", () => {
  function withBaseline(meta: SessionMeta): void {
    meta.gitInvariantBaseline = {
      branch: "fix/a",
      headSha: "aaaaaaaaaaaa",
      stashCount: 0,
      allowedWritesAtBaseline: 0,
      stage: "fix",
      stageStartTime: meta.stageStartTime,
      recordedAt: 1,
    };
  }
  const HEAD_MOVED = {
    "branch --show-current": { stdout: "fix/a\n" },
    "rev-parse HEAD": { stdout: "bbbbbbbbbbbb\n" },
    "stash list": { stdout: "" },
  };

  it("HEAD moved + zero allowed writes → WARN only, no failure", async () => {
    installAuditCapture();
    const { config, meta } = fixture();
    withBaseline(meta);
    const { execFn } = makeGit(HEAD_MOVED);
    const failures = await reconcileGitInvariants(config, meta, undefined, execFn);
    expect(failures).toEqual([]);
    const warn = audits.find((a) => a.event === "git_write_unobserved");
    expect(warn?.level).toBe("warn");
    expect(warn?.fields.baselineHead).toBe("aaaaaaaaaaaa".slice(0, 12));
  });

  it("HEAD moved + recorded allowed writes → silent (read from Phase 0's counter)", async () => {
    installAuditCapture();
    const { config, meta } = fixture();
    withBaseline(meta);
    meta.gitAllowedWrites = 2;
    const { execFn } = makeGit(HEAD_MOVED);
    const failures = await reconcileGitInvariants(config, meta, undefined, execFn);
    expect(failures).toEqual([]);
    expect(audits.some((a) => a.event === "git_write_unobserved")).toBe(false);
  });

  // 225 code-review fix (issue 4 / F7.2): writes from an EARLIER stage of the
  // same period must NOT silence this visit's check — a stage with zero
  // allowed writes of its own still warns when HEAD moved.
  it("HEAD moved + writes accumulated in an EARLIER stage (zero in this visit) → WARN fires", async () => {
    installAuditCapture();
    const { config, meta } = fixture();
    withBaseline(meta);
    // The period counter already holds develop-stage writes; the baseline
    // snapshot captured the SAME value at this visit's entry, so this readonly
    // visit recorded nothing while HEAD still moved.
    meta.gitAllowedWrites = 0;
    meta.gitInvariantBaseline = {
      ...meta.gitInvariantBaseline!,
      headSha: "aaaaaaaaaaaa",
      allowedWritesAtBaseline: 2,
      stageStartTime: meta.stageStartTime,
    };
    const { execFn } = makeGit(HEAD_MOVED);
    const failures = await reconcileGitInvariants(config, meta, undefined, execFn);
    expect(failures).toEqual([]);
    expect(audits.some((a) => a.event === "git_write_unobserved")).toBe(true);
  });

  it("HEAD moved + allowed writes DURING this visit (delta > 0) → silent", async () => {
    installAuditCapture();
    const { config, meta } = fixture();
    withBaseline(meta);
    // Earlier stage accumulated 2; this visit recorded 1 more (period total 3)
    // → observed, no warning.
    meta.gitAllowedWrites = 3;
    const { execFn } = makeGit(HEAD_MOVED);
    const failures = await reconcileGitInvariants(config, meta, undefined, execFn);
    expect(failures).toEqual([]);
    expect(audits.some((a) => a.event === "git_write_unobserved")).toBe(false);
  });
});
