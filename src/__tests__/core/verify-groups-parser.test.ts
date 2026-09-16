/**
 * @module verify-groups-parser.test
 * Phase 0 / 176 — groups / rule-node schema parsing in verify-frontmatter.
 *
 * Covers: v6 clarify/review full-form parsing, `pattern:` sugar normalization,
 * inline-flow vs block `patterns`, full-line comments (quoted `#` preserved),
 * indentation boundaries, invalid-node discard + audit, groups-only hasAnyRules,
 * and legacy flat frontmatter result invariance.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { parseFrontmatter } from "../../core/verify-frontmatter";
import { initAuditLog, getDateAuditFileName, __resetAuditDirPath } from "../../utils/auditLog";
import { makeTestConfig } from "../helpers";

let TMP: string;

beforeEach(async () => {
  TMP = path.join(tmpdir(), `pi-groups-parser-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await fs.mkdir(TMP, { recursive: true });
});

afterEach(async () => {
  await fs.rm(TMP, { recursive: true, force: true });
  __resetAuditDirPath();
});

/**
 * Decodes `\uXXXX` sequences. The repository source is stored with non-ASCII
 * escaped, so raw string literals must be decoded before comparing against
 * values that already passed through the YAML unescaper.
 */
function u(s: string): string {
  return s.replace(/\\u([0-9a-fA-F]{4})/g, (_m, hex: string) => String.fromCharCode(parseInt(hex, 16)));
}

/** Reads today's audit log content, or "" when no log file exists. */
async function readAuditLog(): Promise<string> {
  const logFile = path.join(TMP, ".pi", "audit", getDateAuditFileName());
  try {
    return await fs.readFile(logFile, "utf-8");
  } catch {
    return "";
  }
}

// ─── v6 full-form parsing ─────────────────────────────────────────────────────

const CLARIFY_V6 = String.raw`rules:
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
            - "full-und\\? .*理解确认[:：]\\s*[*_]{0,2}(是|yes|Y)"
        - type: fileContentPattern
          mode: or
          runtime: modelConfirm
          patterns:
            - "^##\\s*模型确认"
            - "^##\\s*Model\\s+Confirmation"`;

describe("Phase 0 / 176: v6 clarify groups parsing", () => {
  it("parses file-level path + both groups field-by-field", async () => {
    const rules = await parseFrontmatter(CLARIFY_V6);
    expect(rules).not.toBeNull();
    expect(rules!.path).toBe("{requirementDoc}");
    expect(rules!.groups).toHaveLength(2);

    const [roundGroup, confirmGroup] = rules!.groups!;
    expect(roundGroup.name).toBe("round-well-formed");
    expect(roundGroup.runtime).toBe("roundHeading");
    expect(roundGroup.scope).toBe("section");
    expect(roundGroup.ruleMode).toBe("and");
    expect(roundGroup.rules).toHaveLength(2);

    // Node 1: literal option/plan pattern (no runtime)
    expect(roundGroup.rules[0].type).toBe("fileContentPattern");
    expect(roundGroup.rules[0].patterns).toEqual([
      u(String.raw`^- \*{0,2}(?:方案|Option|Plan)[ \t]*[A-Z]`),
    ]);
    expect(roundGroup.rules[0].runtime).toBeUndefined();

    // Node 2: bilingual answer field with node-level OR + runtime anchor
    expect(roundGroup.rules[1].mode).toBe("or");
    expect(roundGroup.rules[1].runtime).toBe("answerField");
    expect(roundGroup.rules[1].patterns).toEqual([
      u(String.raw`答\s*[:：]|\*{2}答\*{2}`),
      u(String.raw`Answer\s*:`),
    ]);

    // Group 2: full-und confirmation with modelConfirm runtime anchor
    expect(confirmGroup.name).toBe("full-und-confirmed");
    expect(confirmGroup.ruleMode).toBe("and");
    expect(confirmGroup.rules).toHaveLength(2);
    expect(confirmGroup.rules[0].mode).toBe("or");
    expect(confirmGroup.rules[0].patterns).toEqual([
      u(String.raw`full-und\? 理解确认：是`),
      u(String.raw`full-und\? .*理解确认[:：]\s*[*_]{0,2}(是|yes|Y)`),
    ]);
    expect(confirmGroup.rules[1].runtime).toBe("modelConfirm");
    expect(confirmGroup.rules[1].patterns).toEqual([
      u(String.raw`^##\s*模型确认`),
      u(String.raw`^##\s*Model\s+Confirmation`),
    ]);
  });

  it("when pattern carries named groups roundZh/roundEn for runtime derivation", async () => {
    const rules = await parseFrontmatter(CLARIFY_V6);
    const when = rules!.groups![0].when!;
    const re = new RegExp(when, "gm");

    let m = re.exec("# 第 3 轮澄清");
    expect(m?.groups?.roundZh).toBe("3");
    re.lastIndex = 0;
    m = re.exec("## Round 5 — fixes");
    expect(m?.groups?.roundEn).toBe("5");
  });
});

const REVIEW_V6 = String.raw`rules:
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
        - type: fileContentPattern
          patterns: ["^\\*\\*pipeline\\*\\*:\\s*{pipelineId}$"]`;

describe("Phase 0 / 176: v6 review groups parsing", () => {
  it("parses requiredFile with inherited path + verdict runtime node", async () => {
    const rules = await parseFrontmatter(REVIEW_V6);
    expect(rules!.path).toBe("docs/review/code_review_*.md");
    const group = rules!.groups![0];
    expect(group.name).toBe("review-report-ready");
    expect(group.ruleMode).toBe("and");
    expect(group.rules).toHaveLength(3);

    // requiredFile has no node path → inherits file-level path at eval time
    expect(group.rules[0].type).toBe("requiredFile");
    expect(group.rules[0].path).toBeUndefined();

    expect(group.rules[1].runtime).toBe("verdict");
    expect(group.rules[1].mode).toBe("or");
    expect(group.rules[1].patterns).toEqual([
      u(String.raw`结论\s*[:：]\s*[*_]{0,2}(不通过|通过)[*_]{0,2}`),
      u(String.raw`Verdict\s*[:：]\s*[*_]{0,2}(PASS|FAIL)[*_]{0,2}`),
      u(String.raw`Conclusion\s*[:：]\s*[*_]{0,2}(pass|fail)[*_]{0,2}`),
    ]);

    // Inline-flow patterns form for the pipelineId node
    expect(group.rules[2].patterns).toEqual([
      u(String.raw`^\*\*pipeline\*\*:\s*{pipelineId}$`),
    ]);
  });
});

// ─── Sugar / list forms / comments / indentation ─────────────────────────────

describe("Phase 0 / 176: pattern sugar, list forms, comments, indentation", () => {
  it("normalizes single `pattern:` sugar to a one-element patterns list", async () => {
    const rules = await parseFrontmatter(String.raw`rules:
  path: "docs/x.md"
  groups:
    - name: g1
      rules:
        - type: fileContentPattern
          pattern: "solo"`);
    expect(rules!.groups![0].rules[0].patterns).toEqual(["solo"]);
  });

  it("parses both inline-flow and block patterns lists", async () => {
    const rules = await parseFrontmatter(String.raw`rules:
  path: "docs/x.md"
  groups:
    - name: g1
      rules:
        - type: fileContentPattern
          patterns: [ "a", "b" ]
        - type: fileContentPattern
          patterns:
            - "c"
            - "d"`);
    expect(rules!.groups![0].rules[0].patterns).toEqual(["a", "b"]);
    expect(rules!.groups![0].rules[1].patterns).toEqual(["c", "d"]);
  });

  it("keeps commas inside quoted inline patterns (quote-aware split)", async () => {
    const rules = await parseFrontmatter(String.raw`rules:
  path: "docs/x.md"
  groups:
    - name: g1
      rules:
        - type: fileContentPattern
          patterns: [ "^x{1,3}$", "y" ]`);
    expect(rules!.groups![0].rules[0].patterns).toEqual(["^x{1,3}$", "y"]);
  });

  it("skips full-line comments and preserves `#` inside quoted values", async () => {
    const rules = await parseFrontmatter(String.raw`rules:
  path: "{requirementDoc}"
  groups:
    # a full-line comment inside groups
    - name: g1
      # comment before rules
      rules:
        # comment before node
        - type: fileContentPattern
          pattern: "value#hash"`);
    expect(rules!.groups).toHaveLength(1);
    expect(rules!.groups![0].rules[0].patterns).toEqual(["value#hash"]);
  });

  it("respects 2/4/6/8 indentation levels without cross-level bleed", async () => {
    const rules = await parseFrontmatter(String.raw`rules:
  path: "{requirementDoc}"
  groups:
    - name: g1
      ruleMode: or
      rules:
        - type: requiredFile
        - type: modelRuntimeResult
          mode: or
          patterns:
            - "p1"
            - "p2"`);
    const group = rules!.groups![0];
    expect(group.ruleMode).toBe("or");
    expect(group.rules[0].type).toBe("requiredFile");
    expect(group.rules[1].type).toBe("modelRuntimeResult");
    expect(group.rules[1].mode).toBe("or");
    expect(group.rules[1].patterns).toEqual(["p1", "p2"]);
  });
});

// ─── Validation / discard / hasAnyRules ──────────────────────────────────────

describe("Phase 0 / 176: node validation and audit", () => {
  it("discards nodes with invalid type and audits the reason", async () => {
    const config = makeTestConfig({ projectRoot: TMP, auditDir: ".pi/audit" });
    await initAuditLog(config);

    const rules = await parseFrontmatter(String.raw`rules:
  path: "{requirementDoc}"
  groups:
    - name: g1
      rules:
        - type: bogusType
          patterns: ["x"]
        - type: fileContentPattern
          patterns: ["valid"]`);

    expect(rules!.groups![0].rules).toHaveLength(1);
    expect(rules!.groups![0].rules[0].patterns).toEqual(["valid"]);

    const log = await readAuditLog();
    expect(log).toContain("verify_frontmatter_parse_error");
    expect(log).toContain("Groups rule nodes discarded");
    expect(log).toContain("bogusType");
  });

  it("discards fileContentPattern nodes with no path source but keeps the empty group", async () => {
    const rules = await parseFrontmatter(String.raw`rules:
  groups:
    - name: g1
      rules:
        - type: fileContentPattern
          patterns: ["x"]`);
    expect(rules).not.toBeNull();
    expect(rules!.groups).toHaveLength(1);
    expect(rules!.groups![0].rules).toHaveLength(0);
  });

  it("falls back invalid ruleMode to and and audits a warning", async () => {
    const config = makeTestConfig({ projectRoot: TMP, auditDir: ".pi/audit" });
    await initAuditLog(config);

    const rules = await parseFrontmatter(String.raw`rules:
  path: "{requirementDoc}"
  groups:
    - name: g1
      ruleMode: maybe
      rules:
        - type: requiredFile`);

    expect(rules!.groups![0].ruleMode).toBe("and");
    const log = await readAuditLog();
    expect(log).toContain("Groups schema warnings");
    expect(log).toContain("maybe");
    expect(log).toContain("[WARN]");
  });

  it("treats groups-only frontmatter as having rules", async () => {
    const rules = await parseFrontmatter(String.raw`rules:
  path: "{requirementDoc}"
  groups:
    - name: g1
      rules:
        - type: requiredFile`);
    expect(rules).not.toBeNull();
    expect(rules!.groups).toHaveLength(1);
  });
});

// ─── Legacy flat invariance ───────────────────────────────────────────────────

describe("Phase 0 / 176: legacy flat frontmatter invariance", () => {
  const LEGACY = String.raw`rules:
  requiredFiles:
    - "docs/a.md"
  fileContentPattern:
    - path: "docs/a.md"
      pattern: "^x$"
  keywords:
    - "done"
  mode: and`;

  it("produces exactly the legacy result shape (no groups/path keys)", async () => {
    const rules = await parseFrontmatter(LEGACY);
    const expected = {
      keywords: ["done"],
      mode: "and",
      requiredFiles: ["docs/a.md"],
      fileContentPattern: [{ path: "docs/a.md", pattern: "^x$" }],
    };
    // Byte-for-byte identical serialization (key order included)
    expect(JSON.stringify(rules)).toBe(JSON.stringify(expected));
    expect(rules).not.toHaveProperty("groups");
    expect(rules).not.toHaveProperty("path");
  });

  it("legacy mode default stays or and invalid mode stays tolerated (no groups audit)", async () => {
    const rules = await parseFrontmatter(String.raw`rules:
  keywords:
    - "done"`);
    expect(rules!.mode).toBe("or");
  });
});

// ─── Phase 3 / 179 (G4): optional `example` key parsing ──────────────────────

describe("Phase 3 / 179 (G4): example optional key parsing", () => {
  it("parses a group node-level example into the rule node", async () => {
    const rules = await parseFrontmatter(String.raw`rules:
  path: "doc.md"
  groups:
    - name: g
      rules:
        - type: fileContentPattern
          patterns: ["^NOPE$"]
          example: "- **方案 A：xxx**"
`);
    expect(rules).not.toBeNull();
    const node = rules!.groups![0].rules[0];
    expect(node.example).toBe("- **方案 A：xxx**");
  });

  it("parses a legacy flat fileContentPattern example", async () => {
    const rules = await parseFrontmatter(String.raw`rules:
  fileContentPattern:
    - path: "doc.md"
      pattern: "^NOPE$"
      example: "答：方案 A"
`);
    expect(rules).not.toBeNull();
    expect(rules!.fileContentPattern![0].example).toBe("答：方案 A");
  });

  it("omits example when absent (backward compatible node shape)", async () => {
    const rules = await parseFrontmatter(String.raw`rules:
  path: "doc.md"
  groups:
    - name: g
      rules:
        - type: fileContentPattern
          patterns: ["^x$"]
`);
    expect(rules!.groups![0].rules[0].example).toBeUndefined();
  });
});
