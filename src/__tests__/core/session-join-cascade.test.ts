import { describe, it, expect } from "bun:test";
import { createSessionStarter } from "../../core/session-starter";
import { makeTestConfig, makeTestMeta, auditLogFileFor } from "../helpers";
import { writeFile, mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initAuditLog, setAuditPipelineContext } from "../../utils/auditLog";
import { registerSession } from "../../utils/session-registry";
import { parseRequirementDocPath } from "../../utils/doc-path";
import { __resetMemoryThrottle } from "../../utils/audit-throttle";

const MARKER_ID = "pipe-1723456789-abc123";
const OTHER_ID = "pipe-1723456790-def456";

/**
 * Minimal JOIN ctx. `parentSession` omitted → the child only has the
 * subagent session-name signal (in-memory subagent, the 204 incident shape).
 */
function createJoinCtx(meta: Record<string, unknown>, opts: {
  parentSession?: string;
  sessionName?: string;
  sessionFile?: string;
  userMessages?: string[];
}) {
  return {
    session: {
      getMeta: () => meta,
      updateMeta: (m: any) => {
        Object.assign(meta, m);
      },
    },
    ui: { notify: () => {}, setStatus: () => {} },
    _ctx: {
      sessionManager: {
        getBranch: () => (opts.userMessages ?? []).map(content => ({
          type: "message",
          message: { role: "user", content },
        })),
        getEntries: () => [],
        getHeader: opts.parentSession ? () => ({ parentSession: opts.parentSession }) : () => ({}),
        getSessionName: () => opts.sessionName ?? "clarify-agent#aabb1122",
        getSessionFile: () => opts.sessionFile ?? "",
      },
    },
  };
}

async function seedParent(root: string, pipelineId: string, overrides: Record<string, unknown> = {}) {
  await mkdir(join(root, ".pi", "audit", pipelineId), { recursive: true });
  await writeFile(
    join(root, ".pi", "audit", pipelineId, "meta.json"),
    JSON.stringify(makeTestMeta({ currentStage: "clarify", pipelineId, ...overrides })),
  );
}

/** Reads an audit log, tolerating "file never created" (dormant = zero writes). */
async function readAuditOrEmpty(rootDir: string, pipelineId: string): Promise<string> {
  try {
    return await readFile(auditLogFileFor(join(rootDir, ".pi", "audit"), pipelineId), "utf-8");
  } catch {
    return "";
  }
}

async function root(name: string) {
  const dir = join(tmpdir(), `pi-join-cascade-${name}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  await mkdir(dir, { recursive: true });
  return dir;
}

describe("204 Phase 0: JOIN identity cascade (L1 → L2 → L3)", () => {
  it("L2: no parentSession + first-message marker + readable meta → JOIN via first_message", async () => {
    setAuditPipelineContext("");
    const TMP = await root("l2");
    await seedParent(TMP, MARKER_ID);
    const config = makeTestConfig({ projectRoot: TMP });
    await initAuditLog(config);
    __resetMemoryThrottle();

    const meta: Record<string, unknown> = {};
    const ctx = createJoinCtx(meta, { userMessages: [`docs/design/204_Bug.md 1 Pipeline: ${MARKER_ID}`] });

    await createSessionStarter(config).handler(ctx as any);

    expect(meta.pipelineId).toBe(MARKER_ID);
    expect(meta.currentStage).toBe("clarify");

    const content = await readAuditOrEmpty(TMP, MARKER_ID);
    expect(content).toContain("session_join_parent");
    expect(content).toContain("via=first_message");
    expect(content).toContain("persisted=false");

    await rm(TMP, { recursive: true, force: true });
  });

  it("L1 wins over L2: both available with different ids → via=parent_session", async () => {
    setAuditPipelineContext("");
    const TMP = await root("l1-priority");
    await seedParent(TMP, MARKER_ID);
    await seedParent(TMP, OTHER_ID);
    const config = makeTestConfig({ projectRoot: TMP });
    await initAuditLog(config);
    await registerSession(config, "parent-session-file", OTHER_ID);
    __resetMemoryThrottle();

    const meta: Record<string, unknown> = {};
    const ctx = createJoinCtx(meta, {
      parentSession: "parent-session-file",
      sessionFile: "child-session-file",
      userMessages: [`Pipeline: ${MARKER_ID}`],
    });

    await createSessionStarter(config).handler(ctx as any);

    expect(meta.pipelineId).toBe(OTHER_ID);

    const content = await readAuditOrEmpty(TMP, OTHER_ID);
    expect(content).toContain("via=parent_session");
    expect(content).toContain("persisted=true");

    await rm(TMP, { recursive: true, force: true });
  });

  it("L1 sub-case: parentSession present but registry cleaned → falls back to L2", async () => {
    setAuditPipelineContext("");
    const TMP = await root("l1-clean");
    await seedParent(TMP, MARKER_ID);
    const config = makeTestConfig({ projectRoot: TMP });
    await initAuditLog(config);
    __resetMemoryThrottle();

    const meta: Record<string, unknown> = {};
    const ctx = createJoinCtx(meta, {
      parentSession: "evicted-parent-session",
      userMessages: [`Pipeline: ${MARKER_ID}`],
    });

    await createSessionStarter(config).handler(ctx as any);

    expect(meta.pipelineId).toBe(MARKER_ID);
    const content = await readAuditOrEmpty(TMP, MARKER_ID);
    expect(content).toContain("via=first_message");

    await rm(TMP, { recursive: true, force: true });
  });

  it("L2 validation fails (marker present, meta.json missing) → L3 no_evidence + dormant", async () => {
    setAuditPipelineContext("");
    const TMP = await root("l3");
    const config = makeTestConfig({ projectRoot: TMP });
    await initAuditLog(config);
    __resetMemoryThrottle();

    const meta: Record<string, unknown> = {};
    const ctx = createJoinCtx(meta, { userMessages: [`Pipeline: ${MARKER_ID}`] });

    await createSessionStarter(config).handler(ctx as any);

    expect(meta.pipelineId).toBeUndefined();
    expect(meta.currentStage).toBeUndefined();

    const content = await readAuditOrEmpty(TMP, "");
    expect(content).toContain("session_join_missing_registry");
    expect(content).toContain("reason=no_evidence");
    expect(content).toContain(`markerPipelineId=${MARKER_ID}`);

    await rm(TMP, { recursive: true, force: true });
  });

  it("L2 hit + parent flowState=aborted → JOIN succeeds and audits aborted_parent", async () => {
    setAuditPipelineContext("");
    const TMP = await root("l2-aborted");
    await seedParent(TMP, MARKER_ID, { flowState: "aborted" });
    const config = makeTestConfig({ projectRoot: TMP });
    await initAuditLog(config);
    __resetMemoryThrottle();

    const meta: Record<string, unknown> = {};
    const ctx = createJoinCtx(meta, { userMessages: [`Pipeline: ${MARKER_ID}`] });

    await createSessionStarter(config).handler(ctx as any);

    expect(meta.pipelineId).toBe(MARKER_ID);
    const content = await readAuditOrEmpty(TMP, MARKER_ID);
    expect(content).toContain("session_join_aborted_parent");

    await rm(TMP, { recursive: true, force: true });
  });

  it("owner regression: non-subagent session stays dormant and writes no session_join_*", async () => {
    setAuditPipelineContext("");
    const TMP = await root("owner");
    const config = makeTestConfig({ projectRoot: TMP });
    await initAuditLog(config);
    __resetMemoryThrottle();

    const meta: Record<string, unknown> = {};
    const ctx = createJoinCtx(meta, { sessionName: "", userMessages: [`Pipeline: ${MARKER_ID}`] });

    await createSessionStarter(config).handler(ctx as any);

    expect(meta.pipelineId).toBeUndefined();
    const content = await readAuditOrEmpty(TMP, "");
    expect(content).not.toContain("session_join_parent");
    expect(content).not.toContain("session_join_missing_registry");

    await rm(TMP, { recursive: true, force: true });
  });
});

describe("204 Phase 0: marker coexistence with requirementDoc parsing", () => {
  it("clarify prompt marker does not disturb doc-path parsing", () => {
    const prompt = `docs/design/204_Bug.md 1 Pipeline: ${MARKER_ID}`.trim();
    expect(parseRequirementDocPath(prompt, () => {})).toBe("docs/design/204_Bug.md");
  });
});
