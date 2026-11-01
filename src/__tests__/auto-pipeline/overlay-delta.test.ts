/**
 * 220 Phase 2 (D7) — `config-overlay` delta over 219.
 *
 * The three NEW mapping-table rows must behave exactly like the 219 rows, and
 * the "inherit-not-overlay" rule must hold for the two keys whose schema
 * default would otherwise overwrite a project value the job never mentioned:
 *
 * | job key                  | → json key                  | overlay when       |
 * |--------------------------|-----------------------------|--------------------|
 * | `verify.maxAttempts`     | `maxVerifyAttempts`         | configured only    |
 * | `writePolicy.gitModify`  | `protect.gitModify`         | configured only    |
 * | `audit.autoDecisions`    | `audit.autoDecisions`       | always (same name) |
 *
 * `freezePolicy` stays JOB-PRIVATE: it must never appear as a config entry
 * (its `byReason` values are `FreezeAction` strings, structurally incompatible
 * with the 210 provider chain's `DecisionPolicyRule` objects).
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
} from "../../core/auto-pipeline/config-overlay";
import { parseAutoJob, hashJobBytes, type AutoJobConfig } from "../../core/auto-pipeline/job-schema";
import { resolvePipelineConfig } from "../../core/json-config-loader";

const SRC_ROOT = path.resolve(__dirname, "..", "..", "..");
const TEMPLATE_JSON: PipelineJsonConfig = JSON.parse(
  fs.readFileSync(path.join(SRC_ROOT, "src", "template", "pipeline_loop.json"), "utf8"),
) as PipelineJsonConfig;

const BASE_DOCS = ["version: 1", "enabled: true", "docs:", "  list:", "    - doc: docs/design/200_Feat.md"];

function yamlWith(block: readonly string[]): string {
  return [...BASE_DOCS, ...block].join("\n");
}

function parseJob(block: readonly string[] = []): AutoJobConfig {
  const yaml = yamlWith(block);
  const parsed = parseAutoJob(yaml, "docs/jobs/delta.yaml");
  if (!parsed.ok) throw new Error(`fixture job invalid: ${parsed.errors.join("; ")}`);
  return parsed.job;
}

let ROOT: string;

function baseJson(): PipelineJsonConfig {
  const clone = structuredClone(TEMPLATE_JSON);
  clone.projectRoot = ROOT;
  return clone;
}

beforeEach(() => {
  ROOT = fs.mkdtempSync(path.join(tmpdir(), "pi-220-overlay-delta-"));
});

afterEach(() => {
  fs.rmSync(ROOT, { recursive: true, force: true });
});

describe("overlay delta — the three 220 mapping rows", () => {
  it("verify.maxAttempts → maxVerifyAttempts when the job configured it", () => {
    const base = baseJson();
    const jsonBefore = structuredClone(base);
    const { json, entries } = overlayJobOnJson(base, parseJob(["verify:", "  maxAttempts: 7"]));
    expect(json.maxVerifyAttempts).toBe(7);
    expect(entries.map((e) => e.configPath)).toContain("maxVerifyAttempts");
    // Pure: the input document is never mutated.
    expect(base).toEqual(jsonBefore);
  });

  it("writePolicy.gitModify → protect.gitModify when the job configured it", () => {
    const base = baseJson();
    base.protect = { ...base.protect, gitModify: "block" };
    const { json, entries } = overlayJobOnJson(base, parseJob(["writePolicy:", "  gitModify: allow"]));
    expect(json.protect?.gitModify).toBe("allow");
    expect(entries.map((e) => e.configPath)).toContain("protect.gitModify");
    // The field-level merge keeps the sibling protect keys intact.
    expect(json.protect?.ask).toBe(base.protect.ask);
  });

  it("audit.autoDecisions → audit.autoDecisions (same-named json key, R1)", () => {
    const base = baseJson();
    const { json, entries } = overlayJobOnJson(base, parseJob(["audit:", "  autoDecisions: false"]));
    expect(json.audit?.autoDecisions).toBe(false);
    expect(entries.map((e) => e.configPath)).toContain("audit.autoDecisions");
  });

  it("all three rows land on the LIVE config through applyOverlay", () => {
    const json = baseJson();
    const live = resolvePipelineConfig(json);
    const job = parseJob(["verify:", "  maxAttempts: 4", "writePolicy:", "  gitModify: allow", "audit:", "  autoDecisions: false"]);
    const snapshot = applyOverlay(live, json, { ...job, jobHash: hashJobBytes(yamlWith([])) });
    expect(live.maxVerifyAttempts).toBe(4);
    expect(live.protect?.gitModify).toBe("allow");
    expect(live.audit?.autoDecisions).toBe(false);

    restoreOverlay(live, snapshot);
    expect(live.maxVerifyAttempts).toBe(json.maxVerifyAttempts);
    expect(live.protect?.gitModify).toBe(json.protect?.gitModify);
    expect(live.audit?.autoDecisions).toBe(json.audit?.autoDecisions);
  });
});

describe("overlay delta — inherit-not-overlay (unconfigured keys never write)", () => {
  it("an unconfigured `verify.maxAttempts` leaves the json value alone", () => {
    const base = baseJson();
    base.maxVerifyAttempts = 9;
    const { json, entries } = overlayJobOnJson(base, parseJob());
    expect(json.maxVerifyAttempts).toBe(9);
    expect(entries.some((e) => e.configPath === "maxVerifyAttempts")).toBe(false);
    // The schema default is still available for downstream consumers.
    expect(parseJob().verify.maxAttempts).toBe(3);
  });

  it("an unconfigured `writePolicy.gitModify` leaves the json value alone", () => {
    const base = baseJson();
    base.protect = { ...base.protect, gitModify: "allow" };
    const { json, entries } = overlayJobOnJson(base, parseJob());
    expect(json.protect?.gitModify).toBe("allow");
    expect(entries.some((e) => e.configPath === "protect.gitModify")).toBe(false);
    expect(parseJob().writePolicy.gitModify).toBe("block");
  });

  it("applyOverlay on an unconfigured job keeps the resolved live values", () => {
    const json = baseJson();
    json.maxVerifyAttempts = 9;
    json.protect = { ...json.protect, gitModify: "allow" };
    const live = resolvePipelineConfig(json);
    applyOverlay(live, json, { ...parseJob(), jobHash: "h" });
    expect(live.maxVerifyAttempts).toBe(9);
    expect(live.protect?.gitModify).toBe("allow");
  });
});

describe("overlay delta — freezePolicy stays job-private", () => {
  it("never produces a config entry nor a json block", () => {
    const base = baseJson();
    base.decisionPolicy = { byReason: { verify_budget: { decision: "resume" } } };
    const before = structuredClone(base.decisionPolicy);
    const job = parseJob([
      "freezePolicy:",
      "  onFreeze: abort",
      "  maxAutoResumes: 5",
      "  byReason:",
      "    verify_budget: resume",
    ]);
    const { json, entries } = overlayJobOnJson(base, job);
    expect(entries.some((e) => e.configPath.startsWith("freezePolicy"))).toBe(false);
    expect((json as unknown as Record<string, unknown>).freezePolicy).toBeUndefined();
    // The 210 provider-chain block is untouched (different structure).
    expect(json.decisionPolicy).toEqual(before);
    // …and the job value is still readable by the freeze autopilot.
    expect(job.freezePolicy.onFreeze).toBe("abort");
  });

  it("a stage-level whitelistMiss override is still deleted when the job sets one", () => {
    const base = baseJson();
    base.stages.develop = {
      ...(base.stages.develop ?? {}),
      protect: { whitelistMiss: "ask" },
    } as PipelineJsonConfig["stages"]["develop"];
    const live = resolvePipelineConfig(base);
    const snapshot = applyOverlay(live, base, { ...parseJob(["writePolicy:", "  whitelistMiss: deny"]), jobHash: "h2" });
    expect(live.stages.develop?.protect?.whitelistMiss).toBeUndefined();
    restoreOverlay(live, snapshot);
    expect(live.stages.develop?.protect?.whitelistMiss).toBe("ask");
  });
});
