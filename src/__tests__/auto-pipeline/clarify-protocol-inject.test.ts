/**
 * 220 Phase 4 (D3): the requirement/ledger protocol rides the clarify
 * `extraArgs` channel — appended AFTER the round args, never merged into them.
 *
 * Sealed behaviors:
 * - the round args stay first (`" full-und?"` / `" 1 答"`), the directive follows
 *   on its own paragraph;
 * - a document missing `## 需求评估` receives the "add the section" instruction
 *   (never a freeze, never a document write);
 * - a complete document appends nothing;
 * - appending is audited (`gate: "clarify_protocol"`), and the clarify phase-3
 *   gates keep working unchanged.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ClarifyProtocolConfig, SessionMeta } from "../../types";
import {
  runAutoClarifyRound,
  type ClarifyEntryCtx,
  type ClarifyEntryDeps,
} from "../../core/auto-pipeline/clarify-entry";
import { __resetAutoJobLockForTests } from "../../core/auto-pipeline/config-overlay";
import { __setSafeWriteAuditLogOverride } from "../../utils/auditLog";
import { createAutoHarness, createSessionStub, HARNESS_DOCS, type AutoHarness } from "./auto-harness";

const DOC = HARNESS_DOCS[0]!;
const SRC_ROOT = path.resolve(__dirname, "..", "..", "..");

const MANDATORY = [
  "## 目标",
  "Ship the clarify protocol.",
  "## 范围",
  "The clarify stage only.",
  "## 验收标准",
  "Every round carries the directive.",
];

/** Complete: assessment + mandatory sections + a documented ledger. */
const COMPLETE_DOC = [
  "# 200_Feat",
  ...MANDATORY,
  "## 需求评估",
  "ready",
  "",
  "## 组合决策台账",
  "| 题目 | 选定 | 淘汰 | 理由 | 冲突矩阵 |",
  "| --- | --- | --- | --- | --- |",
  "| 缓存方案 | 方案 A | 方案 B | 淘汰理由：B 更慢 | 是 |",
  "",
  "# 第 1 轮澄清",
  "- **方案 A** self-answer",
  "答：方案 A",
].join("\n");

/** Missing `## 需求评估` and the mandatory sections. */
const INCOMPLETE_DOC = ["# 200_Feat", "TBD", "", "# 第 1 轮澄清", "- **方案 A** self-answer", "答：方案 A"].join("\n");

/** English-only project protocol (what an English project installs). */
const ENGLISH_PROTOCOL: ClarifyProtocolConfig = {
  assessmentHeading: ["## Requirement Assessment"],
  goalHeading: ["## Goal"],
  scopeHeading: ["## Scope"],
  acceptanceHeading: ["## Acceptance Criteria"],
  ledgerHeading: ["## Decision Ledger"],
  eliminationMarkers: ["elimination reason"],
  conflictMarkers: ["conflict matrix"],
  questionPatterns: ["^##\\s*Question\\s+(\\d+)"],
  verdictReady: ["ready"],
  verdictNeedsClarify: ["needs-clarify"],
};

const ENGLISH_INCOMPLETE_DOC = [
  "# 221 Feat",
  "TBD — unclear for now",
  "",
  "# Round 1",
  "- **Option A** self-answer",
  "Answer: Option A",
].join("\n");

type SpawnArgs = Parameters<ClarifyEntryDeps["spawn"]>;
type SpawnResult = Awaited<ReturnType<ClarifyEntryDeps["spawn"]>>;

let harness: AutoHarness;
let audits: string[];
let spawnCalls: SpawnArgs[];
let deps: ClarifyEntryDeps;

function deployClarifySpec(): void {
  const target = path.join(harness.projectRoot, ".pi", "references", "clarify_spec", "verify.md");
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(path.join(SRC_ROOT, "src", "template", "references", "clarify_spec", "verify.md"), target);
}

function writeDoc(text: string): void {
  const abs = path.join(harness.projectRoot, DOC);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, text, "utf8");
}

function makeMeta(): SessionMeta {
  return {
    pipelineId: "pipe-220-p4",
    currentStage: "clarify",
    flowState: "running",
    requirementDoc: DOC,
  } as SessionMeta;
}

function makeCtx(meta: SessionMeta): ClarifyEntryCtx {
  const stub = createSessionStub(meta);
  return { session: stub.session, ui: stub.ui, pi: {} };
}

function dispatchedArgs(): string {
  return (spawnCalls[0]![4] as { extraArgs?: string }).extraArgs ?? "";
}

beforeEach(async () => {
  harness = createAutoHarness();
  deployClarifySpec();
  await harness.install();
  audits = [];
  spawnCalls = [];
  deps = {
    spawn: (async (...args: SpawnArgs): Promise<SpawnResult> => {
      spawnCalls.push(args);
      return { spawned: true, fallback: false };
    }) as ClarifyEntryDeps["spawn"],
    freeze: (async (): Promise<void> => {
      throw new Error("freeze must not be reached in this suite");
    }) as ClarifyEntryDeps["freeze"],
  };
  __setSafeWriteAuditLogOverride(async (stage, message) => {
    audits.push(`${stage} ${JSON.stringify(message ?? {})}`);
  });
});

afterEach(() => {
  __setSafeWriteAuditLogOverride(null);
  __resetAutoJobLockForTests();
  harness.dispose();
});

describe("clarify protocol injection", () => {
  it("appends the directive AFTER the round args", async () => {
    writeDoc(INCOMPLETE_DOC);
    const meta = makeMeta();

    expect(await runAutoClarifyRound(makeCtx(meta), harness.config, meta, deps)).toBe(true);

    const args = dispatchedArgs();
    expect(args.startsWith(" full-und?")).toBe(true);
    const argsIndex = args.indexOf(" full-und?");
    const directiveIndex = args.indexOf("[auto-pipeline] Complete the requirement protocol");
    expect(directiveIndex).toBeGreaterThan(argsIndex);
    expect(args).toContain("Add a `## 需求评估` section");
  });

  it("appends nothing when the protocol is already complete", async () => {
    writeDoc(COMPLETE_DOC);
    const meta = makeMeta();

    expect(await runAutoClarifyRound(makeCtx(meta), harness.config, meta, deps)).toBe(true);

    const args = dispatchedArgs();
    expect(args).toBe(" full-und?");
    expect(audits.some((line) => line.includes("clarify_protocol"))).toBe(false);
  });

  it("audits the injection gate when a directive is appended", async () => {
    writeDoc(INCOMPLETE_DOC);
    const meta = makeMeta();

    await runAutoClarifyRound(makeCtx(meta), harness.config, meta, deps);

    expect(audits.some((line) => line.includes("clarify_protocol"))).toBe(true);
  });

  it("never writes the requirement document", async () => {
    writeDoc(INCOMPLETE_DOC);
    const before = fs.readFileSync(path.join(harness.projectRoot, DOC), "utf8");
    const meta = makeMeta();

    await runAutoClarifyRound(makeCtx(meta), harness.config, meta, deps);

    expect(fs.readFileSync(path.join(harness.projectRoot, DOC), "utf8")).toBe(before);
  });
});

describe("clarify protocol injection — English anchors (221 Phase 1)", () => {
  it("uses the configured English primary aliases in the directive", async () => {
    harness.config.clarifyProtocol = ENGLISH_PROTOCOL;
    writeDoc(ENGLISH_INCOMPLETE_DOC);
    const meta = makeMeta();

    expect(await runAutoClarifyRound(makeCtx(meta), harness.config, meta, deps)).toBe(true);

    const args = dispatchedArgs();
    expect(args).toContain("Add a `## Requirement Assessment` section");
    expect(args).toContain("## Goal");
    expect(args).toContain("## Scope");
    expect(args).toContain("## Acceptance Criteria");
    expect(args).not.toContain("## 需求评估");
  });

  it("appends nothing for a complete English document", async () => {
    harness.config.clarifyProtocol = ENGLISH_PROTOCOL;
    writeDoc(
      [
        "# 221 Feat",
        "## Goal",
        "Ship it.",
        "## Scope",
        "Clarify only.",
        "## Acceptance Criteria",
        "One round.",
        "## Requirement Assessment",
        "ready",
        "",
        "# Round 1",
        "- **Option A**",
        "Answer: Option A",
      ].join("\n"),
    );
    const meta = makeMeta();

    expect(await runAutoClarifyRound(makeCtx(meta), harness.config, meta, deps)).toBe(true);

    expect(dispatchedArgs()).toBe(" full-und?");
    expect(audits.some((line) => line.includes("clarify_protocol"))).toBe(false);
  });
});
