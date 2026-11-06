/**
 * 225 Phase 0: commit-contract derivation, elevation branches, caching and
 * JSON-config wiring tests.
 *
 * Key contract points under test:
 * - `requiredGit` presence (any shape) = a commit contract stage (Q8-A).
 * - Elevation branch 1: non-contract stages are untouched.
 * - Elevation branch 2: explicit opt-out (`requireCommitContract: false`,
 *   stage-level over global-level) → no elevation + error audit.
 * - Elevation branch 3: contract stage with effective non-allow policy →
 *   in-memory stage-level `gitModify: "allow"` + audit (fields fixed).
 * - Idempotence: second call audits nothing; cached resolution does not
 *   re-read the verify file.
 * - The full `loadJsonConfig → resolvePipelineConfig` production chain feeds
 *   the switch (not only hand-built PipelineConfig objects).
 * - Elevation is memory-only: the on-disk pipeline_loop.json is unchanged.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import {
  hasCommitRequirement,
  resolveStageCommitContract,
  ensureCommitContractElevation,
} from "../../core/commit-contract";
import { resolveGitModifyPolicy } from "../../utils/protect";
import { loadJsonConfig, resolvePipelineConfig } from "../../core/json-config-loader";
import { __setSafeWriteAuditLogOverride } from "../../utils/auditLog";
import { makeTestConfig } from "../helpers";
import type { PipelineConfig, PipelineStage } from "../../types";

let TMP: string;
let config: PipelineConfig;

const VERIFY_BODY =
  "验证 develop 已提交。";

/** Minimal verify.md with a requiredGit rule (a commit contract). */
const CONTRACT_VERIFY_MD =
  "---\nrules:\n  path: \"{designDir}/*_Develop_Commit.md\"\n  groups:\n    - name: commit-ready\n      ruleMode: and\n      rules:\n        - type: requiredGit\n          cleanWorkingTree: true\n---\n" +
  VERIFY_BODY;

const CONTRACT_VERIFY_MD_BRANCH_ONLY =
  CONTRACT_VERIFY_MD.replace("          cleanWorkingTree: true", "          branch: main");

/** Minimal verify.md WITHOUT any requiredGit rule (not a contract stage). */
const PLAIN_VERIFY_MD =
  "---\nrules:\n  path: \"{designDir}/*_Plan.md\"\n  groups:\n    - name: plan-ready\n      ruleMode: and\n      rules:\n        - type: requiredFile\n---\n" +
  VERIFY_BODY;

function verifySpecPath(stage: PipelineStage): string {
  return path.join(TMP, ".pi", "references", `${stage}_spec`, "verify.md");
}

async function writeVerifySpec(stage: PipelineStage, content: string): Promise<void> {
  const p = verifySpecPath(stage);
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, content, "utf-8");
}

beforeEach(async () => {
  TMP = path.join(tmpdir(), "commit-contract-test-" + Date.now());
  await fs.mkdir(TMP, { recursive: true });
  config = makeTestConfig({ projectRoot: TMP });
  config.protect = { ...(config.protect ?? {}), gitModify: "block" } as PipelineConfig["protect"];
});

afterEach(async () => {
  await fs.rm(TMP, { recursive: true, force: true });
});

// ─── Judgement ───────────────────────────────────────────────────────────────

describe("hasCommitRequirement", () => {
  it("true when requiredGit is present, false when null/absent", () => {
    expect(hasCommitRequirement({ requiredGit: { cleanWorkingTree: true } } as never)).toBe(true);
    expect(hasCommitRequirement(null)).toBe(false);
    expect(hasCommitRequirement({} as never)).toBe(false);
  });
});

describe("resolveStageCommitContract (judgement)", () => {
  it("requiredGit with cleanWorkingTree → contract stage", async () => {
    await writeVerifySpec("develop", CONTRACT_VERIFY_MD);
    const contract = await resolveStageCommitContract(config, "develop");
    expect(contract.requiresCommit).toBe(true);
    expect(contract.enabled).toBe(true);
    expect(contract.verifySpecPath).toContain(".pi/references/develop_spec/verify.md");
  });

  it("requiredGit.branch without cleanWorkingTree is STILL a contract stage (Q8-A)", async () => {
    await writeVerifySpec("develop", CONTRACT_VERIFY_MD_BRANCH_ONLY);
    const contract = await resolveStageCommitContract(config, "develop");
    expect(contract.requiresCommit).toBe(true);
  });

  it("verify spec without requiredGit → not a contract stage", async () => {
    await writeVerifySpec("develop", PLAIN_VERIFY_MD);
    const contract = await resolveStageCommitContract(config, "develop");
    expect(contract.requiresCommit).toBe(false);
  });

  it("missing verify file / unparsable frontmatter → no judgement, no throw", async () => {
    // Missing file entirely.
    const missing = await resolveStageCommitContract(config, "develop");
    expect(missing.requiresCommit).toBe(false);

    // Unparsable frontmatter (no --- delimiter).
    await writeVerifySpec("review", "no frontmatter here");
    const broken = await resolveStageCommitContract(config, "review");
    expect(broken.requiresCommit).toBe(false);
  });
});

// ─── Elevation branches ──────────────────────────────────────────────────────

describe("ensureCommitContractElevation (three branches)", () => {
  it("branch 1: non-contract stage → no stage key, no elevation", async () => {
    await writeVerifySpec("review", PLAIN_VERIFY_MD);
    const result = await ensureCommitContractElevation(config, "review");
    expect(result.elevated).toBe(false);
    expect(result.disabled).toBe(false);
    expect(config.stages.review.protect).toBeUndefined();
    // review stays blocked by the global override.
    expect(resolveGitModifyPolicy(config, null, "review")).toBe("block");
  });

  it("branch 2: completed/awaiting_human without specs are not elevated (no spec on disk)", async () => {
    const result = await ensureCommitContractElevation(config, "awaiting_human");
    expect(result.contract.requiresCommit).toBe(false);
    expect(result.elevated).toBe(false);
    expect(resolveGitModifyPolicy(config, null, "awaiting_human")).toBe("block");
  });

  it("branch 2: explicit opt-out → disabled=true, no elevation (audited separately below)", async () => {
    await writeVerifySpec("fix", CONTRACT_VERIFY_MD);
    config.stages.fix.verify = { requireCommitContract: false };
    const result = await ensureCommitContractElevation(config, "fix");
    expect(result.disabled).toBe(true);
    expect(result.elevated).toBe(false);
    expect(config.stages.fix.protect).toBeUndefined();
    expect(resolveGitModifyPolicy(config, null, "fix")).toBe("block");
  });

  it("stage-level false beats global-level true", async () => {
    await writeVerifySpec("fix", CONTRACT_VERIFY_MD);
    config.verify = { requireCommitContract: true };
    config.stages.fix.verify = { requireCommitContract: false };
    const result = await ensureCommitContractElevation(config, "fix");
    expect(result.disabled).toBe(true);
  });

  it("branch 3: job-wide block + contract stage → elevated to stage-level allow", async () => {
    await writeVerifySpec("fix", CONTRACT_VERIFY_MD);
    const before = resolveGitModifyPolicy(config, null, "fix");
    expect(before).toBe("block"); // global block in the beforeEach
    const result = await ensureCommitContractElevation(config, "fix");
    expect(result.elevated).toBe(true);
    expect(config.stages.fix.protect?.gitModify).toBe("allow");
    expect(resolveGitModifyPolicy(config, null, "fix")).toBe("allow");
  });

  it("branch 3 no-op: before === allow → no rewrite, no elevation", async () => {
    await writeVerifySpec("fix", CONTRACT_VERIFY_MD);
    config.stages.fix.protect = { gitModify: "allow" };
    const result = await ensureCommitContractElevation(config, "fix");
    expect(result.elevated).toBe(false);
    expect(result.disabled).toBe(false);
    // The pre-existing stage key is untouched (same object identity).
    expect(config.stages.fix.protect).toEqual({ gitModify: "allow" });
  });

  it("idempotent: the second prompt in the same session elevates nothing new", async () => {
    await writeVerifySpec("fix", CONTRACT_VERIFY_MD);
    const first = await ensureCommitContractElevation(config, "fix");
    expect(first.elevated).toBe(true);
    const protectAfterFirst = config.stages.fix.protect;
    const second = await ensureCommitContractElevation(config, "fix");
    expect(second.elevated).toBe(false); // before === "allow" now
    expect(second.disabled).toBe(false);
    expect(config.stages.fix.protect).toBe(protectAfterFirst);
  });

  it("elevation is memory-only: the on-disk pipeline_loop.json is byte-identical", async () => {
    await writeVerifySpec("fix", CONTRACT_VERIFY_MD);
    const jsonPath = path.join(TMP, "pipeline_loop.json");
    const original = JSON.stringify(
      { stages: { fix: { protect: { gitModify: "block" } } } },
      null,
      2,
    );
    await fs.writeFile(jsonPath, original, "utf-8");
    const mtimeBefore = statSync(jsonPath).mtimeMs;

    await ensureCommitContractElevation(config, "fix");
    expect(config.stages.fix.protect?.gitModify).toBe("allow");
    expect(readFileSync(jsonPath, "utf-8")).toBe(original);
    expect(statSync(jsonPath).mtimeMs).toBe(mtimeBefore);
  });
});

// ─── Contract resolution caching ─────────────────────────────────────────────

describe("resolveStageCommitContract caching", () => {
  it("same config + stage reads the verify spec once (cache survives file deletion)", async () => {
    await writeVerifySpec("fix", CONTRACT_VERIFY_MD);
    const first = await resolveStageCommitContract(config, "fix");
    expect(first.requiresCommit).toBe(true);
    // Delete the spec: a re-read would flip requiresCommit to false, the cache
    // must keep the resolved answer.
    await fs.rm(verifySpecPath("fix"));
    const second = await resolveStageCommitContract(config, "fix");
    expect(second.requiresCommit).toBe(true);
  });

  it("different stages of the same config cache independently", async () => {
    await writeVerifySpec("develop", CONTRACT_VERIFY_MD);
    const dev = await resolveStageCommitContract(config, "develop");
    const fix = await resolveStageCommitContract(config, "fix");
    expect(dev.requiresCommit).toBe(true);
    expect(fix.requiresCommit).toBe(false);
  });
});

// ─── Audit facts ─────────────────────────────────────────────────────────────

describe("audit facts", () => {
  const audits: { event: string; payload?: Record<string, unknown>; line?: string }[] = [];

  afterEach(() => {
    __setSafeWriteAuditLogOverride(null);
  });

  function installAuditCapture(): void {
    audits.length = 0;
    __setSafeWriteAuditLogOverride((stage: string, payload?: Record<string, string | boolean>, level?: string) => {
      audits.push({ event: stage, payload, line: level });
      return Promise.resolve();
    });
  }

  function lineOf(event: string): string | undefined {
    const a = audits.find((x) => x.event === event);
    if (!a) return undefined;
    return Object.entries(a.payload ?? {})
      .map(([k, v]) => `${k}=${v}`)
      .join(" | ");
  }

  it("writes git_policy_contract_elevated exactly once per config+stage with fixed fields", async () => {
    installAuditCapture();
    await writeVerifySpec("fix", CONTRACT_VERIFY_MD);
    await ensureCommitContractElevation(config, "fix");
    await ensureCommitContractElevation(config, "fix");
    const elevated = audits.filter((a) => a.event === "git_policy_contract_elevated");
    expect(elevated.length).toBe(1);
    const line = lineOf("git_policy_contract_elevated") ?? "";
    expect(line).toContain("stage=fix");
    expect(line).toContain("to=allow");
    expect(line).toContain("from=block");
    expect(line).toContain("globalValue=block");
    expect(line).toContain("verifySpec=.pi/references/fix_spec/verify.md");
  });

  it("disabled branch audits commit_contract_capability_disabled once (error level)", async () => {
    installAuditCapture();
    await writeVerifySpec("fix", CONTRACT_VERIFY_MD);
    config.stages.fix.verify = { requireCommitContract: false };
    await ensureCommitContractElevation(config, "fix");
    await ensureCommitContractElevation(config, "fix");
    const disabled = audits.filter((a) => a.event === "commit_contract_capability_disabled");
    expect(disabled.length).toBe(1);
    expect(disabled[0].line).toBe("error");
    expect(disabled[0].payload?.stage).toBe("fix");
  });
});

// ─── Production JSON chain ───────────────────────────────────────────────────

describe("loadJsonConfig → resolvePipelineConfig chain", () => {
  let jsonTmp: string;
  let jsonPath: string;

  beforeEach(async () => {
    jsonTmp = path.join(tmpdir(), "commit-contract-json-" + Date.now());
    await fs.mkdir(jsonTmp, { recursive: true });
    jsonPath = path.join(jsonTmp, "pipeline_loop.json");
    await writeVerifySpec("fix", CONTRACT_VERIFY_MD);
  });

  afterEach(async () => {
    await fs.rm(jsonTmp, { recursive: true, force: true });
  });

  it("top-level verify.requireCommitContract: false disables the contract", async () => {
    await fs.writeFile(
      jsonPath,
      JSON.stringify({ stages: { fix: {} }, verify: { requireCommitContract: false } }),
      "utf-8",
    );
    const resolved = resolvePipelineConfig(loadJsonConfig(jsonPath));
    resolved.projectRoot = TMP;
    const result = await ensureCommitContractElevation(resolved, "fix");
    expect(result.disabled).toBe(true);
    expect(resolved.stages.fix.protect?.gitModify).toBeUndefined();
  });

  it("stage-level fix.verify.requireCommitContract: true re-enables (overrides global false)", async () => {
    await fs.writeFile(
      jsonPath,
      JSON.stringify({
        stages: { fix: { verify: { requireCommitContract: true } } },
        verify: { requireCommitContract: false },
      }),
      "utf-8",
    );
    const resolved = resolvePipelineConfig(loadJsonConfig(jsonPath));
    resolved.projectRoot = TMP;
    expect(resolved.stages.fix.verify?.requireCommitContract).toBe(true);
    // Simulate the job's writePolicy.gitModify block so elevation has work to do.
    resolved.protect = { ...(resolved.protect ?? {}), gitModify: "block" } as PipelineConfig["protect"];
    const result = await ensureCommitContractElevation(resolved, "fix");
    expect(result.disabled).toBe(false);
    expect(result.elevated).toBe(true);
    expect(resolved.stages.fix.protect?.gitModify).toBe("allow");
  });

  it("a non-boolean string switch warns and is dropped (never leaks truthy)", async () => {
    await fs.writeFile(
      jsonPath,
      JSON.stringify({ stages: { fix: {} }, verify: { requireCommitContract: "false" } }),
      "utf-8",
    );
    const resolved = resolvePipelineConfig(loadJsonConfig(jsonPath));
    expect(resolved.verify).toBeUndefined();
    resolved.projectRoot = TMP;
    resolved.protect = { ...(resolved.protect ?? {}), gitModify: "block" } as PipelineConfig["protect"];
    const result = await ensureCommitContractElevation(resolved, "fix");
    expect(result.disabled).toBe(false);
    expect(result.elevated).toBe(true);
  });
});
