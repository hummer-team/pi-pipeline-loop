/**
 * 227 Phase 0 (D-9/D-16): the overlay writes the design-review decision and the
 * branch topology.
 *
 * Pins:
 * - `confirm` is iterated as a mapping (design-review included), never a
 *   hardcoded plan/review list;
 * - `designReview.enabled: true` adds `plan → design-review`, `false` points
 *   plan at the design-review SUCCESSOR, absent never touches topology;
 * - a stage missing from the base JSON is never invented;
 * - `applyOverlay` lands the value, `restoreOverlay` rolls the topology back.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";
import type { PipelineConfig, PipelineJsonConfig } from "../../types";
import {
  applyOverlay,
  restoreOverlay,
  overlayJobOnJson,
  __resetAutoJobLockForTests,
  type HashedJob,
} from "../../core/auto-pipeline/config-overlay";
import { parseAutoJob, hashJobBytes } from "../../core/auto-pipeline/job-schema";
import { resolvePipelineConfig } from "../../core/json-config-loader";

const SRC_ROOT = path.resolve(__dirname, "..", "..", "..");
const TEMPLATE_JSON: PipelineJsonConfig = JSON.parse(
  fs.readFileSync(path.join(SRC_ROOT, "src", "template", "pipeline_loop.json"), "utf8"),
) as PipelineJsonConfig;

const MINIMAL = ["version: 1", "enabled: true", "docs:", "  list:", "    - doc: docs/a.md", ""].join("\n");

let ROOT: string;

function baseJson(): PipelineJsonConfig {
  const clone = structuredClone(TEMPLATE_JSON);
  clone.projectRoot = ROOT;
  return clone;
}

function hashedJob(extra = ""): HashedJob {
  const raw = `${MINIMAL}${extra}`;
  const parsed = parseAutoJob(raw, "docs/jobs/topology_loop.yaml");
  if (!parsed.ok) throw new Error(`fixture job invalid: ${parsed.errors.join("; ")}`);
  return { ...parsed.job, jobHash: hashJobBytes(raw), jobId: "topology", jobPath: "docs/jobs/topology_loop.yaml" };
}

function topologyEntry(entries: ReturnType<typeof overlayJobOnJson>["entries"]) {
  return entries.find((e) => e.configPath === "stages.plan.nextStage");
}

beforeEach(() => {
  ROOT = fs.mkdtempSync(path.join(tmpdir(), "pi-227-overlay-"));
  __resetAutoJobLockForTests();
});

afterEach(() => {
  fs.rmSync(ROOT, { recursive: true, force: true });
  __resetAutoJobLockForTests();
});

describe("overlay design-review topology — confirm mapping", () => {
  it("iterates the confirm mapping and writes design-review.mode", () => {
    const { json, entries } = overlayJobOnJson(baseJson(), hashedJob());
    expect(json.stages["design-review"]?.confirm?.mode).toBe("smart");
    expect(entries.some((e) => e.configPath === "stages.design-review.confirm.mode")).toBe(true);
  });

  it("an explicit design-review mode is applied", () => {
    const { json } = overlayJobOnJson(baseJson(), hashedJob("confirm:\n  design-review: manual\n"));
    expect(json.stages["design-review"]?.confirm?.mode).toBe("manual");
  });
});

describe("overlay design-review topology — enabled tri-state", () => {
  it("enabled: true adds the plan → design-review edge", () => {
    const { json, entries } = overlayJobOnJson(baseJson(), hashedJob("designReview:\n  enabled: true\n"));
    expect(json.stages.plan?.nextStage).toBe("design-review");
    const entry = topologyEntry(entries);
    expect(entry?.to).toBe("design-review");
    expect(entry?.from).toBe("develop");
  });

  it("enabled: false points plan at the design-review successor", () => {
    const base = baseJson();
    // The branch must exist first — otherwise "remove" is a no-op by design.
    base.stages.plan!.nextStage = "design-review";
    const { json, entries } = overlayJobOnJson(base, hashedJob("designReview:\n  enabled: false\n"));
    const drNext = base.stages["design-review"]?.nextStage ?? "develop";
    expect(json.stages.plan?.nextStage).toBe(drNext);
    const entry = topologyEntry(entries);
    expect(entry?.to).toBe(drNext);
    expect(entry?.from).toBe("design-review");
  });

  it("enabled: false on a pipeline without the branch is a no-op", () => {
    const { json, entries } = overlayJobOnJson(baseJson(), hashedJob("designReview:\n  enabled: false\n"));
    expect(json.stages.plan?.nextStage).toBe("develop");
    expect(topologyEntry(entries)).toBeUndefined();
  });

  it("absent → no topology entry at all", () => {
    const { entries } = overlayJobOnJson(baseJson(), hashedJob());
    expect(topologyEntry(entries)).toBeUndefined();
  });

  it("idempotent: plan already pointing at design-review produces no entry", () => {
    const base = baseJson();
    base.stages.plan!.nextStage = "design-review";
    const { entries } = overlayJobOnJson(base, hashedJob("designReview:\n  enabled: true\n"));
    expect(topologyEntry(entries)).toBeUndefined();
  });

  it("never invents a missing stage", () => {
    const base = baseJson();
    delete (base.stages as Partial<PipelineJsonConfig["stages"]>)["design-review"];
    const { json, entries } = overlayJobOnJson(
      base,
      hashedJob("designReview:\n  enabled: true\nconfirm:\n  design-review: smart\n"),
    );
    expect(json.stages["design-review"]).toBeUndefined();
    expect(entries.some((e) => e.configPath.startsWith("stages.design-review"))).toBe(false);
    expect(topologyEntry(entries)).toBeUndefined();
  });
});

describe("overlay design-review topology — apply / restore", () => {
  it("applyOverlay writes the mode and topology; restore rolls both back", () => {
    const base = baseJson();
    const live: PipelineConfig = resolvePipelineConfig(base);
    const preNextStage = live.stages.plan.nextStage;

    const snapshot = applyOverlay(live, base, hashedJob("designReview:\n  enabled: true\n"));

    expect(live.stages["design-review"].confirm?.mode).toBe("smart");
    expect(live.stages.plan.nextStage).toBe("design-review");
    expect(snapshot.entries.some((e) => e.configPath === "stages.plan.nextStage")).toBe(true);

    restoreOverlay(live, snapshot);
    expect(live.stages.plan.nextStage).toBe(preNextStage);
  });
});
