/**
 * @module whitelist-miss-mode
 * 218 Phase 2 (T2.1/T2.2, F.2/D4): the three-state `protect.whitelistMiss`
 * contract — loader validation and the four-tier resolution order.
 *
 * Resolution precedence (D4, highest first):
 *   1. stages[stage].protect.whitelistMiss (per-stage block, single value)
 *   2. config.protect.whitelistMiss.stages[stage] (global override table)
 *   3. config.protect.whitelistMiss.mode (or the string shorthand itself)
 *   4. "ask" (F.2 default)
 *
 * Invalid values warn and are ignored (existing loader style), never throw.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { loadJsonConfig, resolvePipelineConfig } from "../../core/json-config-loader";
import { resolveWhitelistMissMode } from "../../core/write-scope/mode";
import { makeTestConfig } from "../helpers";
import type { PipelineConfig, PipelineStage, WhitelistMissMode } from "../../types";

let TMP: string;
let jsonPath: string;

beforeEach(async () => {
  TMP = path.join(tmpdir(), "pi-wlmiss-mode-" + Date.now() + "-" + Math.random().toString(36).slice(2, 6));
  await fs.mkdir(TMP, { recursive: true });
  jsonPath = path.join(TMP, "pipeline_loop.json");
});

afterEach(async () => {
  await fs.rm(TMP, { recursive: true, force: true });
});

async function writeJson(obj: unknown) {
  await fs.writeFile(jsonPath, JSON.stringify(obj, null, 2), "utf-8");
}

/** Build a config with a global whitelistMiss value and an optional stage-block override. */
function cfgWith(
  globalValue?: unknown,
  stageOverrides?: Partial<Record<PipelineStage, WhitelistMissMode>>,
): PipelineConfig {
  const base = makeTestConfig();
  const stages = { ...base.stages };
  for (const [stage, mode] of Object.entries(stageOverrides ?? {})) {
    const s = stage as PipelineStage;
    stages[s] = { ...stages[s], protect: { ...(stages[s].protect ?? {}), whitelistMiss: mode } };
  }
  return {
    ...base,
    stages,
    protect: { ...(base.protect ?? {}), whitelistMiss: globalValue as never },
  } as PipelineConfig;
}

describe("resolveWhitelistMissMode — four-tier precedence (D4)", () => {
  it("tier 4: nothing configured → default \"ask\"", () => {
    const config = cfgWith(undefined);
    expect(resolveWhitelistMissMode(config, "develop")).toBe("ask");
  });

  it("tier 3: string shorthand applies globally", () => {
    expect(resolveWhitelistMissMode(cfgWith("deny"), "develop")).toBe("deny");
    expect(resolveWhitelistMissMode(cfgWith("allow"), "review")).toBe("allow");
  });

  it("tier 3: object form mode applies globally", () => {
    expect(resolveWhitelistMissMode(cfgWith({ mode: "deny" }), "fix")).toBe("deny");
  });

  it("tier 2: global stages table beats the global mode", () => {
    const config = cfgWith({ mode: "allow", stages: { fix: "deny" } });
    expect(resolveWhitelistMissMode(config, "fix")).toBe("deny");
    // Untouched stages keep the global mode.
    expect(resolveWhitelistMissMode(config, "review")).toBe("allow");
  });

  it("tier 1: stage block beats the global stages table AND the global mode", () => {
    const config = cfgWith(
      { mode: "deny", stages: { develop: "allow" } },
      { develop: "ask" },
    );
    expect(resolveWhitelistMissMode(config, "develop")).toBe("ask");
    // The global table still serves the stages without a block.
    expect(resolveWhitelistMissMode(config, "fix")).toBe("deny");
  });

  it("unrecognized runtime shape degrades to \"ask\", never \"deny\"", () => {
    // Loader normally drops this; the resolver must still fail toward "ask".
    expect(resolveWhitelistMissMode(cfgWith("nonsense"), "develop")).toBe("ask");
    expect(resolveWhitelistMissMode(cfgWith(42), "develop")).toBe("ask");
    expect(resolveWhitelistMissMode(cfgWith({ mode: "bogus" }), "develop")).toBe("ask");
  });
});

describe("loadJsonConfig — whitelistMiss validation (warn + ignore)", () => {
  it("accepts the string shorthand and the object form", async () => {
    await writeJson({ stages: { clarify: {} }, protect: { whitelistMiss: "deny" } });
    expect(loadJsonConfig(jsonPath).protect!.whitelistMiss).toBe("deny");

    await writeJson({
      stages: { clarify: {} },
      protect: { whitelistMiss: { mode: "allow", stages: { review: "deny" } } },
    });
    expect(loadJsonConfig(jsonPath).protect!.whitelistMiss).toEqual({
      mode: "allow",
      stages: { review: "deny" },
    });
  });

  it("ignores an invalid shorthand value entirely", async () => {
    await writeJson({ stages: { clarify: {} }, protect: { whitelistMiss: "maybe" } });
    expect(loadJsonConfig(jsonPath).protect!.whitelistMiss).toBeUndefined();
  });

  it("keeps valid parts of a partially-invalid object", async () => {
    await writeJson({
      stages: { clarify: {} },
      protect: { whitelistMiss: { mode: "deny", stages: { review: "bogus", notastage: "ask" } } },
    });
    // mode survives; invalid stage values/keys are dropped; empty stages gone.
    expect(loadJsonConfig(jsonPath).protect!.whitelistMiss).toEqual({ mode: "deny" });
  });

  it("drops a whitelistMiss:false / array shape with a warning, not a throw", async () => {
    await writeJson({ stages: { clarify: {} }, protect: { whitelistMiss: false } });
    expect(loadJsonConfig(jsonPath).protect!.whitelistMiss).toBeUndefined();
    await writeJson({ stages: { clarify: {} }, protect: { whitelistMiss: ["deny"] } });
    expect(loadJsonConfig(jsonPath).protect!.whitelistMiss).toBeUndefined();
  });

  it("parses the stage-level single-value whitelistMiss", async () => {
    await writeJson({
      stages: { develop: { protect: { whitelistMiss: "allow" } } },
    });
    const result = loadJsonConfig(jsonPath);
    // loadJsonConfig keeps the raw stage shape; the typed drop happens in
    // resolvePipelineConfig (parseStageProtectConfig).
    expect(result.stages.develop!.protect!.whitelistMiss).toBe("allow");
    const resolved = resolvePipelineConfig(result);
    expect(resolved.stages.develop.protect!.whitelistMiss).toBe("allow");
  });

  it("ignores an object form at stage level (single value only)", async () => {
    await writeJson({
      stages: { develop: { protect: { whitelistMiss: { mode: "deny" } } } },
    });
    const resolved = resolvePipelineConfig(loadJsonConfig(jsonPath));
    expect(resolved.stages.develop.protect!.whitelistMiss).toBeUndefined();
  });
});

describe("resolvePipelineConfig — whitelistMiss passthrough", () => {
  it("forwards the parsed global whitelistMiss into the resolved config", () => {
    const json = {
      stages: { develop: { protect: { whitelistMiss: "deny" as const } } },
      protect: { whitelistMiss: { mode: "allow" as const, stages: { fix: "deny" as const } } },
    };
    const resolved = resolvePipelineConfig(json);
    expect(resolved.protect!.whitelistMiss).toEqual({ mode: "allow", stages: { fix: "deny" } });
    expect(resolved.stages.develop.protect!.whitelistMiss).toBe("deny");
    // And the resolver chain produces the expected effective modes.
    expect(resolveWhitelistMissMode(resolved, "develop")).toBe("deny"); // tier 1
    expect(resolveWhitelistMissMode(resolved, "fix")).toBe("deny"); // tier 2
    expect(resolveWhitelistMissMode(resolved, "review")).toBe("allow"); // tier 3
    expect(resolveWhitelistMissMode(resolved, "clarify")).toBe("allow"); // tier 3
  });

  it("leaves whitelistMiss undefined when unconfigured (resolution defaults to ask)", () => {
    const resolved = resolvePipelineConfig({ stages: { clarify: {} } });
    expect(resolved.protect!.whitelistMiss).toBeUndefined();
    expect(resolveWhitelistMissMode(resolved, "clarify")).toBe("ask");
  });
});
