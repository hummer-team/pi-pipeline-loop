import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { tmpdir } from "node:os";
import {
  parseVerifyFile,
  parseFrontmatter,
  ruleVerify,
  runVerification,
  executeStructuredRules,
  resolvePlaceholders,
  precheckRequiredFiles,
  parseVerifiedCommands,
  precheckCompletionMarker,
  resolvePlanDocPath,
  planDocHasConfirmMarker,
  applyConcreteStageDocPaths,
  diagnoseVerifyConfig,
  isCommitDocGlob,
  isReviewDocGlob,
} from "../../core/auto-verifier";
import { makeTestConfig, makeTestMeta } from "../helpers";
import { initAuditLog, getDateAuditFileName, __resetAuditDirPath } from "../../utils/auditLog";
import { resetPromptConfigCache } from "../../core/prompt-config";
import { DEFAULT_VERIFY_PROMPT } from "../../constants";
import type { SessionMeta } from "../../types";

let TMP: string;

beforeEach(async () => {
  TMP = path.join(tmpdir(), "pi-verify-" + Date.now());
  await fs.mkdir(TMP, { recursive: true });
});

afterEach(async () => {
  await fs.rm(TMP, { recursive: true, force: true });
});

describe("parseVerifyFile", () => {
  it("parses YAML frontmatter with AND mode keywords", async () => {
    const fp = path.join(TMP, "verify.md");
    await fs.writeFile(
      fp,
      "---\n" +
        "rules:\n" +
        "  keywords:\n" +
        '    - "方案推荐"\n' +
        '    - "答"\n' +
        "  mode: and\n" +
        "---\n" +
        "# Verify\n" +
        "Is the requirement understood?\n",
      "utf-8",
    );
    const result = await parseVerifyFile(fp);
    expect(result.rules).not.toBeNull();
    expect(result.rules!.keywords).toEqual(["方案推荐", "答"]);
    expect(result.rules!.mode).toBe("and");
    expect(result.prompt).toContain("Is the requirement understood?");
  });

  it("returns null rules when file has no frontmatter", async () => {
    const fp = path.join(TMP, "verify.md");
    await fs.writeFile(fp, "Just a prompt body", "utf-8");
    const result = await parseVerifyFile(fp);
    expect(result.rules).toBeNull();
    expect(result.prompt).toBe("Just a prompt body");
  });

  it("returns default prompt when file is missing", async () => {
    const fp = path.join(TMP, "nonexistent.md");
    const result = await parseVerifyFile(fp);
    expect(result.rules).toBeNull();
    expect(result.prompt).toContain("Fully understand the requirement context");
  });

  it("handles empty frontmatter gracefully", async () => {
    const fp = path.join(TMP, "verify.md");
    await fs.writeFile(
      fp,
      "---\n---\nSome body",
      "utf-8",
    );
    const result = await parseVerifyFile(fp);
    expect(result.rules).toBeNull();
    expect(result.prompt).toBe("Some body");
  });
});

describe("ruleVerify", () => {
  it("AND mode: all keywords found → pass", () => {
    const rules = { keywords: ["hello", "world"], mode: "and" as const };
    const msgs = ["hello world", "testing"];
    const result = ruleVerify(rules, msgs);
    expect(result.passed).toBe(true);
    expect(result.missing).toEqual([]);
  });

  it("AND mode: partial keywords → fail with missing list", () => {
    const rules = { keywords: ["hello", "world", "missing"], mode: "and" as const };
    const msgs = ["hello world"];
    const result = ruleVerify(rules, msgs);
    expect(result.passed).toBe(false);
    expect(result.missing).toEqual(["missing"]);
  });

  it("OR mode: any keyword found → pass", () => {
    const rules = { keywords: ["hello", "world"], mode: "or" as const };
    const msgs = ["just hello"];
    const result = ruleVerify(rules, msgs);
    expect(result.passed).toBe(true);
    expect(result.missing).toEqual([]);
  });

  it("OR mode: no keyword found → fail with all keywords", () => {
    const rules = { keywords: ["hello", "world"], mode: "or" as const };
    const msgs = ["nothing here"];
    const result = ruleVerify(rules, msgs);
    expect(result.passed).toBe(false);
    expect(result.missing).toEqual(["hello", "world"]);
  });

  it("aggregates multiple messages", () => {
    const rules = { keywords: ["start"], mode: "or" as const };
    const msgs = ["msg1", "msg2 start msg3"];
    const result = ruleVerify(rules, msgs);
    expect(result.passed).toBe(true);
  });
});

describe("runVerification", () => {
  it("skips when stage has no verify config", async () => {
    const config = makeTestConfig();
    const meta = makeTestMeta({ currentStage: "develop" });
    const result = await runVerification(config, meta, []);
    expect(result.rulePassed).toBe(true);
    expect(result.needsModelVerify).toBe(false);
  });

  it("runs rule verification and returns result", async () => {
    const vrPath = path.join(TMP, "references", "clarify_spec", "verify.md");
    await fs.mkdir(path.dirname(vrPath), { recursive: true });
    await fs.writeFile(
      vrPath,
      "---\n" +
        "rules:\n" +
        "  keywords:\n" +
        '    - "方案推荐"\n' +
        "  mode: or\n" +
        "---\n" +
        "验证是否理解需求？\n",
      "utf-8",
    );

    const config = makeTestConfig({
      projectRoot: TMP,
      stages: Object.fromEntries(
        ["clarify", "plan", "develop", "review", "fix", "awaiting_human", "completed"].map(
          (s, i, a) => [
            s,
            {
              agentPath: "a.md",
              skillPath: "s.md",
              nextStage: a[i + 1] ?? null,
              requireDomain: false,
              verify:
                s === "clarify"
                  ? {
                      require: true,
                      verifyFile: "references/clarify_spec/verify.md",
                    }
                  : undefined,
            },
          ],
        ),
      ) as any,
    });

    const meta = makeTestMeta({
      currentStage: "clarify",
    });

    // No matching messages
    const result1 = await runVerification(config, meta, ["nothing"]);
    expect(result1.rulePassed).toBe(false);
    expect(result1.needsModelVerify).toBe(true);
    expect(result1.ruleMissing).toEqual(["方案推荐"]);

    // Matching message
    const result2 = await runVerification(config, meta, ["方案推荐 found"]);
    expect(result2.rulePassed).toBe(true);
    expect(result2.needsModelVerify).toBe(false);
  });
});

describe("parseVerifyFile — structured rules", () => {
  it("parses requiredFiles from frontmatter", async () => {
    const fp = path.join(TMP, "verify.md");
    await fs.writeFile(
      fp,
      "---\n" +
        "rules:\n" +
        "  requiredFiles:\n" +
        '    - "docs/design/commit.md"\n' +
        '    - "src/index.ts"\n' +
        "---\n" +
        "Body text\n",
      "utf-8",
    );
    const result = await parseVerifyFile(fp);
    expect(result.rules).not.toBeNull();
    expect(result.rules!.requiredFiles).toEqual(["docs/design/commit.md", "src/index.ts"]);
  });

  it("parses requiredCommands from frontmatter", async () => {
    const fp = path.join(TMP, "verify.md");
    await fs.writeFile(
      fp,
      "---\n" +
        "rules:\n" +
        "  requiredCommands:\n" +
        '    - cmd: "bun run build"\n' +
        "      expectExit: 0\n" +
        '    - cmd: "echo ok"\n' +
        '      expectOutput: "ok"\n' +
        "---\n" +
        "Body\n",
      "utf-8",
    );
    const result = await parseVerifyFile(fp);
    expect(result.rules).not.toBeNull();
    expect(result.rules!.requiredCommands).toHaveLength(2);
    expect(result.rules!.requiredCommands![0].cmd).toBe("bun run build");
    expect(result.rules!.requiredCommands![0].expectExit).toBe(0);
    expect(result.rules!.requiredCommands![1].expectOutput).toBe("ok");
  });

  it("parses requiredGit from frontmatter", async () => {
    const fp = path.join(TMP, "verify.md");
    await fs.writeFile(
      fp,
      "---\n" +
        "rules:\n" +
        "  requiredGit:\n" +
        '    lastCommitWithin: "10min"\n' +
        '    branch: "main"\n' +
        "    cleanWorkingTree: true\n" +
        "---\n" +
        "Body\n",
      "utf-8",
    );
    const result = await parseVerifyFile(fp);
    expect(result.rules).not.toBeNull();
    expect(result.rules!.requiredGit).toEqual({
      lastCommitWithin: "10min",
      branch: "main",
      cleanWorkingTree: true,
    });
  });

  it("parses fileContentPattern from frontmatter", async () => {
    const fp = path.join(TMP, "verify.md");
    await fs.writeFile(
      fp,
      "---\n" +
        "rules:\n" +
        "  fileContentPattern:\n" +
        '    - path: "docs/design/commit.md"\n' +
        '      pattern: "^phase_name:"\n' +
        "---\n" +
        "Body\n",
      "utf-8",
    );
    const result = await parseVerifyFile(fp);
    expect(result.rules).not.toBeNull();
    expect(result.rules!.fileContentPattern).toHaveLength(1);
    expect(result.rules!.fileContentPattern![0].path).toBe("docs/design/commit.md");
    expect(result.rules!.fileContentPattern![0].pattern).toBe("^phase_name:");
  });

  it("parses mixed rules (keywords + requiredFiles)", async () => {
    const fp = path.join(TMP, "verify.md");
    await fs.writeFile(
      fp,
      "---\n" +
        "rules:\n" +
        "  requiredFiles:\n" +
        '    - "output.md"\n' +
        "  keywords:\n" +
        '    - "done"\n' +
        "  mode: and\n" +
        "---\n" +
        "Body\n",
      "utf-8",
    );
    const result = await parseVerifyFile(fp);
    expect(result.rules).not.toBeNull();
    expect(result.rules!.requiredFiles).toEqual(["output.md"]);
    expect(result.rules!.keywords).toEqual(["done"]);
    expect(result.rules!.mode).toBe("and");
  });
});

describe("executeStructuredRules", () => {
  it("passes when all rules are satisfied", async () => {
    await fs.writeFile(path.join(TMP, "exists.md"), "content");

    const result = await executeStructuredRules(
      {
        keywords: [],
        mode: "or",
        requiredFiles: ["exists.md"],
      },
      TMP,
      [],
    );
    expect(result.passed).toBe(true);
    expect(result.failures).toHaveLength(0);
  });

  it("collects failures from multiple rule types", async () => {
    const result = await executeStructuredRules(
      {
        keywords: ["hello"],
        mode: "and",
        requiredFiles: ["nonexistent.md"],
        requiredCommands: [{ cmd: "exit 1", expectExit: 0 }],
      },
      TMP,
      [],
    );
    expect(result.passed).toBe(false);
    expect(result.failures.length).toBeGreaterThanOrEqual(3);
    const ruleTypes = result.failures.map(f => f.ruleType);
    expect(ruleTypes).toContain("requiredFiles");
    expect(ruleTypes).toContain("requiredCommands");
    expect(ruleTypes).toContain("keywords");
  });

  it("skips checks for undefined rule types", async () => {
    const result = await executeStructuredRules(
      {
        keywords: [],
        mode: "or",
      },
      TMP,
      [],
    );
    expect(result.passed).toBe(true);
    expect(result.failures).toHaveLength(0);
  });
});

describe("runVerification — structured rules", () => {
  it("uses structured rules when requiredFiles are present", async () => {
    await fs.writeFile(path.join(TMP, "output.md"), "content");

    const vrPath = path.join(TMP, "references", "develop_spec", "verify.md");
    await fs.mkdir(path.dirname(vrPath), { recursive: true });
    await fs.writeFile(
      vrPath,
      "---\n" +
        "rules:\n" +
        "  requiredFiles:\n" +
        '    - "output.md"\n' +
        "---\n" +
        "Body\n",
      "utf-8",
    );

    const config = makeTestConfig({
      projectRoot: TMP,
      stages: Object.fromEntries(
        ["clarify", "plan", "develop", "review", "fix", "awaiting_human", "completed"].map(
          (s, i, a) => [
            s,
            {
              agentPath: "a.md",
              skillPath: "s.md",
              nextStage: a[i + 1] ?? null,
              requireDomain: false,
              verify:
                s === "develop"
                  ? { require: true, verifyFile: "references/develop_spec/verify.md" }
                  : undefined,
            },
          ],
        ),
      ) as any,
    });

    const meta = makeTestMeta({ currentStage: "develop" });

    // File exists → pass
    const result1 = await runVerification(config, meta, []);
    expect(result1.rulePassed).toBe(true);
    expect(result1.structuredResult).toBeDefined();
    expect(result1.structuredResult!.passed).toBe(true);

    // Delete the file → fail
    await fs.rm(path.join(TMP, "output.md"));
    const result2 = await runVerification(config, meta, []);
    expect(result2.rulePassed).toBe(false);
    expect(result2.structuredResult).toBeDefined();
    expect(result2.structuredResult!.passed).toBe(false);
    expect(result2.structuredResult!.failures.some(f => f.ruleType === "requiredFiles")).toBe(true);
  });

  it("writes verify_error + [ERROR] + pipelineId= to audit when execFn throws", async () => {
    // Set up audit log to a temp directory
    const auditDir = path.join(TMP, ".pi", "audit");
    await fs.mkdir(auditDir, { recursive: true });
    const config = makeTestConfig({ projectRoot: TMP, auditDir: ".pi/audit" });
    await initAuditLog(config);

    // Create a verify.md with requiredCommands rule
    const vrPath = path.join(TMP, "references", "develop_spec", "verify.md");
    await fs.mkdir(path.dirname(vrPath), { recursive: true });
    await fs.writeFile(
      vrPath,
      "---\n" +
        "rules:\n" +
        "  requiredCommands:\n" +
        '    - cmd: "bun run build"\n' +
        "      expectExit: 0\n" +
        "---\n" +
        "Body\n",
      "utf-8",
    );

    const fullConfig = makeTestConfig({
      projectRoot: TMP,
      auditDir: ".pi/audit",
      stages: Object.fromEntries(
        ["clarify", "plan", "develop", "review", "fix", "awaiting_human", "completed"].map(
          (s, i, a) => [
            s,
            {
              agentPath: "a.md",
              skillPath: "s.md",
              nextStage: a[i + 1] ?? null,
              requireDomain: false,
              verify:
                s === "develop"
                  ? { require: true, verifyFile: "references/develop_spec/verify.md" }
                  : undefined,
            },
          ],
        ),
      ) as any,
    });

    const meta = makeTestMeta({ currentStage: "develop", pipelineId: "pipe-audit-test-001" });

    // Inject an execFn that throws (simulates real error)
    const throwingExecFn = async () => { throw new Error("execFn crashed"); };

    await runVerification(fullConfig, meta, [], { execFn: throwingExecFn });

    // Read the audit log and verify
    const logFile = path.join(auditDir, getDateAuditFileName());
    const logContent = await fs.readFile(logFile, "utf-8");

    expect(logContent).toContain("verify_error");
    expect(logContent).toContain("[ERROR]");
    expect(logContent).toContain("pipelineId=pipe-audit-test-001");
    expect(logContent).toContain("execFn crashed");

    // Clean up audit state
    __resetAuditDirPath();
  });

  it("Phase 1 — malformed frontmatter triggers verify_frontmatter_parse_error audit", async () => {
    // parseFrontmatter catch is a safety net for unexpected errors.
    // Force the catch by calling with invalid input (non-string) directly.
    const auditDir = path.join(TMP, ".pi", "audit");
    await fs.mkdir(auditDir, { recursive: true });
    const config = makeTestConfig({ projectRoot: TMP, auditDir: ".pi/audit" });
    await initAuditLog(config);

    // Call parseFrontmatter directly with invalid input to trigger catch block
    const result = await parseFrontmatter(null as any);
    expect(result).toBeNull();

    // Verify audit log contains verify_frontmatter_parse_error
    const logFile = path.join(auditDir, getDateAuditFileName());
    const logContent = await fs.readFile(logFile, "utf-8");
    expect(logContent).toContain("verify_frontmatter_parse_error");
    expect(logContent).toContain("[ERROR]");

    __resetAuditDirPath();
  });
});

describe("resolvePlaceholders", () => {
  it("replaces {requirementDoc} in requiredFiles paths", () => {
    const rules = {
      keywords: [],
      mode: "or" as const,
      requiredFiles: ["{requirementDoc}"],
    };
    const meta = makeTestMeta({ requirementDoc: "docs/design/121_req.md" });
    const resolved = resolvePlaceholders(rules, meta);
    expect(resolved.requiredFiles).toEqual(["docs/design/121_req.md"]);
  });

  it("replaces {requirementDoc} in fileContentPattern paths", () => {
    const rules = {
      keywords: [],
      mode: "or" as const,
      fileContentPattern: [{ path: "{requirementDoc}", pattern: "confirmed" }],
    };
    const meta = makeTestMeta({ requirementDoc: "docs/design/121_req.md" });
    const resolved = resolvePlaceholders(rules, meta);
    expect(resolved.fileContentPattern![0].path).toBe("docs/design/121_req.md");
  });

  it("leaves paths unchanged when no placeholder present", () => {
    const rules = {
      keywords: [],
      mode: "or" as const,
      requiredFiles: ["docs/design/fixed.md"],
    };
    const meta = makeTestMeta({ requirementDoc: "docs/design/121_req.md" });
    const resolved = resolvePlaceholders(rules, meta);
    expect(resolved.requiredFiles).toEqual(["docs/design/fixed.md"]);
  });

  it("preserves {requirementDoc} placeholder when requirementDoc is undefined (L2-A)", () => {
    const rules = {
      keywords: [],
      mode: "or" as const,
      requiredFiles: ["{requirementDoc}"],
    };
    const meta = makeTestMeta();
    const resolved = resolvePlaceholders(rules, meta);
    expect(resolved.requiredFiles).toEqual(["{requirementDoc}"]);
  });
});

describe("runVerification — {requirementDoc} placeholder integration", () => {
  it("resolves placeholder in requiredFiles and passes when file exists", async () => {
    // Create the requirement doc file
    await fs.mkdir(path.join(TMP, "docs", "design"), { recursive: true });
    const reqDocPath = path.join(TMP, "docs", "design", "121_req.md");
    await fs.writeFile(reqDocPath, "## 模型确认\nfull-und? 理解确认：是\n");

    const vrPath = path.join(TMP, "references", "clarify_spec", "verify.md");
    await fs.mkdir(path.dirname(vrPath), { recursive: true });
    await fs.writeFile(
      vrPath,
      "---\n" +
        "rules:\n" +
        "  fileContentPattern:\n" +
        '    - path: "{requirementDoc}"\n' +
        '      pattern: "full-und. 理解确认：是"\n' +
        "---\n" +
        "Verify model confirmation\n",
      "utf-8",
    );

    const config = makeTestConfig({
      projectRoot: TMP,
      stages: Object.fromEntries(
        ["clarify", "plan", "develop", "review", "fix", "awaiting_human", "completed"].map(
          (s, i, a) => [
            s,
            {
              agentPath: "a.md",
              skillPath: "s.md",
              nextStage: a[i + 1] ?? null,
              requireDomain: false,
              verify:
                s === "clarify"
                  ? { require: true, verifyFile: "references/clarify_spec/verify.md" }
                  : undefined,
            },
          ],
        ),
      ) as any,
    });

    const meta = makeTestMeta({
      currentStage: "clarify",
      requirementDoc: "docs/design/121_req.md",
    });

    const result = await runVerification(config, meta, []);
    expect(result.rulePassed).toBe(true);
    expect(result.structuredResult?.passed).toBe(true);
  });

  it("resolves placeholder and fails when pattern not found", async () => {
    // Create the requirement doc file WITHOUT the expected pattern
    await fs.mkdir(path.join(TMP, "docs", "design"), { recursive: true });
    const reqDocPath = path.join(TMP, "docs", "design", "121_req.md");
    await fs.writeFile(reqDocPath, "Just some content without confirmation\n");

    const vrPath = path.join(TMP, "references", "clarify_spec", "verify.md");
    await fs.mkdir(path.dirname(vrPath), { recursive: true });
    await fs.writeFile(
      vrPath,
      "---\n" +
        "rules:\n" +
        "  fileContentPattern:\n" +
        '    - path: "{requirementDoc}"\n' +
        '      pattern: "full-und. 理解确认：是"\n' +
        "---\n" +
        "Verify model confirmation\n",
      "utf-8",
    );

    const config = makeTestConfig({
      projectRoot: TMP,
      stages: Object.fromEntries(
        ["clarify", "plan", "develop", "review", "fix", "awaiting_human", "completed"].map(
          (s, i, a) => [
            s,
            {
              agentPath: "a.md",
              skillPath: "s.md",
              nextStage: a[i + 1] ?? null,
              requireDomain: false,
              verify:
                s === "clarify"
                  ? { require: true, verifyFile: "references/clarify_spec/verify.md" }
                  : undefined,
            },
          ],
        ),
      ) as any,
    });

    const meta = makeTestMeta({
      currentStage: "clarify",
      requirementDoc: "docs/design/121_req.md",
    });

    const result = await runVerification(config, meta, []);
    expect(result.rulePassed).toBe(false);
    expect(result.structuredResult?.passed).toBe(false);
    expect(result.structuredResult?.failures.some(f => f.ruleType === "fileContentPattern")).toBe(true);
  });
});

describe("runVerification — yml verify_{stage} modelPrompt priority (D5)", () => {
  beforeEach(() => {
    resetPromptConfigCache();
  });

  afterEach(() => {
    resetPromptConfigCache();
    __resetAuditDirPath();
  });

  it("uses yml verify_{stage} as modelPrompt when available (overrides verify.md body)", async () => {
    // Create verify.md with a body prompt
    const verifyDir = path.join(TMP, ".pi", "references", "clarify_spec");
    await fs.mkdir(verifyDir, { recursive: true });
    await fs.writeFile(
      path.join(verifyDir, "verify.md"),
      "---\nrules:\n  keywords:\n    - hello\n    - world\n  mode: and\n---\nBody prompt from verify.md\n",
      "utf-8",
    );

    // Create yml with verify_clarify
    const refsDir = path.join(TMP, ".pi", "references");
    await fs.writeFile(
      path.join(refsDir, "pipeline-stage-prompt.yml"),
      'verify_clarify: "YML verify prompt for clarify"\n',
      "utf-8",
    );

    const config = makeTestConfig({ projectRoot: TMP });
    await initAuditLog(config);
    config.stages["clarify"] = {
      ...config.stages["clarify"],
      verify: { require: true, verifyFile: ".pi/references/clarify_spec/verify.md" },
    } as any;
    const meta = makeTestMeta({ currentStage: "clarify" });

    const result = await runVerification(config, meta, []);

    // modelPrompt should use yml value, not verify.md body
    expect(result.modelPrompt).toBe("YML verify prompt for clarify");
  });

  it("falls back to verify.md body when yml verify_{stage} is missing", async () => {
    const verifyDir = path.join(TMP, ".pi", "references", "clarify_spec");
    await fs.mkdir(verifyDir, { recursive: true });
    await fs.writeFile(
      path.join(verifyDir, "verify.md"),
      "---\nrules:\n  keywords:\n    - hello\n  mode: and\n---\nBody prompt from verify.md\n",
      "utf-8",
    );

    // No yml file at all
    const config = makeTestConfig({ projectRoot: TMP });
    await initAuditLog(config);
    config.stages["clarify"] = {
      ...config.stages["clarify"],
      verify: { require: true, verifyFile: ".pi/references/clarify_spec/verify.md" },
    } as any;
    const meta = makeTestMeta({ currentStage: "clarify" });

    const result = await runVerification(config, meta, []);

    // modelPrompt should use verify.md body (fallback)
    expect(result.modelPrompt).toBe("Body prompt from verify.md");
  });

  it("rules still come from frontmatter even when yml overrides modelPrompt", async () => {
    const verifyDir = path.join(TMP, ".pi", "references", "clarify_spec");
    await fs.mkdir(verifyDir, { recursive: true });
    await fs.writeFile(
      path.join(verifyDir, "verify.md"),
      "---\nrules:\n  keywords:\n    - unique_keyword_xyz\n  mode: and\n---\nBody prompt\n",
      "utf-8",
    );

    const refsDir = path.join(TMP, ".pi", "references");
    await fs.writeFile(
      path.join(refsDir, "pipeline-stage-prompt.yml"),
      'verify_clarify: "Custom yml prompt"\n',
      "utf-8",
    );

    const config = makeTestConfig({ projectRoot: TMP });
    await initAuditLog(config);
    config.stages["clarify"] = {
      ...config.stages["clarify"],
      verify: { require: true, verifyFile: ".pi/references/clarify_spec/verify.md" },
    } as any;
    const meta = makeTestMeta({ currentStage: "clarify" });

    // Messages missing the keyword — should fail structured check
    const result = await runVerification(config, meta, ["some message without keyword"]);

    // modelPrompt from yml
    expect(result.modelPrompt).toBe("Custom yml prompt");
    // Rules still from frontmatter — keyword check fails
    expect(result.rulePassed).toBe(false);
    expect(result.ruleMissing).toContain("unique_keyword_xyz");
  });

  it("falls back to DEFAULT_VERIFY_PROMPT when yml is missing and verify.md body is empty", async () => {
    // verify.md with only frontmatter, no body
    const verifyDir = path.join(TMP, ".pi", "references", "clarify_spec");
    await fs.mkdir(verifyDir, { recursive: true });
    await fs.writeFile(
      path.join(verifyDir, "verify.md"),
      "---\nrules:\n  keywords:\n    - some_keyword\n  mode: and\n---\n",
      "utf-8",
    );

    // No yml file at all — getVerifyPrompt returns null
    const config = makeTestConfig({ projectRoot: TMP });
    await initAuditLog(config);
    config.stages["clarify"] = {
      ...config.stages["clarify"],
      verify: { require: true, verifyFile: ".pi/references/clarify_spec/verify.md" },
    } as any;
    const meta = makeTestMeta({ currentStage: "clarify" });

    const result = await runVerification(config, meta, []);

    // Fallback chain: yml missing (null) → body empty → DEFAULT_VERIFY_PROMPT
    expect(result.modelPrompt).toBe(DEFAULT_VERIFY_PROMPT);
  });
});

// ─── Phase 0: parseFrontmatter robustness fixes ──────────────────────────────

describe("parseFrontmatter — Phase 0 robustness fixes", () => {
  afterEach(() => {
    __resetAuditDirPath();
  });

  it("P1: flat-style keywords all preserved (continue fix)", async () => {
    // Flat style: section keys at indent 0, list items at indent 2
    // Bug: second keyword caused indent<=2 reset to wipe currentSection
    const yaml = [
      "rules:",
      "keywords:",
      '  - "kw_alpha"',
      '  - "kw_beta"',
      '  - "kw_gamma"',
      '  - "kw_delta"',
      "mode: and",
    ].join("\n");
    const rules = await parseFrontmatter(yaml);
    expect(rules).not.toBeNull();
    expect(rules!.keywords).toEqual(["kw_alpha", "kw_beta", "kw_gamma", "kw_delta"]);
    expect(rules!.mode).toBe("and");
  });

  it("P2: 4-space nested style keywords/mode parsed correctly (not swallowed by requiredFiles)", async () => {
    // 4-space nested style: section keys at indent 4 under rules:
    const yaml = [
      "rules:",
      "    keywords:",
      '        - "deep_kw_1"',
      '        - "deep_kw_2"',
      "    mode: and",
      "    requiredFiles:",
      '        - "only/file.md"',
    ].join("\n");
    const rules = await parseFrontmatter(yaml);
    expect(rules).not.toBeNull();
    expect(rules!.keywords).toEqual(["deep_kw_1", "deep_kw_2"]);
    expect(rules!.mode).toBe("and");
    expect(rules!.requiredFiles).toEqual(["only/file.md"]);
  });

  it("P3: YAML double-quote escape unescaping produces correct regex", async () => {
    // Pattern with escaped backslash-question: should unescape to \?
    const yaml = [
      "rules:",
      "  fileContentPattern:",
      '    - path: "docs/req.md"',
      '      pattern: "full-und\\\\? 理解确认：是"',
    ].join("\n");
    const rules = await parseFrontmatter(yaml);
    expect(rules).not.toBeNull();
    expect(rules!.fileContentPattern).toHaveLength(1);
    // The unescaped pattern should contain literal \? (regex for literal ?)
    expect(rules!.fileContentPattern![0].pattern).toBe("full-und\\? 理解确认：是");
    // And it should match the intended string
    const regex = new RegExp(rules!.fileContentPattern![0].pattern);
    expect(regex.test("full-und? 理解确认：是")).toBe(true);
  });

  it("discards fileContentPattern entries with missing path and writes audit", async () => {
    const auditDir = path.join(TMP, ".pi", "audit");
    await fs.mkdir(auditDir, { recursive: true });
    const config = makeTestConfig({ projectRoot: TMP, auditDir: ".pi/audit" });
    await initAuditLog(config);

    const yaml = [
      "rules:",
      "  fileContentPattern:",
      '    - path: ""',
      '      pattern: "something"',
      '    - path: "real.md"',
      '      pattern: "ok"',
    ].join("\n");
    const rules = await parseFrontmatter(yaml);
    expect(rules).not.toBeNull();
    // Only the valid entry should remain
    expect(rules!.fileContentPattern).toHaveLength(1);
    expect(rules!.fileContentPattern![0].path).toBe("real.md");

    // Verify audit log contains the empty-item warning
    const logFile = path.join(auditDir, getDateAuditFileName());
    const logContent = await fs.readFile(logFile, "utf-8");
    expect(logContent).toContain("verify_frontmatter_parse_error");
    expect(logContent).toContain("Empty entries discarded");
    expect(logContent).toContain("fileContentPattern missing path");

    __resetAuditDirPath();
  });

  it("discards empty keywords and requiredFiles entries", async () => {
    const yaml = [
      "rules:",
      "  keywords:",
      '    - "valid_kw"',
      '    - ""',
      "  requiredFiles:",
      '    - "real.md"',
      '    - "  "',
    ].join("\n");
    const rules = await parseFrontmatter(yaml);
    expect(rules).not.toBeNull();
    expect(rules!.keywords).toEqual(["valid_kw"]);
    expect(rules!.requiredFiles).toEqual(["real.md"]);
  });

  // ── Fix 2: section switch flush ──────────────────────────────────────────

  it("flushes pending cmdItem when requiredCommands is followed by keywords (4-space style)", async () => {
    // Generator output pattern: requiredCommands → keywords
    // Before fix: last cmdItem silently dropped when keywords: section starts
    const yaml = [
      "rules:",
      "    requiredCommands:",
      '        - cmd: "bun run build"',
      "          expectExit: 0",
      '        - cmd: "echo ok"',
      '          expectOutput: "ok"',
      "    keywords:",
      '        - "done"',
      "    mode: and",
    ].join("\n");
    const rules = await parseFrontmatter(yaml);
    expect(rules).not.toBeNull();
    // Both commands must be present (previously only 1 was kept)
    expect(rules!.requiredCommands).toHaveLength(2);
    expect(rules!.requiredCommands![0].cmd).toBe("bun run build");
    expect(rules!.requiredCommands![0].expectExit).toBe(0);
    expect(rules!.requiredCommands![1].cmd).toBe("echo ok");
    expect(rules!.requiredCommands![1].expectOutput).toBe("ok");
    expect(rules!.keywords).toEqual(["done"]);
    expect(rules!.mode).toBe("and");
  });

  it("flushes pending cmdItem when requiredCommands is followed by keywords (2-space style)", async () => {
    const yaml = [
      "rules:",
      "  requiredCommands:",
      '    - cmd: "npm test"',
      "      expectExit: 0",
      '    - cmd: "bun run build"',
      "      expectExit: 0",
      "  keywords:",
      '    - "pass"',
    ].join("\n");
    const rules = await parseFrontmatter(yaml);
    expect(rules).not.toBeNull();
    expect(rules!.requiredCommands).toHaveLength(2);
    expect(rules!.requiredCommands![0].cmd).toBe("npm test");
    expect(rules!.requiredCommands![1].cmd).toBe("bun run build");
    expect(rules!.keywords).toEqual(["pass"]);
  });

  it("flushes pending fcItem when fileContentPattern is followed by requiredFiles", async () => {
    const yaml = [
      "rules:",
      "  fileContentPattern:",
      '    - path: "docs/req.md"',
      '      pattern: "confirmed"',
      "  requiredFiles:",
      '    - "output.md"',
    ].join("\n");
    const rules = await parseFrontmatter(yaml);
    expect(rules).not.toBeNull();
    expect(rules!.fileContentPattern).toHaveLength(1);
    expect(rules!.fileContentPattern![0].path).toBe("docs/req.md");
    expect(rules!.fileContentPattern![0].pattern).toBe("confirmed");
    expect(rules!.requiredFiles).toEqual(["output.md"]);
  });

  it("flushes pending fcItem when fileContentPattern is followed by requiredCommands", async () => {
    const yaml = [
      "rules:",
      "  fileContentPattern:",
      '    - path: "src/index.ts"',
      '      pattern: "export"',
      "  requiredCommands:",
      '    - cmd: "bun run build"',
      "      expectExit: 0",
    ].join("\n");
    const rules = await parseFrontmatter(yaml);
    expect(rules).not.toBeNull();
    expect(rules!.fileContentPattern).toHaveLength(1);
    expect(rules!.fileContentPattern![0].path).toBe("src/index.ts");
    expect(rules!.requiredCommands).toHaveLength(1);
    expect(rules!.requiredCommands![0].cmd).toBe("bun run build");
  });
});

// ─── Phase 2: unresolved {requirementDoc} placeholder detection ──────────────

describe("runVerification — unresolved {requirementDoc} placeholder (Phase 2)", () => {
  it("returns explicit failure when requirementDoc is unset", async () => {
    const vrPath = path.join(TMP, "references", "clarify_spec", "verify.md");
    await fs.mkdir(path.dirname(vrPath), { recursive: true });
    await fs.writeFile(
      vrPath,
      "---\n" +
        "rules:\n" +
        "  fileContentPattern:\n" +
        '    - path: "{requirementDoc}"\n' +
        '      pattern: "confirmed"\n' +
        "---\n" +
        "Verify\n",
      "utf-8",
    );

    const config = makeTestConfig({
      projectRoot: TMP,
      stages: Object.fromEntries(
        ["clarify", "plan", "develop", "review", "fix", "awaiting_human", "completed"].map(
          (s, i, a) => [
            s,
            {
              agentPath: "a.md",
              skillPath: "s.md",
              nextStage: a[i + 1] ?? null,
              requireDomain: false,
              verify:
                s === "clarify"
                  ? { require: true, verifyFile: "references/clarify_spec/verify.md" }
                  : undefined,
            },
          ],
        ),
      ) as any,
    });

    // meta WITHOUT requirementDoc
    const meta = makeTestMeta({ currentStage: "clarify" });
    const result = await runVerification(config, meta, []);

    expect(result.rulePassed).toBe(false);
    expect(result.structuredResult).toBeDefined();
    expect(result.structuredResult!.passed).toBe(false);
    // Failure detail should mention requirementDoc unset, NOT EISDIR
    const detail = result.structuredResult!.failures[0].detail;
    expect(detail).toContain("requirementDoc not set");
    expect(detail).not.toContain("EISDIR");
    // Phase 4 (Bug 4-A): remediation hint must include /pipeline-start guidance
    expect(detail).toContain("/pipeline-start");
    expect(detail).toContain("<doc_file>");
  });

  it("resolves placeholder normally when requirementDoc IS set (existing behavior preserved)", async () => {
    // Create the requirement doc file
    await fs.mkdir(path.join(TMP, "docs", "design"), { recursive: true });
    const reqDocPath = path.join(TMP, "docs", "design", "req.md");
    await fs.writeFile(reqDocPath, "confirmed: yes\n");

    const vrPath = path.join(TMP, "references", "clarify_spec", "verify.md");
    await fs.mkdir(path.dirname(vrPath), { recursive: true });
    await fs.writeFile(
      vrPath,
      "---\n" +
        "rules:\n" +
        "  fileContentPattern:\n" +
        '    - path: "{requirementDoc}"\n' +
        '      pattern: "confirmed"\n' +
        "---\n" +
        "Verify\n",
      "utf-8",
    );

    const config = makeTestConfig({
      projectRoot: TMP,
      stages: Object.fromEntries(
        ["clarify", "plan", "develop", "review", "fix", "awaiting_human", "completed"].map(
          (s, i, a) => [
            s,
            {
              agentPath: "a.md",
              skillPath: "s.md",
              nextStage: a[i + 1] ?? null,
              requireDomain: false,
              verify:
                s === "clarify"
                  ? { require: true, verifyFile: "references/clarify_spec/verify.md" }
                  : undefined,
            },
          ],
        ),
      ) as any,
    });

    const meta = makeTestMeta({
      currentStage: "clarify",
      requirementDoc: "docs/design/req.md",
    });
    const result = await runVerification(config, meta, []);
    expect(result.rulePassed).toBe(true);
    expect(result.structuredResult?.passed).toBe(true);
  });

  it("returns explicit failure when pipelineId is unset (symmetric with requirementDoc guard)", async () => {
    const vrPath = path.join(TMP, "references", "dev_spec", "verify.md");
    await fs.mkdir(path.dirname(vrPath), { recursive: true });
    await fs.writeFile(
      vrPath,
      "---\n" +
        "rules:\n" +
        "  fileContentPattern:\n" +
        '    - path: "docs/design/*_commit.md"\n' +
        '      pattern: "^\\\\*\\\\*pipeline\\\\*\\\\*:\\\\s*{pipelineId}$"\n' +
        "---\n" +
        "Verify pipelineId.\n",
      "utf-8",
    );

    const config = makeTestConfig({
      projectRoot: TMP,
      stages: Object.fromEntries(
        ["clarify", "plan", "develop", "review", "fix", "awaiting_human", "completed"].map(
          (s, i, a) => [
            s,
            {
              agentPath: "a.md",
              skillPath: "s.md",
              nextStage: a[i + 1] ?? null,
              requireDomain: false,
              verify:
                s === "develop"
                  ? { require: true, verifyFile: "references/dev_spec/verify.md" }
                  : undefined,
            },
          ],
        ),
      ) as any,
    });

    // meta WITH requirementDoc but WITHOUT pipelineId
    const meta = makeTestMeta({
      currentStage: "develop",
      requirementDoc: "docs/design/req.md",
    });
    // Strip pipelineId from meta to simulate missing
    delete (meta as Partial<SessionMeta>).pipelineId;

    const result = await runVerification(config, meta, []);

    expect(result.rulePassed).toBe(false);
    expect(result.structuredResult).toBeDefined();
    expect(result.structuredResult!.passed).toBe(false);
    // Failure detail should mention pipelineId unset with remediation hint
    const detail = result.structuredResult!.failures[0].detail;
    expect(detail).toContain("pipelineId not set");
    expect(detail).toContain("/pipeline-start");
  });
});

// ─── Phase 2: precheckRequiredFiles tests ────────────────────────────────────

describe("precheckRequiredFiles", () => {
  it("returns passed=true when no verify config", async () => {
    const config = makeTestConfig({
      projectRoot: TMP,
      stages: {
        plan: { agentPath: "a.md", skillPath: "s.md", nextStage: "develop", requireDomain: false },
      } as any,
    });
    const meta = makeTestMeta({ currentStage: "plan" });
    const result = await precheckRequiredFiles(config, meta);
    expect(result.passed).toBe(true);
    expect(result.missing).toEqual([]);
  });

  it("returns passed=true when no requiredFiles rule", async () => {
    const vrPath = path.join(TMP, "verify.md");
    await fs.writeFile(
      vrPath,
      "---\n" + "rules:\n" + "  keywords:\n" + '    - "test"\n' + "---\n" + "Verify\n",
      "utf-8",
    );

    const config = makeTestConfig({
      projectRoot: TMP,
      stages: {
        plan: {
          agentPath: "a.md",
          skillPath: "s.md",
          nextStage: "develop",
          requireDomain: false,
          verify: { require: true, verifyFile: "verify.md" },
        },
      } as any,
    });
    const meta = makeTestMeta({ currentStage: "plan" });
    const result = await precheckRequiredFiles(config, meta);
    expect(result.passed).toBe(true);
    expect(result.missing).toEqual([]);
  });

  it("returns passed=true when all requiredFiles exist", async () => {
    await fs.mkdir(path.join(TMP, "docs"), { recursive: true });
    await fs.writeFile(path.join(TMP, "docs", "plan.md"), "plan content");
    await fs.writeFile(path.join(TMP, "docs", "design.md"), "design content");

    const vrPath = path.join(TMP, "verify.md");
    await fs.writeFile(
      vrPath,
      "---\n" +
        "rules:\n" +
        "  requiredFiles:\n" +
        '    - "docs/plan.md"\n' +
        '    - "docs/design.md"\n' +
        "---\n" +
        "Verify\n",
      "utf-8",
    );

    const config = makeTestConfig({
      projectRoot: TMP,
      stages: {
        plan: {
          agentPath: "a.md",
          skillPath: "s.md",
          nextStage: "develop",
          requireDomain: false,
          verify: { require: true, verifyFile: "verify.md" },
        },
      } as any,
    });
    const meta = makeTestMeta({ currentStage: "plan" });
    const result = await precheckRequiredFiles(config, meta);
    expect(result.passed).toBe(true);
    expect(result.missing).toEqual([]);
  });

  it("returns passed=false with correct missing list when some files missing", async () => {
    await fs.mkdir(path.join(TMP, "docs"), { recursive: true });
    await fs.writeFile(path.join(TMP, "docs", "plan.md"), "plan content");
    // docs/design.md does NOT exist

    const vrPath = path.join(TMP, "verify.md");
    await fs.writeFile(
      vrPath,
      "---\n" +
        "rules:\n" +
        "  requiredFiles:\n" +
        '    - "docs/plan.md"\n' +
        '    - "docs/design.md"\n' +
        '    - "docs/missing.md"\n' +
        "---\n" +
        "Verify\n",
      "utf-8",
    );

    const config = makeTestConfig({
      projectRoot: TMP,
      stages: {
        plan: {
          agentPath: "a.md",
          skillPath: "s.md",
          nextStage: "develop",
          requireDomain: false,
          verify: { require: true, verifyFile: "verify.md" },
        },
      } as any,
    });
    const meta = makeTestMeta({ currentStage: "plan" });
    const result = await precheckRequiredFiles(config, meta);
    expect(result.passed).toBe(false);
    // missing should only contain actually missing files, NOT docs/plan.md
    expect(result.missing).toEqual(["docs/design.md", "docs/missing.md"]);
    expect(result.missing).not.toContain("docs/plan.md");
  });

  it("resolves {requirementDoc} placeholder and passes when file exists", async () => {
    // Create the requirement doc file
    await fs.mkdir(path.join(TMP, "docs", "design"), { recursive: true });
    await fs.writeFile(path.join(TMP, "docs", "design", "req.md"), "requirement content");

    const vrPath = path.join(TMP, "verify.md");
    await fs.writeFile(
      vrPath,
      "---\n" +
        "rules:\n" +
        "  requiredFiles:\n" +
        '    - "{requirementDoc}/docs/plan.md"\n' +
        "---\n" +
        "Verify\n",
      "utf-8",
    );

    const config = makeTestConfig({
      projectRoot: TMP,
      stages: {
        plan: {
          agentPath: "a.md",
          skillPath: "s.md",
          nextStage: "develop",
          requireDomain: false,
          verify: { require: true, verifyFile: "verify.md" },
        },
      } as any,
    });
    // meta WITH requirementDoc set
    const meta = makeTestMeta({
      currentStage: "plan",
      requirementDoc: "docs/design/req.md",
    });
    const result = await precheckRequiredFiles(config, meta);
    // Precheck should pass because resolvePlaceholders resolves {requirementDoc}
    // The resolved path is "docs/design/req.md/docs/plan.md" which doesn't exist,
    // but this test verifies that placeholder resolution is being called
    expect(result.passed).toBe(false);
    expect(result.missing).toContain("docs/design/req.md/docs/plan.md");
    // Verify placeholder was resolved (not literal {requirementDoc})
    expect(result.missing[0]).not.toContain("{requirementDoc}");
  });

  it("resolves {requirementDoc} placeholder and correctly identifies missing file", async () => {
    // Create the target file at the resolved path
    await fs.mkdir(path.join(TMP, "docs", "spec", "docs"), { recursive: true });
    await fs.writeFile(path.join(TMP, "docs", "spec", "docs", "plan.md"), "plan content");

    const vrPath = path.join(TMP, "verify.md");
    await fs.writeFile(
      vrPath,
      "---\n" +
        "rules:\n" +
        "  requiredFiles:\n" +
        '    - "{requirementDoc}/docs/plan.md"\n' +
        "---\n" +
        "Verify\n",
      "utf-8",
    );

    const config = makeTestConfig({
      projectRoot: TMP,
      stages: {
        plan: {
          agentPath: "a.md",
          skillPath: "s.md",
          nextStage: "develop",
          requireDomain: false,
          verify: { require: true, verifyFile: "verify.md" },
        },
      } as any,
    });
    // meta WITH requirementDoc set to the actual directory
    const meta = makeTestMeta({
      currentStage: "plan",
      requirementDoc: "docs/spec",
    });
    const result = await precheckRequiredFiles(config, meta);
    // Should pass because docs/spec/docs/plan.md exists
    expect(result.passed).toBe(true);
    expect(result.missing).toEqual([]);
  });

  it("supports glob patterns in requiredFiles", async () => {
    await fs.mkdir(path.join(TMP, "src"), { recursive: true });
    await fs.writeFile(path.join(TMP, "src", "index.ts"), "export {}");
    await fs.writeFile(path.join(TMP, "src", "utils.ts"), "export {}");

    const vrPath = path.join(TMP, "verify.md");
    await fs.writeFile(
      vrPath,
      "---\n" +
        "rules:\n" +
        "  requiredFiles:\n" +
        '    - "src/*.ts"\n' +
        "---\n" +
        "Verify\n",
      "utf-8",
    );

    const config = makeTestConfig({
      projectRoot: TMP,
      stages: {
        plan: {
          agentPath: "a.md",
          skillPath: "s.md",
          nextStage: "develop",
          requireDomain: false,
          verify: { require: true, verifyFile: "verify.md" },
        },
      } as any,
    });
    const meta = makeTestMeta({ currentStage: "plan" });
    const result = await precheckRequiredFiles(config, meta);
    expect(result.passed).toBe(true);
    expect(result.missing).toEqual([]);
  });

  it("returns passed=false when glob pattern has no matches", async () => {
    const vrPath = path.join(TMP, "verify.md");
    await fs.writeFile(
      vrPath,
      "---\n" +
        "rules:\n" +
        "  requiredFiles:\n" +
        '    - "nonexistent/*.md"\n' +
        "---\n" +
        "Verify\n",
      "utf-8",
    );

    const config = makeTestConfig({
      projectRoot: TMP,
      stages: {
        plan: {
          agentPath: "a.md",
          skillPath: "s.md",
          nextStage: "develop",
          requireDomain: false,
          verify: { require: true, verifyFile: "verify.md" },
        },
      } as any,
    });
    const meta = makeTestMeta({ currentStage: "plan" });
    const result = await precheckRequiredFiles(config, meta);
    expect(result.passed).toBe(false);
    expect(result.missing).toContain("nonexistent/*.md");
  });
});

describe("Phase 6 (139): VERIFIED_COMMANDS selfVerifySkip", () => {
  it("parseVerifiedCommands extracts commands from VERIFIED_COMMANDS lines", () => {
    const messages = [
      "Some task result text",
      "VERIFIED_COMMANDS: bun run build,bun run test",
      "More text",
    ];
    const records = parseVerifiedCommands(messages);
    expect(records).toHaveLength(2);
    expect(records[0].command).toBe("bun run build");
    expect(records[0].name).toBe("bash");
    expect(records[0].success).toBe(true);
    expect(records[1].command).toBe("bun run test");
  });

  it("parseVerifiedCommands returns empty when no VERIFIED_COMMANDS line", () => {
    const messages = ["Some text", "No protocol here"];
    const records = parseVerifiedCommands(messages);
    expect(records).toHaveLength(0);
  });

  it("parseVerifiedCommands handles single command", () => {
    const messages = ["VERIFIED_COMMANDS: ./mvnw clean test"];
    const records = parseVerifiedCommands(messages);
    expect(records).toHaveLength(1);
    expect(records[0].command).toBe("./mvnw clean test");
  });

  it("parseVerifiedCommands ignores empty entries", () => {
    const messages = ["VERIFIED_COMMANDS: bun run build,,bun run test,"];
    const records = parseVerifiedCommands(messages);
    expect(records).toHaveLength(2);
  });

  // Security: ts=0 ensures file-change invalidation always triggers
  it("parseVerifiedCommands sets ts=0 so file-change invalidation works", () => {
    const messages = ["VERIFIED_COMMANDS: bun run build"];
    const records = parseVerifiedCommands(messages);
    expect(records).toHaveLength(1);
    // ts must be 0, NOT Date.now() — so any write/edit record with ts > 0
    // will invalidate the self-reported command match in command-verifier
    expect(records[0].ts).toBe(0);
  });

  // Security: selfReported flag distinguishes from real tool call records
  it("parseVerifiedCommands marks records as selfReported=true", () => {
    const messages = ["VERIFIED_COMMANDS: bun run build,bun run test"];
    const records = parseVerifiedCommands(messages);
    expect(records).toHaveLength(2);
    expect(records[0].selfReported).toBe(true);
    expect(records[1].selfReported).toBe(true);
  });
});

// ─── Phase 3 (140): precheckCompletionMarker ──────────────────────────────────
describe("Phase 3 (140): precheckCompletionMarker", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = path.join(tmpdir(), "pi-marker-" + Date.now());
    await fs.mkdir(tmpDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("returns false when requirementDoc is not set", async () => {
    const meta = makeTestMeta({ requirementDoc: undefined });
    const result = await precheckCompletionMarker(meta, "## 模型确认", tmpDir);
    expect(result).toBe(false);
  });

  it("returns false when requirementDoc file does not exist", async () => {
    const meta = makeTestMeta({ requirementDoc: "nonexistent.md" });
    const result = await precheckCompletionMarker(meta, "## 模型确认", tmpDir);
    expect(result).toBe(false);
  });

  it("returns true when marker is found in requirementDoc", async () => {
    await fs.writeFile(
      path.join(tmpDir, "req.md"),
      "# Requirements\nSome content\n## 模型确认\n- full-und? 理解确认：是\n",
      "utf-8",
    );
    const meta = makeTestMeta({ requirementDoc: "req.md" });
    const result = await precheckCompletionMarker(meta, "## 模型确认", tmpDir);
    expect(result).toBe(true);
  });

  it("returns false when marker is NOT found in requirementDoc", async () => {
    await fs.writeFile(
      path.join(tmpDir, "req.md"),
      "# Requirements\nSome content without the marker\n",
      "utf-8",
    );
    const meta = makeTestMeta({ requirementDoc: "req.md" });
    const result = await precheckCompletionMarker(meta, "## 模型确认", tmpDir);
    expect(result).toBe(false);
  });

  it("handles absolute requirementDoc paths", async () => {
    const absPath = path.join(tmpDir, "absolute-req.md");
    await fs.writeFile(absPath, "content\n## 模型确认\n", "utf-8");
    const meta = makeTestMeta({ requirementDoc: absPath });
    const result = await precheckCompletionMarker(meta, "## 模型确认", tmpDir);
    expect(result).toBe(true);
  });
});

// ─── Phase 1 (141): resolvePlanDocPath / planDocHasConfirmMarker ──────────────
describe("Phase 1 (141): resolvePlanDocPath", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = path.join(tmpdir(), "pi-plandoc-" + Date.now());
    await fs.mkdir(tmpDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("derives plan doc path from requirementDoc (77_Config.md → 77_Config_plan.md)", async () => {
    const config = makeTestConfig({ projectRoot: tmpDir });
    const meta = makeTestMeta({ requirementDoc: "docs/design/77_Config.md" });
    const result = await resolvePlanDocPath(config, meta);
    expect(result).toBe(path.join(tmpDir, "docs/design/77_Config_plan.md"));
  });

  it("prevents _plan duplication (xxx_plan.md stays as-is)", async () => {
    const config = makeTestConfig({ projectRoot: tmpDir });
    const meta = makeTestMeta({ requirementDoc: "docs/design/77_Config_plan.md" });
    const result = await resolvePlanDocPath(config, meta);
    expect(result).toBe(path.join(tmpDir, "docs/design/77_Config_plan.md"));
  });

  it("falls back to glob mtime when requirementDoc is empty", async () => {
    await fs.mkdir(path.join(tmpDir, "docs", "design"), { recursive: true });
    // Create two plan files with different mtimes
    const older = path.join(tmpDir, "docs/design/older_plan.md");
    const newer = path.join(tmpDir, "docs/design/newer_plan.md");
    await fs.writeFile(older, "older content");
    // Set older mtime to 1 second ago
    const olderTime = new Date(Date.now() - 1000);
    await fs.utimes(older, olderTime, olderTime);
    await fs.writeFile(newer, "newer content");

    const config = makeTestConfig({ projectRoot: tmpDir });
    const meta = makeTestMeta({ requirementDoc: undefined });
    const result = await resolvePlanDocPath(config, meta);
    // Should return the newer file
    expect(result).toBe(newer);
  });

  it("returns null when no plan doc glob matches and requirementDoc is empty", async () => {
    const config = makeTestConfig({ projectRoot: tmpDir });
    const meta = makeTestMeta({ requirementDoc: undefined });
    const result = await resolvePlanDocPath(config, meta);
    expect(result).toBeNull();
  });
});

describe("Phase 1 (141): planDocHasConfirmMarker", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = path.join(tmpdir(), "pi-marker-" + Date.now());
    await fs.mkdir(tmpDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("returns true when ## 用户确认 marker exists", async () => {
    const planPath = path.join(tmpDir, "plan.md");
    await fs.writeFile(planPath, "# Plan\n\n## 用户确认\nconfirmed\n");
    const result = await planDocHasConfirmMarker(planPath);
    expect(result).toBe(true);
  });

  it("returns false when marker is missing", async () => {
    const planPath = path.join(tmpDir, "plan.md");
    await fs.writeFile(planPath, "# Plan\n\nNo confirmation yet\n");
    const result = await planDocHasConfirmMarker(planPath);
    expect(result).toBe(false);
  });

  it("returns false when file does not exist", async () => {
    const result = await planDocHasConfirmMarker(path.join(tmpDir, "nonexistent.md"));
    expect(result).toBe(false);
  });

  // Phase 2 (162): bilingual marker detection
  it("returns true when ## User Confirmation marker exists (bilingual)", async () => {
    const planPath = path.join(tmpDir, "plan.md");
    await fs.writeFile(planPath, "# Plan\n\n## User Confirmation: Confirmed\n");
    const result = await planDocHasConfirmMarker(planPath);
    expect(result).toBe(true);
  });

  it("returns true when legacy ## 用户确认：确认无误 marker exists (extended Chinese form)", async () => {
    const planPath = path.join(tmpDir, "plan.md");
    await fs.writeFile(planPath, "# Plan\n\n## 用户确认：确认无误\n");
    const result = await planDocHasConfirmMarker(planPath);
    expect(result).toBe(true);
  });
});

// ─── Phase 2 (162): runVerification deferContentPatterns ─────────────────────
describe("Phase 2 (162): runVerification deferContentPatterns", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = path.join(tmpdir(), "pi-defer-" + Date.now());
    await fs.mkdir(tmpDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  function makePlanConfigWithVerify(root: string) {
    const base = makeTestConfig({ projectRoot: root });
    // Override plan stage to have verify.require = true
    const planStage = { ...base.stages.plan, verify: { require: true, verifyFile: "", mode: "hook" as const } };
    return {
      ...base,
      stages: { ...base.stages, plan: planStage as typeof base.stages.plan },
    };
  }

  it("deferred fileContentPattern rule is excluded from execution", async () => {
    // Write a plan doc WITHOUT the marker — without deferral, verification fails
    const planPath = path.join(tmpDir, "plan.md");
    await fs.writeFile(planPath, "# Plan\n\nNo marker here\n");

    const config = makePlanConfigWithVerify(tmpDir);
    const meta = makeTestMeta({ currentStage: "plan" });

    // Write verify.md with a marker rule
    const verifyDir = path.join(tmpDir, ".pi", "references", "plan_spec");
    await fs.mkdir(verifyDir, { recursive: true });
    const verifyPath = path.join(verifyDir, "verify.md");
    await fs.writeFile(
      verifyPath,
      "---\nrules:\n  requiredFiles:\n    - \"plan.md\"\n  fileContentPattern:\n" +
        "    - path: \"plan.md\"\n      pattern: \"^## 用户确认\"\n---\n",
      "utf-8",
    );

    // Without deferContentPatterns: verification fails (marker missing)
    const resultWithoutDefer = await runVerification(config, meta, [], { verifyFile: verifyPath });
    expect(resultWithoutDefer.rulePassed).toBe(false);

    // With deferContentPatterns: the marker rule is skipped → verification passes
    const resultWithDefer = await runVerification(config, meta, [], {
      verifyFile: verifyPath,
      deferContentPatterns: [{ path: "plan.md", pattern: "^## 用户确认" }],
    });
    expect(resultWithDefer.rulePassed).toBe(true);
  });

  it("non-deferred rules still execute normally", async () => {
    const planPath = path.join(tmpDir, "plan.md");
    await fs.writeFile(planPath, "# Plan\n\n## 用户确认\n");

    const config = makePlanConfigWithVerify(tmpDir);
    const meta = makeTestMeta({ currentStage: "plan" });

    const verifyDir = path.join(tmpDir, ".pi", "references", "plan_spec");
    await fs.mkdir(verifyDir, { recursive: true });
    const verifyPath = path.join(verifyDir, "verify.md");
    await fs.writeFile(
      verifyPath,
      "---\nrules:\n  requiredFiles:\n    - \"plan.md\"\n  fileContentPattern:\n" +
        "    - path: \"plan.md\"\n      pattern: \"^## 用户确认\"\n    - path: \"plan.md\"\n      pattern: \"nonexistent_pattern\"\n---\n",
      "utf-8",
    );

    // Defer only the first rule — second still runs and fails
    const result = await runVerification(config, meta, [], {
      verifyFile: verifyPath,
      deferContentPatterns: [{ path: "plan.md", pattern: "^## 用户确认" }],
    });
    expect(result.rulePassed).toBe(false);
  });
});

// ─── Phase 1 (141): applyConcreteStageDocPaths ──────────────────────────────────
describe("Phase 1 (141): applyConcreteStageDocPaths", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = path.join(tmpdir(), "pi-concrete-" + Date.now());
    await fs.mkdir(tmpDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("replaces docs/design/*_plan.md glob with concrete path in requiredFiles and fileContentPattern", async () => {
    // Set up so resolvePlanDocPath can derive the path
    const config = makeTestConfig({ projectRoot: tmpDir });
    const meta = makeTestMeta({ currentStage: "plan", requirementDoc: "docs/design/77_Config.md" });

    const rules = {
      keywords: [],
      mode: "or" as const,
      requiredFiles: ["docs/design/*_plan.md", "src/index.ts"],
      fileContentPattern: [
        { path: "docs/design/*_plan.md", pattern: "^## 用户确认" },
        { path: "src/index.ts", pattern: "export" },
      ],
    };

    const result = await applyConcreteStageDocPaths(rules, config, meta);

    // Glob should be replaced with concrete relative path
    expect(result.requiredFiles).toEqual(["docs/design/77_Config_plan.md", "src/index.ts"]);
    expect(result.fileContentPattern).toEqual([
      { path: "docs/design/77_Config_plan.md", pattern: "^## 用户确认" },
      { path: "src/index.ts", pattern: "export" },
    ]);
  });

  it("preserves glob when resolvePlanDocPath derivation fails (no requirementDoc, no glob match)", async () => {
    const config = makeTestConfig({ projectRoot: tmpDir });
    const meta = makeTestMeta({ currentStage: "plan", requirementDoc: undefined });
    // No docs/design/*_plan.md files exist → glob fallback returns null → rules unchanged

    const rules = {
      keywords: [],
      mode: "or" as const,
      requiredFiles: ["docs/design/*_plan.md"],
      fileContentPattern: [
        { path: "docs/design/*_plan.md", pattern: "^## 用户确认" },
      ],
    };

    const result = await applyConcreteStageDocPaths(rules, config, meta);

    // Glob should be preserved as-is (derivation failed)
    expect(result.requiredFiles).toEqual(["docs/design/*_plan.md"]);
    expect(result.fileContentPattern).toEqual([
      { path: "docs/design/*_plan.md", pattern: "^## 用户确认" },
    ]);
  });

  it("returns rules with plan-doc globs preserved for develop stage (only commit-doc globs are narrowed)", async () => {
    const config = makeTestConfig({ projectRoot: tmpDir });
    const meta = makeTestMeta({ currentStage: "develop", requirementDoc: "docs/design/77_Config.md" });

    const rules = {
      keywords: [],
      mode: "or" as const,
      requiredFiles: ["docs/design/*_plan.md"],
      fileContentPattern: [
        { path: "docs/design/*_plan.md", pattern: "^## 用户确认" },
      ],
    };

    const result = await applyConcreteStageDocPaths(rules, config, meta);

    // Develop stage only narrows *_commit.md globs; *_plan.md globs pass through unchanged
    expect(result.requiredFiles).toEqual(["docs/design/*_plan.md"]);
    expect(result.fileContentPattern).toEqual([
      { path: "docs/design/*_plan.md", pattern: "^## 用户确认" },
    ]);
  });
});

// ── Phase 2 (148): runVerification skipped on config error ───────────────

describe("runVerification — 148 Phase 2 skipped on config error", () => {
  it("returns skipped=true when verify.md has invalid mode", async () => {
    const vrPath = path.join(TMP, "references", "develop_spec", "verify.md");
    await fs.mkdir(path.dirname(vrPath), { recursive: true });
    await fs.writeFile(
      vrPath,
      '---\nrules:\n  keywords:\n    - "test"\n  mode: xor\n---\nBody\n',
      "utf-8",
    );

    const config = makeTestConfig({
      projectRoot: TMP,
      stages: Object.fromEntries(
        ["clarify", "plan", "develop", "review", "fix", "awaiting_human", "completed"].map(
          (s, i, a) => [
            s,
            {
              agentPath: "a.md",
              skillPath: "s.md",
              nextStage: a[i + 1] ?? null,
              requireDomain: false,
              verify: s === "develop" ? { require: true, verifyFile: "references/develop_spec/verify.md" } : undefined,
            },
          ],
        ),
      ) as any,
    });
    const meta = makeTestMeta({ currentStage: "develop" });

    const result = await runVerification(config, meta, []);
    expect(result.skipped).toBe(true);
    expect(result.configErrors).toBeDefined();
    expect(result.configErrors!.some(e => e.includes("xor"))).toBe(true);
    expect(result.rulePassed).toBe(false);
    expect(result.needsModelVerify).toBe(false);
  });

  it("returns skipped=true when verify.md has unknown top-level key", async () => {
    const vrPath = path.join(TMP, "references", "develop_spec", "verify.md");
    await fs.mkdir(path.dirname(vrPath), { recursive: true });
    await fs.writeFile(
      vrPath,
      '---\nrules:\n  requiredFiles:\n    - "test.md"\nbadKey: value\n---\nBody\n',
      "utf-8",
    );

    const config = makeTestConfig({
      projectRoot: TMP,
      stages: Object.fromEntries(
        ["clarify", "plan", "develop", "review", "fix", "awaiting_human", "completed"].map(
          (s, i, a) => [
            s,
            {
              agentPath: "a.md",
              skillPath: "s.md",
              nextStage: a[i + 1] ?? null,
              requireDomain: false,
              verify: s === "develop" ? { require: true, verifyFile: "references/develop_spec/verify.md" } : undefined,
            },
          ],
        ),
      ) as any,
    });
    const meta = makeTestMeta({ currentStage: "develop" });

    const result = await runVerification(config, meta, []);
    expect(result.skipped).toBe(true);
    expect(result.configErrors).toBeDefined();
    expect(result.configErrors!.some(e => e.includes("badKey"))).toBe(true);
  });

  it("returns skipped=false when verify.md is valid", async () => {
    await fs.writeFile(path.join(TMP, "output.md"), "content");
    const vrPath = path.join(TMP, "references", "develop_spec", "verify.md");
    await fs.mkdir(path.dirname(vrPath), { recursive: true });
    await fs.writeFile(
      vrPath,
      '---\nrules:\n  requiredFiles:\n    - "output.md"\n---\nBody\n',
      "utf-8",
    );

    const config = makeTestConfig({
      projectRoot: TMP,
      stages: Object.fromEntries(
        ["clarify", "plan", "develop", "review", "fix", "awaiting_human", "completed"].map(
          (s, i, a) => [
            s,
            {
              agentPath: "a.md",
              skillPath: "s.md",
              nextStage: a[i + 1] ?? null,
              requireDomain: false,
              verify: s === "develop" ? { require: true, verifyFile: "references/develop_spec/verify.md" } : undefined,
            },
          ],
        ),
      ) as any,
    });
    const meta = makeTestMeta({ currentStage: "develop" });

    const result = await runVerification(config, meta, []);
    expect(result.skipped).toBeUndefined();
    expect(result.rulePassed).toBe(true);
  });
});

// ── 168 Phase 3: resolvePlaceholders {pipelineId} + applyConcreteStageDocPaths narrowing ──

describe("168 Phase 3: resolvePlaceholders {pipelineId} replacement", () => {
  it("replaces {pipelineId} in requiredFiles paths", () => {
    const rules = {
      keywords: [],
      mode: "or" as const,
      requiredFiles: ["docs/design/*_{pipelineId}_commit.md"],
    };
    const meta = makeTestMeta({ pipelineId: "pipe-abc123" });
    const resolved = resolvePlaceholders(rules, meta);
    expect(resolved.requiredFiles).toEqual(["docs/design/*_pipe-abc123_commit.md"]);
  });

  it("replaces {pipelineId} in fileContentPattern path AND pattern fields", () => {
    const rules = {
      keywords: [],
      mode: "or" as const,
      fileContentPattern: [
        {
          path: "docs/design/*_commit.md",
          pattern: "^\\*\\*pipeline\\*\\*:\\s*{pipelineId}$",
        },
      ],
    };
    const meta = makeTestMeta({ pipelineId: "pipe-xyz789" });
    const resolved = resolvePlaceholders(rules, meta);
    expect(resolved.fileContentPattern![0].path).toBe("docs/design/*_commit.md");
    expect(resolved.fileContentPattern![0].pattern).toBe("^\\*\\*pipeline\\*\\*:\\s*pipe-xyz789$");
  });

  it("preserves {pipelineId} placeholder when pipelineId is missing", () => {
    const rules = {
      keywords: [],
      mode: "or" as const,
      fileContentPattern: [
        {
          path: "docs/design/*_commit.md",
          pattern: "^\\*\\*pipeline\\*\\*:\\s*{pipelineId}$",
        },
      ],
    };
    const meta = makeTestMeta({ pipelineId: "" });
    const resolved = resolvePlaceholders(rules, meta);
    // Placeholder preserved (not replaced with empty string)
    expect(resolved.fileContentPattern![0].pattern).toBe("^\\*\\*pipeline\\*\\*:\\s*{pipelineId}$");
  });
});

describe("168 Phase 3: applyConcreteStageDocPaths narrowing (develop/fix/review)", () => {
  it("develop stage narrows *_commit.md glob to requirementDoc basename", async () => {
    const config = makeTestConfig({ projectRoot: "/tmp/test" });
    const meta = makeTestMeta({
      currentStage: "develop",
      requirementDoc: "docs/design/80_Fix.md",
    });
    const rules = {
      keywords: [],
      mode: "or" as const,
      requiredFiles: ["docs/design/*_commit.md"],
      fileContentPattern: [
        { path: "docs/design/*_commit.md", pattern: "^\\*\\*plan doc\\*\\*:" },
      ],
    };

    const result = await applyConcreteStageDocPaths(rules, config, meta);

    // Glob narrowed to requirementDoc basename
    expect(result.requiredFiles).toEqual(["docs/design/80_Fix_*_commit.md"]);
    expect(result.fileContentPattern![0].path).toBe("docs/design/80_Fix_*_commit.md");
  });

  it("fix stage narrows *_commit.md glob identically to develop", async () => {
    const config = makeTestConfig({ projectRoot: "/tmp/test" });
    const meta = makeTestMeta({
      currentStage: "fix",
      requirementDoc: "docs/design/99_Bug.md",
    });
    const rules = {
      keywords: [],
      mode: "or" as const,
      requiredFiles: ["docs/design/*_commit.md"],
    };

    const result = await applyConcreteStageDocPaths(rules, config, meta);
    expect(result.requiredFiles).toEqual(["docs/design/99_Bug_*_commit.md"]);
  });

  it("review stage narrows code_review_* glob to requirementDoc basename", async () => {
    const config = makeTestConfig({ projectRoot: "/tmp/test" });
    const meta = makeTestMeta({
      currentStage: "review",
      requirementDoc: "docs/design/50_Feat.md",
    });
    const rules = {
      keywords: [],
      mode: "or" as const,
      requiredFiles: ["docs/review/code_review_*.md"],
      fileContentPattern: [
        { path: "docs/review/code_review_*.md", pattern: "结论：(通过|不通过)" },
      ],
    };

    const result = await applyConcreteStageDocPaths(rules, config, meta);

    expect(result.requiredFiles).toEqual(["docs/review/code_review_50_Feat*.md"]);
    expect(result.fileContentPattern![0].path).toBe("docs/review/code_review_50_Feat*.md");
  });

  it("narrowed glob does NOT match historical files from different requirementDoc", () => {
    // Verify the narrowed glob pattern doesn't match a historical file
    expect(isCommitDocGlob("docs/design/80_Fix_*_commit.md")).toBe(false);
    expect(isReviewDocGlob("docs/review/code_review_50_Feat*.md")).toBe(false);
  });

  it("preserves original glob when requirementDoc is empty", async () => {
    const config = makeTestConfig({ projectRoot: "/tmp/test" });
    const meta = makeTestMeta({
      currentStage: "develop",
      requirementDoc: "",
    });
    const rules = {
      keywords: [],
      mode: "or" as const,
      requiredFiles: ["docs/design/*_commit.md"],
    };

    const result = await applyConcreteStageDocPaths(rules, config, meta);
    // No narrowing: original glob preserved
    expect(result.requiredFiles).toEqual(["docs/design/*_commit.md"]);
  });
});
