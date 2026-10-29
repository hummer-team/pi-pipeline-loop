/**
 * @module prompt-injector-queued-spawn
 * 218 Phase 1 (T1.5): the prompt-injector must surface a "⏳ Spawn queued"
 * note whenever the plugin owns a queued dispatch for the current stage, and
 * must NEVER show it alongside the "⚠ Active spawn" note (mutual exclusion —
 * an already-live executor wins because the queued entry is about to become it).
 *
 * Both rendering paths are covered, as mandated by the plan's case table:
 * - yml path: real `pipeline-stage-prompt.yml` deployed to `.pi/references/`
 *   (the `{queued_spawn_note}` placeholder in `stage_executor_*`).
 * - fallback path: no yml file → hardcoded `buildStageExecutor` text with the
 *   executorNote append.
 *
 * Each test asserts real injected-prompt behavior; removing the T1.5 logic
 * (queuedNote computation or the mutual-exclusion slot) must turn this red.
 */

import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { createPromptInjector } from "../../core/prompt-injector";
import { makeTestConfig, makeTestMeta } from "../helpers";
import { initAuditLog, __resetAuditDirPath } from "../../utils/auditLog";
import { __resetMemoryThrottle } from "../../utils/audit-throttle";
import { resetPromptConfigCache } from "../../core/prompt-config";
import type { PipelineConfig, SessionMeta } from "../../types";

const MANAGER_SYMBOL = Symbol.for("pi-subagents:manager");

/** Exact phrases from the T1.5 note — distinctive enough to avoid collisions
 *  with the scheduling sentence ("...while a plugin spawn is queued or active"). */
const QUEUED_MARKER = "⏳ Spawn queued";
const QUEUED_SENTENCE = "the plugin has already queued this stage's executor";
const ACTIVE_MARKER = "Active spawn";

/**
 * Invoke the real before_agent_start handler with the minimal ctx the
 * injector needs (mirrors review2-low-fallback-and-consistency harness).
 */
async function invokeInjector(
  config: PipelineConfig,
  meta: SessionMeta,
): Promise<string> {
  const hook = createPromptInjector(config);
  const ctx = { session: { getMeta: () => meta } };
  const result = (await hook.handler(ctx as any)) as
    | { systemPrompt?: string }
    | undefined;
  expect(result?.systemPrompt).toBeDefined();
  return result!.systemPrompt!;
}

/** Queued dispatch entry for the develop stage (plugin-owned queue ownership). */
function queuedMeta(overrides?: Partial<SessionMeta>): SessionMeta {
  return makeTestMeta({
    currentStage: "develop",
    pendingSpawns: {
      develop: {
        agentName: "develop-agent",
        requestedAt: Date.now(),
        attempts: 0,
      },
    },
    ...overrides,
  });
}

/**
 * Live active spawn for develop: no manager singleton (probe=unknown) +
 * startedAt well inside ACTIVE_SPAWN_TTL_MS → time-window degradation marks
 * it live (same rule review2 asserts).
 */
function withLiveActiveSpawn(meta: SessionMeta): SessionMeta {
  meta.activeSpawns = {
    develop: {
      agentName: "develop-agent",
      agentId: "subagent-queued-spawn-live",
      startedAt: Date.now() - 1000,
    },
  };
  return meta;
}

describe("T1.5 yml path: {queued_spawn_note} placeholder", () => {
  let TMP: string;

  beforeEach(async () => {
    TMP = path.join(
      os.tmpdir(),
      `pi-t15-queued-yml-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    );
    await fsp.mkdir(path.join(TMP, ".pi", "references"), { recursive: true });
    // Deploy the REAL shipped template so the assertion covers the actual
    // `{queued_spawn_note}` placeholder added by T1.4.
    await fsp.copyFile(
      path.join(__dirname, "../../template/references/pipeline-stage-prompt.yml"),
      path.join(TMP, ".pi", "references", "pipeline-stage-prompt.yml"),
    );
    delete (globalThis as Record<symbol, unknown>)[MANAGER_SYMBOL];
    resetPromptConfigCache();
    await initAuditLog(makeTestConfig({ projectRoot: TMP }));
    __resetMemoryThrottle();
  });

  afterEach(async () => {
    delete (globalThis as Record<symbol, unknown>)[MANAGER_SYMBOL];
    await fsp.rm(TMP, { recursive: true, force: true });
    __resetAuditDirPath();
    resetPromptConfigCache();
  });

  it("pendingSpawns[develop] → queued note injected via yml template", async () => {
    const config = makeTestConfig({ projectRoot: TMP });
    const prompt = await invokeInjector(config, queuedMeta());

    expect(prompt).toContain(QUEUED_MARKER);
    expect(prompt).toContain(QUEUED_SENTENCE);
    // No active spawn in this scenario → the active note must be absent.
    expect(prompt).not.toContain(ACTIVE_MARKER);
    // T1.4 wording shipped in the same placeholder region.
    expect(prompt).toContain("The plugin owns dispatch");
  });

  it("activeSpawns live + pendingSpawns → only Active spawn, queued suppressed", async () => {
    const config = makeTestConfig({ projectRoot: TMP });
    const meta = withLiveActiveSpawn(queuedMeta());
    const prompt = await invokeInjector(config, meta);

    // Active executor wins (mutual exclusion contract).
    expect(prompt).toContain(ACTIVE_MARKER);
    // The queued slot must render empty — never both notes in one prompt.
    expect(prompt).not.toContain(QUEUED_MARKER);
    expect(prompt).not.toContain(QUEUED_SENTENCE);
  });
});

describe("T1.5 fallback path: hardcoded executor text", () => {
  let TMP: string;

  beforeEach(async () => {
    TMP = path.join(
      os.tmpdir(),
      `pi-t15-queued-fb-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    );
    await fsp.mkdir(path.join(TMP, ".pi"), { recursive: true });
    // NO pipeline-stage-prompt.yml → loadPromptConfig empty → hardcoded fallback.
    delete (globalThis as Record<symbol, unknown>)[MANAGER_SYMBOL];
    resetPromptConfigCache();
    await initAuditLog(makeTestConfig({ projectRoot: TMP }));
    __resetMemoryThrottle();
  });

  afterEach(async () => {
    delete (globalThis as Record<symbol, unknown>)[MANAGER_SYMBOL];
    await fsp.rm(TMP, { recursive: true, force: true });
    __resetAuditDirPath();
    resetPromptConfigCache();
  });

  it("pendingSpawns[develop] → queued note appended on fallback path", async () => {
    const config = makeTestConfig({ projectRoot: TMP });
    const prompt = await invokeInjector(config, queuedMeta());

    expect(prompt).toContain(QUEUED_MARKER);
    expect(prompt).toContain(QUEUED_SENTENCE);
    expect(prompt).not.toContain(ACTIVE_MARKER);
    // T1.4: the fallback scheduling line is synced with the yml wording.
    expect(prompt).toContain("The plugin owns dispatch");
    expect(prompt).toContain("pending_spawn_stalled");
  });

  it("activeSpawns live + pendingSpawns → executorNote keeps Active, drops queued", async () => {
    const config = makeTestConfig({ projectRoot: TMP });
    const meta = withLiveActiveSpawn(queuedMeta());
    const prompt = await invokeInjector(config, meta);

    // executorNote = activeSpawnNote || queuedSpawnNote → active wins on the
    // fallback append slot too.
    expect(prompt).toContain(ACTIVE_MARKER);
    expect(prompt).not.toContain(QUEUED_MARKER);
    expect(prompt).not.toContain(QUEUED_SENTENCE);
  });
});
