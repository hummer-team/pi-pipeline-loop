/**
 * Phase 4 / 175: Tests for spawn-cleanup shared helpers.
 *
 * Validates that clearActiveSpawnRecord and clearStageSpawnRecords
 * correctly remove stage entries from session meta without side effects.
 */
import { describe, it, expect } from "bun:test";
import { clearActiveSpawnRecord, clearStageSpawnRecords } from "../../utils/spawn-cleanup";
import { makeTestMeta } from "../helpers";
import type { SessionMeta } from "../../types";

function makeSession(meta: SessionMeta) {
  return {
    getMeta: () => meta,
    updateMeta: (patch: Partial<SessionMeta>) => {
      Object.assign(meta, patch);
      return meta;
    },
  };
}

describe("clearActiveSpawnRecord", () => {
  it("removes activeSpawns entry for the specified stage", () => {
    const meta = makeTestMeta({
      activeSpawns: {
        clarify: { agentName: "agent-a", agentId: "id-1", startedAt: Date.now() },
        plan: { agentName: "agent-b", startedAt: Date.now() },
      },
    });
    const session = makeSession(meta);

    clearActiveSpawnRecord(session, "clarify");

    expect(meta.activeSpawns?.clarify).toBeUndefined();
    expect(meta.activeSpawns?.plan).toBeDefined();
  });

  it("no-op when no activeSpawns entry exists for the stage", () => {
    const meta = makeTestMeta({
      activeSpawns: {
        clarify: { agentName: "agent-a", startedAt: Date.now() },
      },
    });
    const session = makeSession(meta);

    clearActiveSpawnRecord(session, "plan");

    // clarify still present, plan still absent
    expect(meta.activeSpawns?.clarify).toBeDefined();
    expect(meta.activeSpawns?.plan).toBeUndefined();
  });

  it("no-op when activeSpawns is undefined", () => {
    const meta = makeTestMeta({ activeSpawns: undefined });
    const session = makeSession(meta);

    // Should not throw
    clearActiveSpawnRecord(session, "clarify");
    expect(meta.activeSpawns).toBeUndefined();
  });
});

describe("clearStageSpawnRecords", () => {
  it("removes both activeSpawns and spawnedStages for the stage", () => {
    const meta = makeTestMeta({
      activeSpawns: {
        develop: { agentName: "dev-agent", agentId: "id-d", startedAt: Date.now() },
      },
      spawnedStages: { develop: Date.now() },
    });
    const session = makeSession(meta);

    clearStageSpawnRecords(session, "develop");

    expect(meta.activeSpawns?.develop).toBeUndefined();
    expect(meta.spawnedStages?.develop).toBeUndefined();
  });

  it("removes only activeSpawns when spawnedStages has no entry", () => {
    const meta = makeTestMeta({
      activeSpawns: {
        review: { agentName: "rev-agent", startedAt: Date.now() },
      },
      spawnedStages: { clarify: Date.now() },
    });
    const session = makeSession(meta);

    clearStageSpawnRecords(session, "review");

    expect(meta.activeSpawns?.review).toBeUndefined();
    expect(meta.spawnedStages?.clarify).toBeDefined(); // Other stage untouched
  });

  it("no-op when neither activeSpawns nor spawnedStages has the stage", () => {
    const meta = makeTestMeta({
      activeSpawns: { plan: { agentName: "plan-agent", startedAt: Date.now() } },
      spawnedStages: { plan: Date.now() },
    });
    const session = makeSession(meta);

    clearStageSpawnRecords(session, "develop");

    // plan entries still intact
    expect(meta.activeSpawns?.plan).toBeDefined();
    expect(meta.spawnedStages?.plan).toBeDefined();
  });
});
