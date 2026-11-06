/**
 * 225 Phase 5 (T4): `runVerification` folds the git invariant failures into
 * the structured failure set — `passed=false` with the `git_invariant` group,
 * riding the same failure channel the commit-prod reconciliation uses.
 */

import { describe, it, expect, afterEach } from "bun:test";
import { runVerification } from "../../core/auto-verifier";
import { GIT_INVARIANT_GROUP } from "../../core/git-invariants";
import { __setSafeWriteAuditLogOverride } from "../../utils/auditLog";
import { makeTestConfig, makeTestMeta, deployDispatchAssets } from "../helpers";
import type { ExecFn, PipelineConfig, SessionMeta } from "../../types";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const audits: { event: string; fields: Record<string, string | boolean> }[] = [];

afterEach(() => {
  __setSafeWriteAuditLogOverride(null);
  audits.length = 0;
});

function capture(): void {
  audits.length = 0;
  __setSafeWriteAuditLogOverride((stage: string, payload?: Record<string, string | boolean>) => {
    audits.push({ event: stage, fields: (payload ?? {}) as Record<string, string | boolean> });
    return Promise.resolve();
  });
}

function verifyFixture(stage: "fix" | "develop", requiredFile: string) {
  const projectRoot = fs.mkdtempSync(join(tmpdir(), "verifier-invariants-"));
  const config = makeTestConfig({ projectRoot });
  deployDispatchAssets(config);
  const specDir = join(projectRoot, ".pi", "references", `${stage}_spec`);
  fs.mkdirSync(specDir, { recursive: true });
  fs.writeFileSync(
    join(specDir, "verify.md"),
    "---\nrules:\n  path: \"{designDir}/*_Develop_Commit.md\"\n  groups:\n    - name: commit-ready\n      ruleMode: and\n      rules:\n        - type: requiredFile\n        - type: requiredGit\n          cleanWorkingTree: true\n---\nbody",
    "utf-8",
  );
  // The required deliverable must exist so ONLY the invariant can fail.
  const commitDoc = join(projectRoot, requiredFile);
  fs.mkdirSync(join(commitDoc, ".."), { recursive: true });
  fs.writeFileSync(commitDoc, "# plan & commit id's\n**dev commit id**: aaaa1111\n", "utf-8");
  const meta: SessionMeta = makeTestMeta({ currentStage: stage, requirementDoc: "docs/design/225_Bug.md" });
  config.stages[stage].verify = { require: true, selfVerifySkip: false };
  const gitRules = {
    "branch --show-current": { stdout: "", stderr: "", code: 0 },
    "rev-parse HEAD": { stdout: "aaaaaaaaaaaa\n", stderr: "", code: 0 },
    "stash list": { stdout: "", stderr: "", code: 0 },
    "cat-file -e": { stdout: "", stderr: "", code: 0 },
    "cat-file -e aaaa1111": { stdout: "", stderr: "", code: 0 },
    "show -s --format=%ct": { stdout: String(Math.floor(Date.now() / 1000)), stderr: "", code: 0 },
    "rev-parse --git-dir": { stdout: ".git\n", stderr: "", code: 0 },
  };
  const ordered = Object.entries(gitRules).sort((a, b) => b[0].length - a[0].length);
  const execFn: ExecFn = async (_cmd, args) => {
    const key = args.join(" ");
    for (const [prefix, res] of ordered) {
      if (key.startsWith(prefix)) return { stdout: res.stdout ?? "", stderr: "", code: res.code ?? 0 };
    }
    return { stdout: "", stderr: `unmocked: ${key}`, code: 1 };
  };
  return { config, meta, execFn, projectRoot, requiredFile };
}

describe("runVerification folds git invariant failures", () => {
  it("a recorded baseline with branch drift → passed=false, git_invariant group in failures", async () => {
    capture();
    const { config, meta, execFn, projectRoot } = verifyFixture("fix", "docs/design/225_Bug_Develop_Commit.md");
    // Phase 5 tool-guard sampled this baseline during the visit; simulate a
    // mid-stage branch switch AFTER the sample.
    meta.stageStartTime = Date.now();
    meta.gitInvariantBaseline = {
      branch: "fix/original",
      headSha: "aaaaaaaaaaaa",
      stashCount: 0,
      stage: "fix",
      stageStartTime: meta.stageStartTime,
      recordedAt: 1,
    };
    // Re-mock with the drifted branch state (matches the recorded baseline for
    // everything else, so ONLY the branch assertion can fail).
    const execFn2: ExecFn = async (_cmd, args, _cwd) => {
      const key = args.join(" ");
      if (key.startsWith("branch --show-current")) return { stdout: "fix/elsewhere\n", stderr: "", code: 0 };
      if (key.startsWith("rev-parse HEAD") && !key.startsWith("rev-parse --git-dir")) return { stdout: "aaaaaaaaaaaa\n", stderr: "", code: 0 };
      return execFn(_cmd, args, _cwd);
    };
    const result = await runVerification(config, meta, ["Ready for verify."], { execFn: execFn2 });
    expect(result.structuredResult!.passed).toBe(false);
    const drift = result.structuredResult!.failures.find((f) => f.ruleType === "branch_drift");
    expect(drift?.group).toBe(GIT_INVARIANT_GROUP);
    void projectRoot;
  });

  it("no baseline recorded (no git writes) → invariant layer stays silent, verify proceeds normally", async () => {
    capture();
    const { config, meta, execFn } = verifyFixture("develop", "docs/design/225_Bug_Develop_Commit.md");
    meta.stageStartTime = Date.now();
    const result = await runVerification(config, meta, ["Ready for verify."], { execFn });
    expect(result.structuredResult!.failures.some((f) => f.group === GIT_INVARIANT_GROUP)).toBe(false);
  });
});
