/**
 * @module group-verifier.test
 * Phase 1 / 176 — groups evaluation engine, conditionals, defer penetration,
 * and `[group:name][ruleType]` failure reflow (wake + prompt injection).
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { evaluateGroups } from "../../core/verifiers/group-verifier";
import type { VerifyRules } from "../../core/verify-frontmatter";
import { runVerification } from "../../core/auto-verifier";
import { applyVerifyFail } from "../../core/verify-advance";
import { createPromptInjector } from "../../core/prompt-injector";
import { PLAN_CONFIRM_MARKER_RULE } from "../../core/stage-advancer";
import { makeTestConfig, makeTestMeta, createMockCtx, writePromptYml } from "../helpers";
import { initAuditLog, __resetAuditDirPath } from "../../utils/auditLog";
import { resetPromptConfigCache } from "../../core/prompt-config";

/** Decodes \uXXXX sequences stored by the source-file encoding. */
function u(s: string): string {
  return s.replace(/\\u([0-9a-fA-F]{4})/g, (_m, hex: string) => String.fromCharCode(parseInt(hex, 16)));
}

const ROUND_WHEN = u(String.raw`^#{1,2}\s*(?:第\s*(?<roundZh>\d+)\s*轮澄清|[Rr]ound\s+(?<roundEn>\d+))`);
const OPTION_PATTERN = u(String.raw`^- \*{0,2}(?:方案|Option|Plan)[ \t]*[A-Z]`);
const ANSWER_PATTERNS = [u(String.raw`答\s*[:：]`), u(String.raw`Answer\s*:`)];

let TMP: string;

beforeEach(async () => {
  TMP = path.join(tmpdir(), `pi-group-verifier-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await fs.mkdir(TMP, { recursive: true });
  resetPromptConfigCache();
});

afterEach(async () => {
  await fs.rm(TMP, { recursive: true, force: true });
  __resetAuditDirPath();
  resetPromptConfigCache();
});

async function writeDoc(rel: string, content: string): Promise<void> {
  const abs = path.join(TMP, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, content, "utf-8");
}

/** Round-well-formed group (mirrors the v6 clarify template). */
function clarifyRules(scope: "section" | undefined): VerifyRules {
  return {
    keywords: [],
    mode: "or",
    path: "doc.md",
    groups: [
      {
        name: "round-well-formed",
        when: ROUND_WHEN,
        ...(scope ? { scope } : {}),
        ruleMode: "and",
        rules: [
          { type: "fileContentPattern", patterns: [OPTION_PATTERN] },
          { type: "fileContentPattern", mode: "or", patterns: ANSWER_PATTERNS },
        ],
      },
    ],
  };
}

// ─── Three-layer boolean matrix ──────────────────────────────────────────────

describe("Phase 1 / 176: three-layer boolean evaluation", () => {
  it("cross-group AND: one failing group fails the whole evaluation", async () => {
    await writeDoc("doc.md", ["# Title", "present"].join("\n"));
    const rules: VerifyRules = {
      keywords: [],
      mode: "or",
      path: "doc.md",
      groups: [
        {
          name: "g-and",
          ruleMode: "and",
          rules: [
            { type: "requiredFile" },
            { type: "fileContentPattern", patterns: ["^# Title$"] },
          ],
        },
        {
          name: "g-or",
          ruleMode: "or",
          rules: [
            { type: "fileContentPattern", patterns: ["NOPE"] },
            { type: "fileContentPattern", patterns: ["present"] },
          ],
        },
      ],
    };
    const result = await evaluateGroups(rules, TMP, []);
    expect(result.passed).toBe(true);
  });

  it("cross-group AND: reports all failures from the failing group", async () => {
    await writeDoc("doc.md", "# Title");
    const rules: VerifyRules = {
      keywords: [],
      mode: "or",
      path: "doc.md",
      groups: [
        {
          name: "g-or",
          ruleMode: "or",
          rules: [
            { type: "fileContentPattern", patterns: ["NOPE"] },
            { type: "fileContentPattern", patterns: ["ALSO_NOPE"] },
          ],
        },
      ],
    };
    const result = await evaluateGroups(rules, TMP, []);
    expect(result.passed).toBe(false);
    expect(result.failures).toHaveLength(2);
    expect(result.failures.every((f) => f.group === "g-or")).toBe(true);
  });

  it("node mode AND requires all patterns; node mode OR accepts any", async () => {
    await writeDoc("doc.md", "alpha");
    const andRules: VerifyRules = {
      keywords: [], mode: "or", path: "doc.md",
      groups: [{ name: "g", rules: [{ type: "fileContentPattern", mode: "and", patterns: ["alpha", "beta"] }] }],
    };
    const orRules: VerifyRules = {
      keywords: [], mode: "or", path: "doc.md",
      groups: [{ name: "g", rules: [{ type: "fileContentPattern", mode: "or", patterns: ["alpha", "beta"] }] }],
    };
    expect((await evaluateGroups(andRules, TMP, [])).passed).toBe(false);
    expect((await evaluateGroups(orRules, TMP, [])).passed).toBe(true);
  });

  // Phase 3 / 179 (G4): node-level `example` is forwarded to failure details.
  it("OR node with example → every failing pattern detail carries the expected sample", async () => {
    await writeDoc("doc.md", "no structure here");
    const rules: VerifyRules = {
      keywords: [], mode: "or", path: "doc.md",
      groups: [{
        name: "g-example",
        rules: [{
          type: "fileContentPattern",
          mode: "or",
          patterns: ["^NOPE_A$", "^NOPE_B$"],
          example: "- **方案 A：xxx**",
        }],
      }],
    };
    const result = await evaluateGroups(rules, TMP, []);
    expect(result.passed).toBe(false);
    expect(result.failures.length).toBeGreaterThan(0);
    expect(result.failures.every((f) => f.detail.includes("; expected: - **方案 A：xxx**"))).toBe(true);
  });
});

// ─── when / scope conditionals ───────────────────────────────────────────────

describe("Phase 1 / 176: when / scope conditionals", () => {
  it("when with no match → group always passes (empty-match pass-through)", async () => {
    await writeDoc("doc.md", "no round headings here");
    const result = await evaluateGroups(clarifyRules("section"), TMP, []);
    expect(result.passed).toBe(true);
    expect(result.failures).toHaveLength(0);
  });

  it("when matched + scope: section → per-section strict (all sections must pass)", async () => {
    await writeDoc("doc.md", [
      "# 第 1 轮澄清",
      "- 方案 A",
      "答：yes",
      "# 第 2 轮澄清",
      "- 方案 B",
      "答：yes",
    ].join("\n"));
    const result = await evaluateGroups(clarifyRules("section"), TMP, []);
    expect(result.passed).toBe(true);
  });

  it("175-G4 red-green: round 1 missing answer + round 2 answered → must FAIL", async () => {
    await writeDoc("doc.md", [
      "# 第 1 轮澄清",
      "- 方案 A",
      "# 第 2 轮澄清",
      "- 方案 B",
      "答：yes",
    ].join("\n"));
    const result = await evaluateGroups(clarifyRules("section"), TMP, []);
    expect(result.passed).toBe(false);
    expect(result.failures.some((f) => f.detail.includes("round 1"))).toBe(true);
    expect(result.failures.every((f) => f.group === "round-well-formed")).toBe(true);
  });

  it("scope absent → whole-document evaluation (answer anywhere passes)", async () => {
    await writeDoc("doc.md", [
      "# 第 1 轮澄清",
      "- 方案 A",
      "# 第 2 轮澄清",
      "- 方案 B",
      "答：yes",
    ].join("\n"));
    // Same document fails under section scope, passes under whole-document scope.
    expect((await evaluateGroups(clarifyRules("section"), TMP, [])).passed).toBe(false);
    expect((await evaluateGroups(clarifyRules(undefined), TMP, [])).passed).toBe(true);
  });
});

// ─── modelRuntimeResult ──────────────────────────────────────────────────────

describe("Phase 1 / 176: modelRuntimeResult", () => {
  it("matches aggregated assistant messages (AND/OR + m flag across messages)", async () => {
    const rules: VerifyRules = {
      keywords: [], mode: "or",
      groups: [{
        name: "runtime",
        ruleMode: "and",
        rules: [
          { type: "modelRuntimeResult", mode: "and", patterns: ["DONE"] },
          { type: "modelRuntimeResult", mode: "or", patterns: ["^ANSWERED$", "NOPE"] },
        ],
      }],
    };
    const hit = await evaluateGroups(rules, TMP, ["working...", "DONE", "ANSWERED"]);
    expect(hit.passed).toBe(true);

    const miss = await evaluateGroups(rules, TMP, ["working..."]);
    expect(miss.passed).toBe(false);
    expect(miss.failures.some((f) => f.ruleType === "modelRuntimeResult")).toBe(true);
  });
});

// ─── defer penetration ───────────────────────────────────────────────────────

describe("Phase 1 / 176: defer penetration into groups", () => {
  it("deferring the plan marker removes the pattern and the group still passes", async () => {
    await writeDoc("verify.md", [
      "---",
      "rules:",
      "  path: \"docs/design/*_plan.md\"",
      "  groups:",
      "    - name: plan-ready",
      "      rules:",
      "        - type: fileContentPattern",
      `          pattern: "${PLAN_CONFIRM_MARKER_RULE.pattern}"`,
      "---",
      "body",
    ].join("\n"));

    const config = makeTestConfig({ projectRoot: TMP });
    config.stages.plan.verify = { require: true, verifyFile: "verify.md" };
    await initAuditLog(config);
    const meta = makeTestMeta({ currentStage: "plan", pipelineId: "pipe-defer-001" });

    // Without deferral: no plan doc exists → the group fails.
    const withoutDefer = await runVerification(config, meta, []);
    expect(withoutDefer.rulePassed).toBe(false);

    // With deferral: the pattern is removed → emptied group passes.
    const withDefer = await runVerification(config, meta, [], {
      deferContentPatterns: [PLAN_CONFIRM_MARKER_RULE],
    });
    expect(withDefer.rulePassed).toBe(true);
  });
});

// ─── Failure reflow prefix ───────────────────────────────────────────────────

describe("Phase 1 / 176: [group:name][ruleType] failure reflow", () => {
  it("wake message carries the group prefix", async () => {
    const sent: string[] = [];
    const meta = makeTestMeta({ currentStage: "develop" });
    const ctx = createMockCtx(meta, { pi: { sendUserMessage: (msg) => sent.push(msg) } });

    await applyVerifyFail(
      ctx as unknown as Parameters<typeof applyVerifyFail>[0],
      meta,
      "develop",
      {
        structuredResult: {
          failures: [{ ruleType: "fileContentPattern", detail: "missing artifact", group: "deliverable" }],
        },
        ruleMissing: [],
        verifyResult: null,
      },
      "rule",
    );

    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("[deliverable][fileContentPattern] missing artifact");
  });

  it("prompt injection renders the group prefix", async () => {
    await writePromptYml(TMP, [
      "develop: |",
      "  {{pipeline_status}}",
      "  ---",
      "  {{verify_failures}}",
      "",
    ].join("\n"));
    const config = makeTestConfig({ projectRoot: TMP });
    await initAuditLog(config);
    const meta = makeTestMeta({
      currentStage: "develop",
      verifyFailures: [
        { ruleType: "fileContentPattern", detail: "missing artifact", group: "deliverable", timestamp: Date.now() },
      ],
    });
    const ctx = { session: { getMeta: () => meta } };

    const hook = createPromptInjector(config);
    const result = (await hook.handler(ctx as never))!;
    expect(result.systemPrompt!).toContain("[deliverable][fileContentPattern] missing artifact");
  });
});
