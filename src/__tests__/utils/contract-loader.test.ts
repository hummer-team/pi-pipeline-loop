/**
 * @module contract-loader.test
 * Phase 2 / 176 — runtime contract-anchor extraction, validation and fail-open.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { loadVerifyContractAnchors, resolveVerifyFilePath } from "../../utils/contract-loader";
import { runVerification } from "../../core/auto-verifier";
import { makeTestConfig, makeTestMeta } from "../helpers";

/** Decodes \uXXXX sequences stored by the source-file encoding. */
function u(s: string): string {
  return s.replace(/\\u([0-9a-fA-F]{4})/g, (_m, hex: string) => String.fromCharCode(parseInt(hex, 16)));
}

let TMP: string;

beforeEach(async () => {
  TMP = path.join(tmpdir(), `pi-contract-loader-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await fs.mkdir(TMP, { recursive: true });
});

afterEach(async () => {
  await fs.rm(TMP, { recursive: true, force: true });
});

/** Builds a config whose clarify stage reads `verify.md` from the temp root. */
function clarifyConfig() {
  const config = makeTestConfig({ projectRoot: TMP });
  config.stages.clarify.verify = { require: true, verifyFile: "verify.md" };
  return config;
}

const CLARIFY_V6 = String.raw`---
rules:
  path: "{requirementDoc}"
  groups:
    - name: round-well-formed
      when: "^#{1,2}\\s*(?:第\\s*(?<roundZh>\\d+)\\s*轮澄清|[Rr]ound\\s+(?<roundEn>\\d+))"
      runtime: roundHeading
      scope: section
      ruleMode: and
      rules:
        - type: fileContentPattern
          patterns: ["^- \\*{0,2}(?:方案|Option|Plan)[ \\t]*[A-Z]"]
        - type: fileContentPattern
          mode: or
          runtime: answerField
          patterns:
            - "答\\s*[:：]|\\*{2}答\\*{2}"
            - "Answer\\s*:"
    - name: full-und-confirmed
      ruleMode: and
      rules:
        - type: fileContentPattern
          mode: or
          patterns:
            - "full-und\\? 理解确认：是"
        - type: fileContentPattern
          mode: or
          runtime: modelConfirm
          patterns:
            - "^##\\s*模型确认"
            - "^##\\s*Model\\s+Confirmation"
---`;

describe("Phase 2 / 176: loadVerifyContractAnchors", () => {
  it("extracts roundHeading / answerField / modelConfirm from the clarify schema", async () => {
    await fs.writeFile(path.join(TMP, "verify.md"), CLARIFY_V6, "utf-8");
    const { anchors, issues } = await loadVerifyContractAnchors(clarifyConfig(), "clarify");

    expect(issues).toEqual([]);
    expect(anchors.roundHeading?.patterns).toHaveLength(1);
    expect(anchors.roundHeading?.patterns[0]).toBe(
      u(String.raw`^#{1,2}\s*(?:第\s*(?<roundZh>\d+)\s*轮澄清|[Rr]ound\s+(?<roundEn>\d+))`),
    );
    expect(anchors.answerField?.mode).toBe("or");
    expect(anchors.answerField?.patterns).toEqual([
      u(String.raw`答\s*[:：]|\*{2}答\*{2}`),
      u(String.raw`Answer\s*:`),
    ]);
    expect(anchors.modelConfirm?.patterns).toEqual([
      u(String.raw`^##\s*模型确认`),
      u(String.raw`^##\s*Model\s+Confirmation`),
    ]);
    expect(anchors.verdict).toBeUndefined();
  });

  it("extracts the multi-form verdict anchor (each pattern has capture group 1)", async () => {
    const reviewVerify = String.raw`---
rules:
  path: "docs/review/code_review_*.md"
  groups:
    - name: review-report-ready
      ruleMode: and
      rules:
        - type: requiredFile
        - type: fileContentPattern
          mode: or
          runtime: verdict
          patterns:
            - "结论\\s*[:：]\\s*[*_]{0,2}(不通过|通过)[*_]{0,2}"
            - "Verdict\\s*[:：]\\s*[*_]{0,2}(PASS|FAIL)[*_]{0,2}"
            - "Conclusion\\s*[:：]\\s*[*_]{0,2}(pass|fail)[*_]{0,2}"
---`;
    await fs.writeFile(path.join(TMP, "verify.md"), reviewVerify, "utf-8");
    const config = clarifyConfig();
    const { anchors, issues } = await loadVerifyContractAnchors(config, "clarify");

    expect(issues).toEqual([]);
    expect(anchors.verdict?.mode).toBe("or");
    expect(anchors.verdict?.patterns).toHaveLength(3);
  });

  it("reports an issue and omits the key when roundHeading lacks named groups", async () => {
    const bad = String.raw`---
rules:
  path: "docs/x.md"
  groups:
    - name: round
      when: "^#{1,2}\\s*第\\s*(\\d+)\\s*轮澄清"
      runtime: roundHeading
      rules:
        - type: fileContentPattern
          pattern: "x"
---`;
    await fs.writeFile(path.join(TMP, "verify.md"), bad, "utf-8");
    const { anchors, issues } = await loadVerifyContractAnchors(clarifyConfig(), "clarify");

    expect(issues.some((i) => i.includes("roundZh"))).toBe(true);
    expect(anchors.roundHeading).toBeUndefined();
  });

  it("reports an issue and omits verdict when a pattern lacks capture group 1", async () => {
    const bad = String.raw`---
rules:
  path: "docs/x.md"
  groups:
    - name: review
      rules:
        - type: fileContentPattern
          runtime: verdict
          pattern: "结论：通过"
---`;
    await fs.writeFile(path.join(TMP, "verify.md"), bad, "utf-8");
    const { anchors, issues } = await loadVerifyContractAnchors(clarifyConfig(), "clarify");

    expect(issues.some((i) => i.includes("capture group 1"))).toBe(true);
    expect(anchors.verdict).toBeUndefined();
  });

  it("reports an issue for an invalid node runtime value", async () => {
    const bad = String.raw`---
rules:
  path: "docs/x.md"
  groups:
    - name: g
      rules:
        - type: fileContentPattern
          runtime: bogusAnchor
          pattern: "x"
---`;
    await fs.writeFile(path.join(TMP, "verify.md"), bad, "utf-8");
    const { anchors, issues } = await loadVerifyContractAnchors(clarifyConfig(), "clarify");

    expect(issues.some((i) => i.includes("bogusAnchor"))).toBe(true);
    expect(anchors.answerField).toBeUndefined();
    expect(anchors.modelConfirm).toBeUndefined();
    expect(anchors.verdict).toBeUndefined();
  });

  it("returns empty anchors + issue when verify.md is missing", async () => {
    const { anchors, issues } = await loadVerifyContractAnchors(clarifyConfig(), "clarify");
    expect(anchors).toEqual({});
    expect(issues.length).toBeGreaterThan(0);
    expect(issues[0]).toContain("unreadable");
  });

  it("returns empty anchors + issue when frontmatter is missing", async () => {
    await fs.writeFile(path.join(TMP, "verify.md"), "no frontmatter here", "utf-8");
    const { anchors, issues } = await loadVerifyContractAnchors(clarifyConfig(), "clarify");
    expect(anchors).toEqual({});
    expect(issues.some((i) => i.includes("frontmatter"))).toBe(true);
  });
});

describe("Phase 2 / 176: resolveVerifyFilePath single source", () => {
  it("resolves stage config verifyFile, override, and default paths", () => {
    const config = clarifyConfig();
    expect(resolveVerifyFilePath(config, "clarify")).toBe(path.join(TMP, "verify.md"));
    expect(resolveVerifyFilePath(config, "clarify", "override.md")).toBe(path.join(TMP, "override.md"));
    expect(resolveVerifyFilePath(config, "plan")).toBe(
      path.join(TMP, ".pi", "references", "plan_spec", "verify.md"),
    );
  });

  it("runVerification reads the same path returned by resolveVerifyFilePath", async () => {
    const config = clarifyConfig();
    await fs.writeFile(path.join(TMP, "exists.md"), "content");
    await fs.writeFile(
      path.join(TMP, "verify.md"),
      [
        "---",
        "rules:",
        "  groups:",
        "    - name: ready",
        "      rules:",
        "        - type: requiredFile",
        '          path: "exists.md"',
        "---",
        "body",
      ].join("\n"),
      "utf-8",
    );

    const meta = makeTestMeta({ currentStage: "clarify" });
    const result = await runVerification(config, meta, []);
    expect(result.rulePassed).toBe(true);
  });
});
