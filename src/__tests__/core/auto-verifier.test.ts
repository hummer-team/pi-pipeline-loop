import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { tmpdir } from "node:os";
import {
  parseVerifyFile,
  ruleVerify,
  runVerification,
  executeStructuredRules,
} from "../../core/auto-verifier";
import { makeTestConfig, makeTestMeta } from "../helpers";
import { initAuditLog, getDateAuditFileName, __resetAuditDirPath } from "../../utils/auditLog";

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
        ["clarify", "design", "plan", "develop", "review", "fix", "awaiting_human", "completed"].map(
          (s, i, a) => [
            s,
            {
              agentFile: "a.md",
              skillPath: "s.md",
              allowedTools: ["read"],
              allowedBashPrefixes: ["ls"],
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
        ["clarify", "design", "plan", "develop", "review", "fix", "awaiting_human", "completed"].map(
          (s, i, a) => [
            s,
            {
              agentFile: "a.md",
              skillPath: "s.md",
              allowedTools: ["read"],
              allowedBashPrefixes: ["ls"],
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
        ["clarify", "design", "plan", "develop", "review", "fix", "awaiting_human", "completed"].map(
          (s, i, a) => [
            s,
            {
              agentFile: "a.md",
              skillPath: "s.md",
              allowedTools: ["read"],
              allowedBashPrefixes: ["ls"],
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
});
