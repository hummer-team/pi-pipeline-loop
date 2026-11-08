/**
 * 219 Phase 2: the auto-job config overlay (`config-overlay.ts`).
 *
 * Key behaviors:
 * - `overlayJobOnJson` is pure and touches ONLY the 6.4 mapping-table keys;
 *   `protect` is merged field-by-field (never a whole-block replacement, which
 *   would wipe `ask` / `allow` / `gitModify`).
 * - `applyOverlay` writes IN PLACE (the object the 7 hooks captured keeps its
 *   identity) after the JSON-layer overlay is re-resolved, so `piWorkDir`
 *   rewrites / defaults stay exactly as a normal load produced them.
 * - B4 idempotence: applying twice with the same `jobHash` replays the recorded
 *   `to` values, never re-captures `before` and never re-stamps `appliedAt`.
 * - H2: a stage-level `protect.whitelistMiss` override is deleted (job is the
 *   final word) and restored by `restoreOverlay`.
 * - `freezePolicy` NEVER reaches the config (zero entries; deep-equal): it is
 *   job-private and consumed only by freeze-autopilot.
 * - Restore is a deep-equal rollback of the touched keys only and idempotent.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";
import type { PipelineConfig, PipelineJsonConfig } from "../../types";
import {
  applyOverlay,
  overlayJobOnJson,
  restoreOverlay,
  type AutoJobSnapshot,
} from "../../core/auto-pipeline/config-overlay";
import { parseAutoJob, hashJobBytes, type AutoJobConfig } from "../../core/auto-pipeline/job-schema";
import { resolvePipelineConfig } from "../../core/json-config-loader";
import { resolveWhitelistMissMode } from "../../core/write-scope/mode";

const SRC_ROOT = path.resolve(__dirname, "..", "..", "..");
const TEMPLATE_JSON: PipelineJsonConfig = JSON.parse(
  fs.readFileSync(path.join(SRC_ROOT, "src", "template", "pipeline_loop.json"), "utf8"),
) as PipelineJsonConfig;

const JOB_YAML = [
  "version: 1",
  "enabled: true",
  "docs:",
  "  list:",
  "    - doc: docs/design/200_Feat.md",
  "confirm:",
  "  plan: auto",
  "  review: auto",
  "reviewFix:",
  "  maxRounds: 4",
  "  maxLoopsPerStage: 2",
  "writePolicy:",
  "  whitelistMiss: deny",
  "  protectedPath: deny",
  "  destructiveCommand: deny",
  "  allowGlobs:",
  "    - docs/**",
  "freezePolicy:",
  "  onFreeze: resume",
  "  byReason:",
  "    verify_budget: stop-and-report",
  "audit:",
  "  autoDecisions: false",
].join("\n");

function parseJob(yamlText = JOB_YAML): AutoJobConfig {
  const parsed = parseAutoJob(yamlText, "docs/jobs/alpha_loop.yaml");
  if (!parsed.ok) throw new Error(`fixture job invalid: ${parsed.errors.join("; ")}`);
  return parsed.job;
}

let ROOT: string;

/** Fresh deep clone of the shipped template (the realistic base document). */
function baseJson(overrides?: Partial<PipelineJsonConfig>): PipelineJsonConfig {
  const clone = structuredClone(TEMPLATE_JSON);
  clone.projectRoot = ROOT;
  return { ...clone, ...overrides };
}

beforeEach(() => {
  ROOT = fs.mkdtempSync(path.join(tmpdir(), "pi-219-overlay-"));
});

afterEach(() => {
  fs.rmSync(ROOT, { recursive: true, force: true });
});

describe("config-overlay — overlayJobOnJson (pure)", () => {
  it("touches only the 6.4 mapping table; every other key stays byte-identical", () => {
    const base = baseJson();
    const before = structuredClone(base);
    const { json, entries } = overlayJobOnJson(base, parseJob());

    // Input is never mutated (pure).
    expect(base).toEqual(before);

    // Undeclared top-level keys are untouched.
    expect(json.maxVerifyAttempts).toBe(before.maxVerifyAttempts);
    expect(json.startStageMode).toBe(before.startStageMode);
    expect(json.stages.clarify).toEqual(before.stages.clarify);

    // Mapping-table keys applied.
    expect(json.stages.plan?.confirm?.mode).toBe("auto");
    expect(json.stages.review?.confirm?.mode).toBe("auto");
    expect(json.maxLoopCycles).toBe(4);
    expect(json.maxLoops).toBe(2);
    expect(json.protect?.whitelistMiss).toBe("deny");
    expect(json.protect?.protectedPathPolicy).toBe("deny");
    expect(json.protect?.destructiveCommand).toBe("deny");
    expect(json.protect?.whitelistAllow).toEqual(["docs/**"]);
    expect(json.audit?.autoDecisions).toBe(false);

    // Entries describe exactly the touched paths.
    const paths = entries.map((e) => e.configPath).sort();
    expect(paths).toEqual(
      [
        "audit.autoDecisions",
        "maxLoopCycles",
        "maxLoops",
        "protect.destructiveCommand",
        "protect.protectedPathPolicy",
        "protect.whitelistAllow",
        "protect.whitelistMiss",
        "stages.design-review.confirm.mode",
        "stages.plan.confirm.mode",
        "stages.review.confirm.mode",
      ].sort(),
    );
  });

  it("merges protect field-by-field — ask / allow / gitModify / paths survive", () => {
    const base = baseJson();
    base.protect = {
      ...base.protect,
      ask: true,
      allow: ["docs/keep.md"],
      gitModify: "block",
      paths: ["src/protected/**"],
    };
    const { json } = overlayJobOnJson(base, parseJob());
    expect(json.protect?.ask).toBe(true);
    expect(json.protect?.allow).toEqual(["docs/keep.md"]);
    expect(json.protect?.gitModify).toBe("block");
    expect(json.protect?.paths).toEqual(["src/protected/**"]);
    expect(json.protect?.whitelistMiss).toBe("deny");
  });

  it("freezePolicy is NEVER written into the config (zero entries, deep-equal)", () => {
    const base = baseJson();
    base.decisionPolicy = { byReason: { verify_budget: { decision: "resume" } } };
    const before = structuredClone(base.decisionPolicy);
    const { json, entries } = overlayJobOnJson(base, parseJob());
    expect(json.decisionPolicy).toEqual(before);
    expect(entries.some((e) => e.configPath.startsWith("decisionPolicy"))).toBe(false);
    expect(entries.some((e) => e.configPath.startsWith("freezePolicy"))).toBe(false);
    expect((json as unknown as Record<string, unknown>).freezePolicy).toBeUndefined();
  });

  it("H2: removes every stage-level whitelistMiss override and records the deletion", () => {
    const base = baseJson();
    base.stages.develop = {
      ...(base.stages.develop ?? {}),
      protect: { whitelistMiss: "ask" },
    } as PipelineJsonConfig["stages"]["develop"];
    base.stages.fix = {
      ...(base.stages.fix ?? {}),
      protect: { whitelistMiss: "allow" },
    } as PipelineJsonConfig["stages"]["fix"];

    const { json, entries } = overlayJobOnJson(base, parseJob());
    expect(json.stages.develop?.protect?.whitelistMiss).toBeUndefined();
    expect(json.stages.fix?.protect?.whitelistMiss).toBeUndefined();
    // Global job value is the final word.
    expect(json.protect?.whitelistMiss).toBe("deny");

    const deletions = entries.filter((e) => e.configPath.endsWith(".protect.whitelistMiss") && e.to === undefined);
    expect(deletions.map((e) => e.configPath).sort()).toEqual([
      "stages.develop.protect.whitelistMiss",
      "stages.fix.protect.whitelistMiss",
    ]);
  });

  it("never invents a stage block that is absent from the base", () => {
    const base = baseJson();
    delete (base.stages as Record<string, unknown>).review;
    const { json } = overlayJobOnJson(base, parseJob());
    expect((json.stages as Record<string, unknown>).review).toBeUndefined();
    expect(json.stages.plan?.confirm?.mode).toBe("auto");
  });

  it("does not emit entries for values already equal in the base", () => {
    const base = baseJson();
    base.stages.plan = { ...base.stages.plan!, confirm: { mode: "auto" } };
    base.maxLoops = 2;
    const { entries } = overlayJobOnJson(base, parseJob());
    expect(entries.some((e) => e.configPath === "stages.plan.confirm.mode")).toBe(false);
    expect(entries.some((e) => e.configPath === "maxLoops")).toBe(false);
    expect(entries.some((e) => e.configPath === "maxLoopCycles")).toBe(true);
  });
});

describe("config-overlay — applyOverlay (in place, decision 3 ordering)", () => {
  it("mutates the LIVE object so a load-time closure sees the auto values", () => {
    const json = baseJson();
    const live = resolvePipelineConfig(json);
    // A hook captures the reference at load time.
    const closureRead = () => live.stages.plan?.confirm?.mode;

    expect(closureRead()).toBe("manual");
    applyOverlay(live, json, { ...parseJob(), jobHash: hashJobBytes(JOB_YAML) });
    expect(closureRead()).toBe("auto");
    expect(live.maxLoops).toBe(2);
    expect(live.maxLoopCycles).toBe(4);
  });

  it("piWorkDir-derived dirs stay resolved (rewrite happens after the overlay)", () => {
    const json = baseJson({ piWorkDir: ".pix" });
    const live = resolvePipelineConfig(json);
    expect(live.auditDir).toBe(".pix/audit");
    const { entries } = overlayJobOnJson(json, parseJob());
    applyOverlay(live, json, { ...parseJob(), jobHash: hashJobBytes(JOB_YAML) });
    expect(live.auditDir).toBe(".pix/audit");
    expect(live.domainDir).toBe(".pix/domains");
    // The overlay never touches resolution outputs.
    expect(entries.some((e) => e.configPath === "auditDir")).toBe(false);
  });

  it("H2 end-to-end: stage override removed → resolveWhitelistMissMode === deny; restored afterwards", () => {
    const json = baseJson();
    json.stages.develop = {
      ...(json.stages.develop ?? {}),
      protect: { whitelistMiss: "ask" },
    } as PipelineJsonConfig["stages"]["develop"];
    const live = resolvePipelineConfig(json);
    expect(resolveWhitelistMissMode(live, "develop")).toBe("ask");

    const snapshot = applyOverlay(live, json, { ...parseJob(), jobHash: hashJobBytes(JOB_YAML) });
    expect(live.stages.develop?.protect?.whitelistMiss).toBeUndefined();
    expect(resolveWhitelistMissMode(live, "develop")).toBe("deny");

    restoreOverlay(live, snapshot);
    expect(live.stages.develop?.protect?.whitelistMiss).toBe("ask");
    expect(resolveWhitelistMissMode(live, "develop")).toBe("ask");
  });

  it("B4: same jobHash twice → before / appliedAt / entries unchanged", () => {
    const json = baseJson();
    const live = resolvePipelineConfig(json);
    const hashed = { ...parseJob(), jobHash: hashJobBytes(JOB_YAML) };

    const first = applyOverlay(live, json, hashed);
    const beforeCopy = structuredClone(first.before);
    const firstAppliedAt = first.appliedAt;

    // Simulate `session_start` replay followed by `--next`: the live config is
    // already overlaid, so a naive re-apply would capture the auto values.
    const second = applyOverlay(live, json, hashed, first);

    expect(second.appliedAt).toBe(firstAppliedAt);
    expect(second.before).toEqual(beforeCopy);
    expect(second.entries).toHaveLength(first.entries.length);
    expect(live.stages.plan?.confirm?.mode).toBe("auto");
    expect(live.maxLoops).toBe(2);
  });

  it("B4: a replay on a mutated live config still rolls back to the ORIGINAL values", () => {
    const json = baseJson();
    const live = resolvePipelineConfig(json);
    const hashed = { ...parseJob(), jobHash: hashJobBytes(JOB_YAML) };
    const first = applyOverlay(live, json, hashed);
    applyOverlay(live, json, hashed, first);
    restoreOverlay(live, first);
    expect(live.stages.plan?.confirm?.mode).toBe("manual");
    expect(live.maxLoops).toBe(3);
    expect(live.maxLoopCycles).toBe(5);
    expect(live.protect?.whitelistMiss).toBeUndefined();
    expect(live.audit?.autoDecisions).toBe(true);
  });

  it("a DIFFERENT jobHash re-captures before (no stale snapshot reuse)", () => {
    const json = baseJson();
    const live = resolvePipelineConfig(json);
    const first = applyOverlay(live, json, { ...parseJob(), jobHash: "hash-a" });
    const otherYaml = JOB_YAML.replace("maxRounds: 4", "maxRounds: 9");
    const otherJob = parseJob(otherYaml);
    const second = applyOverlay(live, json, { ...otherJob, jobHash: "hash-b" }, first);
    expect(second.jobHash).toBe("hash-b");
    expect(second.appliedAt).toBeGreaterThanOrEqual(first.appliedAt);
    // `before` was re-captured from the CURRENT live values (4, from hash-a),
    // not reused from the stale snapshot (which held the pristine 5).
    expect(second.before.maxLoopCycles).toBe(4);
    expect(live.maxLoopCycles).toBe(9);
  });

  it("falls back to the raw job values when the base JSON is too incomplete to resolve", () => {
    const live = resolvePipelineConfig(baseJson());
    const partial = { projectRoot: ROOT, protect: {}, stages: {} } as unknown as PipelineJsonConfig;
    const snapshot = applyOverlay(live, partial, { ...parseJob(), jobHash: "hash-partial" });
    expect(live.maxLoops).toBe(2);
    expect(live.maxLoopCycles).toBe(4);
    expect(snapshot.entries.length).toBeGreaterThan(0);
  });

  it("records jobId/jobPath from the hashed job (snapshot provenance)", () => {
    const json = baseJson();
    const live = resolvePipelineConfig(json);
    const snapshot = applyOverlay(live, json, {
      ...parseJob(),
      jobHash: hashJobBytes(JOB_YAML),
      jobId: "alpha_loop",
      jobPath: "docs/jobs/alpha_loop.yaml",
    });
    expect(snapshot.jobId).toBe("alpha_loop");
    expect(snapshot.jobPath).toBe("docs/jobs/alpha_loop.yaml");
  });
});

describe("config-overlay — restoreOverlay", () => {
  it("deep-equal rollback of the touched keys only", () => {
    const json = baseJson();
    const live = resolvePipelineConfig(json);
    const pristine = JSON.stringify(live);
    const snapshot = applyOverlay(live, json, { ...parseJob(), jobHash: hashJobBytes(JOB_YAML) });
    expect(JSON.stringify(live)).not.toBe(pristine);

    restoreOverlay(live, snapshot);
    expect(JSON.stringify(live)).toBe(pristine);
  });

  it("repeated restore is a no-op (idempotent, never throws)", () => {
    const json = baseJson();
    const live = resolvePipelineConfig(json);
    const snapshot = applyOverlay(live, json, { ...parseJob(), jobHash: hashJobBytes(JOB_YAML) });
    restoreOverlay(live, snapshot);
    const once = JSON.stringify(live);
    expect(() => restoreOverlay(live, snapshot)).not.toThrow();
    expect(JSON.stringify(live)).toBe(once);
  });

  it("snapshot.before contains ONLY touched paths", () => {
    const json = baseJson();
    const live = resolvePipelineConfig(json);
    const snapshot = applyOverlay(live, json, { ...parseJob(), jobHash: hashJobBytes(JOB_YAML) });
    expect(Object.keys(snapshot.before).sort()).toEqual(snapshot.entries.map((e) => e.configPath).sort());
  });

  it("an absent pre-overlay value is deleted on restore (not set to undefined)", () => {
    const json = baseJson();
    const live = resolvePipelineConfig(json);
    expect(live.protect?.whitelistMiss).toBeUndefined();
    const snapshot = applyOverlay(live, json, { ...parseJob(), jobHash: hashJobBytes(JOB_YAML) });
    expect(live.protect?.whitelistMiss).toBe("deny");
    restoreOverlay(live, snapshot);
    expect("whitelistMiss" in (live.protect ?? {})).toBe(false);
  });

  it("accepts the sidecar snapshot shape (only `before` is consumed — M5)", () => {
    const json = baseJson();
    const live = resolvePipelineConfig(json);
    const snapshot: AutoJobSnapshot = applyOverlay(live, json, {
      ...parseJob(),
      jobHash: hashJobBytes(JOB_YAML),
    });
    const sidecarShape = {
      appliedAt: snapshot.appliedAt,
      jobHash: snapshot.jobHash,
      before: snapshot.before,
      entries: snapshot.entries,
    };
    restoreOverlay(live as PipelineConfig, sidecarShape);
    expect(live.stages.plan?.confirm?.mode).toBe("manual");
  });
});

/**
 * G2 regression guard (Phase 3 §2, review 219 issue 12): the confirm gate is
 * closed ONLY by this overlay rewriting `stages.*.confirm.mode`. The two call
 * sites that pass the literal `mode: "manual"` must therefore stay BEHIND a
 * config guard — a "read the mode first, branch later" refactor would make the
 * overlay silently ineffective with no failing test.
 */
describe("G2 — 'guard before literal' source invariant", () => {
  const SRC = path.resolve(__dirname, "..", "..", "..", "src");

  function readSource(rel: string): string[] {
    return fs.readFileSync(path.join(SRC, rel), "utf8").split("\n");
  }

  /** Index of the nearest preceding line matching `guard`, or -1. */
  function precedingGuard(lines: string[], from: number, guard: RegExp): number {
    for (let i = from; i >= 0; i--) {
      if (guard.test(lines[i]!)) return i;
    }
    return -1;
  }

  it("agent-settled guards `mode: \"manual\"` with the live stage confirm mode", () => {
    const lines = readSource("core/agent-settled.ts");
    const literalIndices = lines
      .map((line, i) => ({ line, i }))
      .filter(({ line }) => /mode:\s*"manual"/.test(line))
      .map(({ i }) => i);
    expect(literalIndices.length).toBeGreaterThan(0);

    for (const index of literalIndices) {
      const guard = precedingGuard(
        lines,
        index,
        /(stageConfig\.confirm\?\.mode|confirmMode)\s*===\s*"manual"/,
      );
      expect(guard).toBeGreaterThanOrEqual(0);
      expect(guard).toBeLessThan(index);
    }
  });

  it("owner re-prompt gates the literal behind the config predicate", () => {
    const lines = readSource("core/confirm-gate-owner-reprompt.ts");
    const literalIndices = lines
      .map((line, i) => ({ line, i }))
      .filter(({ line }) => /mode:\s*"manual"/.test(line))
      .map(({ i }) => i);
    expect(literalIndices.length).toBeGreaterThan(0);

    const predicate = lines.findIndex((line) => line.includes("detectPendingConfirmGate("));
    expect(predicate).toBeGreaterThanOrEqual(0);
    for (const index of literalIndices) {
      expect(predicate).toBeLessThan(index);
    }
  });
});
