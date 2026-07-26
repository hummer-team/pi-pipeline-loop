import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { tmpdir } from "node:os";
import {
  parseVerifyFile,
  ruleVerify,
  runVerification,
} from "../../core/auto-verifier";
import { makeTestConfig, makeTestMeta } from "../helpers";

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
    expect(result.prompt).toContain("是否完全理解了用户需求？");
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
