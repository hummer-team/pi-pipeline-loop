/**
 * 225 Phase 2 (T5): spawnStageSubagent description/prompt 同源 contract.
 *
 * Acceptance anchors:
 * - review description carries the stage prefix + commit doc path
 *   (`review: docs/design/<reqBase>_Develop_Commit.md`), and the prompt
 *   carries BOTH the `Target document` line and the `Expected report` line;
 * - second-round fix description AND prompt `Target document` are the
 *   `_N.md` derived from `meta.reviewRound` (caller passes nothing);
 * - `opts.description` keeps word-level priority (design-review verbatim);
 * - review dispatch writes `reviewDispatchedAt`; fix does not;
 * - clarify keeps `${stage}: ${requirementDoc}` verbatim, no Target line.
 *
 * Uses the SAME mock event-bus harness shape as subagent-rpc.test.ts
 * (subagents:rpc:spawn replies with a real id).
 */

import { describe, it, expect, afterEach } from "bun:test";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnStageSubagent } from "../../utils/subagent-rpc";
import { __setSafeWriteAuditLogOverride } from "../../utils/auditLog";
import { makeTestConfig, makeTestMeta, createMockEventBus } from "../helpers";
import { markSubagentsReady, __resetSubagentsReady } from "../../utils/subagent-availability";
import type { PipelineConfig, SessionMeta } from "../../types";

// Enable the RPC availability latch (same fixture contract as subagent-rpc.test.ts).
markSubagentsReady();

const audits: { event: string; fields: Record<string, string | boolean> }[] = [];

afterEach(() => {
  __setSafeWriteAuditLogOverride(null);
  __resetSubagentsReady();
  markSubagentsReady();
  audits.length = 0;
});

function installAuditCapture(): void {
  audits.length = 0;
  __setSafeWriteAuditLogOverride((stage: string, payload?: Record<string, string | boolean>) => {
    audits.push({ event: stage, fields: (payload ?? {}) as Record<string, string | boolean> });
    return Promise.resolve();
  });
}

function busWithSpawnReply(): ReturnType<typeof createMockEventBus> {
  const bus = createMockEventBus();
  const origEmit = bus.emit.bind(bus);
  bus.emit = (event: string, payload: Record<string, unknown>) => {
    origEmit(event, payload);
    if (event === "subagents:rpc:ping") {
      const replyChannel = `subagents:rpc:ping:reply:${payload.requestId}`;
      setTimeout(() => bus.trigger(replyChannel, { success: true }), 5);
    } else if (event === "subagents:rpc:spawn") {
      const replyChannel = `subagents:rpc:spawn:reply:${payload.requestId}`;
      setTimeout(() => bus.trigger(replyChannel, { success: true, data: { id: "subagent-agent-9" } }), 5);
    }
    return true;
  };
  return bus;
}

function configFor(tmpDir: string, stage: "develop" | "review" | "fix"): PipelineConfig {
  const agentFile = join(tmpDir, "agents", `${stage}-agent.md`);
  fs.mkdirSync(join(tmpDir, "agents"), { recursive: true });
  fs.writeFileSync(agentFile, `---\nname: ${stage}-agent\n---\n# ${stage}\n`);
  const base = makeTestConfig();
  return makeTestConfig({
    projectRoot: tmpDir,
    stages: {
      ...base.stages,
      [stage]: {
        agentPath: `agents/${stage}-agent.md`,
        skillPath: `${stage}/SKILL.md`,
        nextStage: null,
        requireDomain: false,
      },
    },
  } as unknown as PipelineConfig);
}

const ROUND2 = {
  index: 2,
  stageStartTime: 9000,
  enteredAt: 8800,
  pipelineId: "pipe-target-001",
};

function spawnWithReplies(bus: ReturnType<typeof busWithSpawnReply>): void {
  const origEmit = bus.emit.bind(bus);
  bus.emit = (event: string, payload: Record<string, unknown>) => {
    origEmit(event, payload);
    if (event === "subagents:rpc:ping") {
      const channel = `subagents:rpc:ping:reply:${payload.requestId}`;
      setTimeout(() => bus.trigger(channel, { success: true }), 5);
    } else if (event === "subagents:rpc:spawn") {
      const channel = `subagents:rpc:spawn:reply:${payload.requestId}`;
      setTimeout(() => bus.trigger(channel, { success: true, data: { id: "subagent-agent-9" } }), 5);
    }
    return true;
  };
}

function sessionFor(meta: SessionMeta) {
  return {
    getMeta: () => meta,
    updateMeta: (patch: Partial<SessionMeta>) => {
      Object.assign(meta, patch);
      return meta;
    },
  };
}

async function dispatch(
  stage: "develop" | "review" | "fix",
  configure: (meta: SessionMeta) => void,
) {
  const tmpDir = join(tmpdir(), `pi-rpc-target-${stage}-${Date.now()}`);
  fs.mkdirSync(tmpDir, { recursive: true });
  try {
    const config = configFor(tmpDir, stage);
    const meta = makeTestMeta({ currentStage: stage, pipelineId: "pipe-target-001", stageStartTime: 9000, requirementDoc: "docs/design/225_Bug.md" });
    configure(meta);
    installAuditCapture();
    const bus = busWithSpawnReply();
    spawnWithReplies(bus);
    const result = await spawnStageSubagent({ events: bus } as never, config, stage, meta, {
      session: sessionFor(meta),
    });
    const spawnEmit = bus.emitted.find((e) => e.event === "subagents:rpc:spawn");
    return { result, spawnEmit, meta, tmpDir, bus };
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

describe("spawnStageSubagent — stage target document contract", () => {
  it("review: description = review: {commit doc}; prompt has Target document + Expected report; reviewDispatchedAt written", async () => {
    const { result, spawnEmit, meta } = await dispatch("review", () => {});
    expect(result.spawned).toBe(true);
    const payload = spawnEmit!.payload as { options: { description: string }; prompt: string };
    expect(payload.options.description).toBe("review: docs/design/225_Bug_Develop_Commit.md");
    expect(payload.prompt).toContain("Target document: docs/design/225_Bug_Develop_Commit.md — read it first");
    expect(payload.prompt).toContain(
      "Expected report: docs/review/Code_Review_225_Bug_Develop_Commit_1.md (write exactly this path).",
    );
    // Review round allocated + persisted for the gate.
    expect(meta.reviewRound?.index).toBeGreaterThan(0);
    expect(meta.reviewRound?.stageStartTime).toBe(meta.stageStartTime);
    // Same-turn marker rides the spawn success patch.
    expect(meta.reviewDispatchedAt?.stageStartTime).toBe(meta.stageStartTime);
  });

  it("fix (round 2 persisted): description AND prompt Target document are the `_2.md` from meta.reviewRound", async () => {
    const { result, spawnEmit, meta } = await dispatch("fix", (m) => { m.reviewRound = { ...ROUND2 }; });
    expect(result.spawned).toBe(true);
    const payload = spawnEmit!.payload as { options: { description: string }; prompt: string };
    expect(payload.options.description).toBe("fix: docs/review/Code_Review_225_Bug_Develop_Commit_2.md");
    expect(payload.prompt).toContain(
      "Target document: docs/review/Code_Review_225_Bug_Develop_Commit_2.md — read it first",
    );
    // The OTHER half of the acceptance: prompt and description agree.
    expect(payload.prompt).not.toContain("Expected report:");
  });

  it("fix without opts.description still uses meta.reviewRound (caller passes nothing)", async () => {
    const { spawnEmit } = await dispatch("fix", (m) => { m.reviewRound = { ...ROUND2 }; });
    const payload = spawnEmit!.payload as { options: { description: string } };
    expect(payload.options.description).toContain("Code_Review_225_Bug_Develop_Commit_2.md");
  });

  it("fix dispatch never writes reviewDispatchedAt", async () => {
    const { meta } = await dispatch("fix", (m) => { m.reviewRound = { ...ROUND2 }; });
    expect(meta.reviewDispatchedAt).toBeUndefined();
  });

  it("develop dispatch: description uses the plan-doc target and prompt carries the same Target document", async () => {
    const { result, spawnEmit } = await dispatch("develop", () => {});
    expect(result.spawned).toBe(true);
    const payload = spawnEmit!.payload as { options: { description: string }; prompt: string };
    expect(payload.options.description).toBe("develop: docs/design/225_Bug_Plan.md");
    expect(payload.prompt).toContain("Target document: docs/design/225_Bug_Plan.md — read it first");
    expect(payload.prompt).not.toContain("Expected report:");
  });

  it("opts.description keeps priority over the derived description", async () => {
    const tmpDir = join(tmpdir(), "pi-rpc-target-desc-" + Date.now());
    fs.mkdirSync(tmpDir, { recursive: true });
    try {
      const config = configFor(tmpDir, "fix");
      const meta = makeTestMeta({ currentStage: "fix", stageStartTime: 9000, requirementDoc: "docs/design/225_Bug.md", reviewRound: { ...ROUND2 } });
      installAuditCapture();
      const bus = busWithSpawnReply();
      spawnWithReplies(bus);
      await spawnStageSubagent({ events: bus } as never, config, "fix", meta, {
        session: sessionFor(meta),
        description: "explicit caller text",
      });
      const spawnEmit = bus.emitted.find((e) => e.event === "subagents:rpc:spawn")!;
      const payload = spawnEmit.payload as { options: { description: string }; prompt: string };
      expect(payload.options.description).toBe("explicit caller text");
      // The Prompt target stays同源 even when the description is overridden.
      expect(payload.prompt).toContain("Target document: docs/review/Code_Review_225_Bug_Develop_Commit_2.md");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
