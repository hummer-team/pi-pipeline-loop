import { describe, test, expect, beforeEach, afterEach, jest } from "bun:test";
import { maybeRespawnAfterTransientFailure } from "../../core/agent-settled";
import type { PipelineConfig, SessionMeta } from "../../types";
import type { RuntimeCtx } from "../../core/runtime-ctx";
import * as autoVerifier from "../../core/auto-verifier";
import * as subagentRpc from "../../utils/subagent-rpc";
import * as auditLog from "../../utils/auditLog";
import { TRANSIENT_RETRY_MAX } from "../../constants";

describe("Phase 2: Transient-failure auto re-spawn", () => {
  let mockConfig: PipelineConfig;
  let mockMeta: SessionMeta;
  let notifyCalls: string[];
  let metaUpdateCalls: Array<Partial<SessionMeta>>;
  let mockCtx: RuntimeCtx;

  beforeEach(() => {
    notifyCalls = [];
    metaUpdateCalls = [];

    mockConfig = {
      projectRoot: "/tmp/test-project",
      stages: {
        develop: {
          verify: {
            require: true,
            mode: "hook" as const,
            requiredFiles: ["docs/design/189_req_plan.md", "docs/design/189_plan_commit.md"],
          },
          agent: "@pixis",
          skill: "fast-develop",
          nextStage: "review",
          prevStage: "plan",
        },
        fix: {
          verify: {
            require: true,
            mode: "hook" as const,
            requiredFiles: ["docs/design/189_fix_commit.md"],
          },
          agent: "@pixis",
          skill: "fast-develop",
          nextStage: "review",
          prevStage: "develop",
        },
      },
    } as unknown as PipelineConfig;

    mockMeta = {
      currentStage: "develop",
      pipelineId: "test-pipeline-123",
      flowState: "running",
      transientRetryCount: 0,
      lastTransientRespawnMsgId: undefined,
      spawnedStages: {},
      activeSpawns: {},
    } as SessionMeta;

    mockCtx = {
      session: {
        getMeta: () => mockMeta,
        updateMeta: (patch: Partial<SessionMeta>) => {
          metaUpdateCalls.push(patch);
          // Merge into mockMeta like the real implementation does
          Object.assign(mockMeta, patch);
          return mockMeta;
        },
      },
      ui: {
        notify: (msg: string) => {
          notifyCalls.push(msg);
        },
      },
      _ctx: {},
    } as unknown as RuntimeCtx;

    jest.clearAllMocks();
  });

  afterEach(() => {
    // Restore all mocks to prevent pollution of subsequent test files
    jest.restoreAllMocks();
  });

  describe("Guard conditions", () => {
    test("A. transient + develop stage + precheck missing → spawnStageSubagent invoked with extraArgs containing missing path; transientRetryCount incremented; transient_auto_respawn audit", async () => {
      jest.spyOn(autoVerifier, "precheckRequiredFiles").mockResolvedValue({
        passed: false,
        missing: ["docs/design/189_req_plan.md", "docs/design/189_plan_commit.md"],
      });

      const spawnSpy = jest.spyOn(subagentRpc, "spawnStageSubagent").mockResolvedValue({
        spawned: true,
        fallback: false,
      });

      const auditSpy = jest.spyOn(auditLog, "writeAuditLog").mockResolvedValue(undefined as never);

      const health = { messageId: "msg-123" };

      await maybeRespawnAfterTransientFailure(mockCtx, mockConfig, mockMeta, health, mockCtx.ui as unknown as ReturnType<typeof import("../../core/pipeline-ui").createPipelineUI>);

      // Verify spawnStageSubagent was called with extraArgs containing missing paths
      expect(spawnSpy).toHaveBeenCalledTimes(1);
      const spawnOpts = spawnSpy.mock.calls[0][4];
      expect(spawnOpts?.extraArgs).toContain("docs/design/189_req_plan.md");
      expect(spawnOpts?.extraArgs).toContain("docs/design/189_plan_commit.md");
      expect(spawnOpts?.extraArgs).toContain("[plugin auto-respawn]");
      expect(spawnOpts?.extraArgs).toContain("Previous run terminated unexpectedly (transient failure)");

      // Verify stage arg was "develop"
      expect(spawnSpy.mock.calls[0][2]).toBe("develop");

      // Verify transientRetryCount was incremented via updateMeta
      expect(metaUpdateCalls).toContainEqual({
        transientRetryCount: 1,
        lastTransientRespawnMsgId: "msg-123",
      });

      // Verify spawnedStages and activeSpawns were cleared for develop
      expect(metaUpdateCalls).toContainEqual({
        spawnedStages: expect.objectContaining({ develop: undefined }),
        activeSpawns: expect.objectContaining({ develop: undefined }),
      });

      // Verify audit log was written
      expect(auditSpy).toHaveBeenCalledWith("transient_auto_respawn", {
        pipelineId: "test-pipeline-123",
        stage: "develop",
        attempt: "1",
        basis: "rpc",
        missing: "docs/design/189_req_plan.md, docs/design/189_plan_commit.md",
      });
    });

    test("B. transient but precheck passed → no re-spawn (existing defer flow)", async () => {
      jest.spyOn(autoVerifier, "precheckRequiredFiles").mockResolvedValue({
        passed: true,
        missing: [],
      });

      const spawnSpy = jest.spyOn(subagentRpc, "spawnStageSubagent");
      const auditSpy = jest.spyOn(auditLog, "writeAuditLog").mockResolvedValue(undefined as never);

      const health = { messageId: "msg-456" };

      await maybeRespawnAfterTransientFailure(mockCtx, mockConfig, mockMeta, health, mockCtx.ui as unknown as ReturnType<typeof import("../../core/pipeline-ui").createPipelineUI>);

      expect(spawnSpy).not.toHaveBeenCalled();
      expect(auditSpy).not.toHaveBeenCalledWith("transient_auto_respawn", expect.anything());
      expect(metaUpdateCalls).toHaveLength(0);
    });

    test("C1. terminateReason: user_quit → no re-spawn", async () => {
      mockMeta.terminateReason = "user_quit";

      jest.spyOn(autoVerifier, "precheckRequiredFiles").mockResolvedValue({
        passed: false,
        missing: ["docs/design/189_req_plan.md"],
      });

      const spawnSpy = jest.spyOn(subagentRpc, "spawnStageSubagent");
      const auditSpy = jest.spyOn(auditLog, "writeAuditLog").mockResolvedValue(undefined as never);

      const health = { messageId: "msg-789" };

      await maybeRespawnAfterTransientFailure(mockCtx, mockConfig, mockMeta, health, mockCtx.ui as unknown as ReturnType<typeof import("../../core/pipeline-ui").createPipelineUI>);

      expect(spawnSpy).not.toHaveBeenCalled();
      expect(auditSpy).not.toHaveBeenCalledWith("transient_auto_respawn", expect.anything());
    });

    test("C2. stage review (not develop/fix) → no re-spawn", async () => {
      mockMeta.currentStage = "review";

      jest.spyOn(autoVerifier, "precheckRequiredFiles").mockResolvedValue({
        passed: false,
        missing: ["docs/design/189_review_report.md"],
      });

      const spawnSpy = jest.spyOn(subagentRpc, "spawnStageSubagent");
      const auditSpy = jest.spyOn(auditLog, "writeAuditLog").mockResolvedValue(undefined as never);

      const health = { messageId: "msg-abc" };

      await maybeRespawnAfterTransientFailure(mockCtx, mockConfig, mockMeta, health, mockCtx.ui as unknown as ReturnType<typeof import("../../core/pipeline-ui").createPipelineUI>);

      expect(spawnSpy).not.toHaveBeenCalled();
      expect(auditSpy).not.toHaveBeenCalledWith("transient_auto_respawn", expect.anything());
    });

    test("C3. same messageId twice → no re-spawn (dedup guard)", async () => {
      mockMeta.lastTransientRespawnMsgId = "msg-duplicate";

      jest.spyOn(autoVerifier, "precheckRequiredFiles").mockResolvedValue({
        passed: false,
        missing: ["docs/design/189_req_plan.md"],
      });

      const spawnSpy = jest.spyOn(subagentRpc, "spawnStageSubagent");
      const auditSpy = jest.spyOn(auditLog, "writeAuditLog").mockResolvedValue(undefined as never);

      const health = { messageId: "msg-duplicate" };

      await maybeRespawnAfterTransientFailure(mockCtx, mockConfig, mockMeta, health, mockCtx.ui as unknown as ReturnType<typeof import("../../core/pipeline-ui").createPipelineUI>);

      expect(spawnSpy).not.toHaveBeenCalled();
      expect(auditSpy).not.toHaveBeenCalledWith("transient_auto_respawn", expect.anything());
    });

    test("C4. health.messageId is undefined → no re-spawn", async () => {
      jest.spyOn(autoVerifier, "precheckRequiredFiles").mockResolvedValue({
        passed: false,
        missing: ["docs/design/189_req_plan.md"],
      });

      const spawnSpy = jest.spyOn(subagentRpc, "spawnStageSubagent");
      const auditSpy = jest.spyOn(auditLog, "writeAuditLog").mockResolvedValue(undefined as never);

      const health = { messageId: undefined };

      await maybeRespawnAfterTransientFailure(mockCtx, mockConfig, mockMeta, health, mockCtx.ui as unknown as ReturnType<typeof import("../../core/pipeline-ui").createPipelineUI>);

      expect(spawnSpy).not.toHaveBeenCalled();
      expect(auditSpy).not.toHaveBeenCalledWith("transient_auto_respawn", expect.anything());
    });
  });

  describe("Retry budget logic", () => {
    test("D1. transientRetryCount = TRANSIENT_RETRY_MAX (at limit) → no spawn, frozen with transient_retry_overflow, flowState blocked", async () => {
      mockMeta.transientRetryCount = TRANSIENT_RETRY_MAX;

      jest.spyOn(autoVerifier, "precheckRequiredFiles").mockResolvedValue({
        passed: false,
        missing: ["docs/design/189_req_plan.md"],
      });

      const spawnSpy = jest.spyOn(subagentRpc, "spawnStageSubagent");
      const auditSpy = jest.spyOn(auditLog, "writeAuditLog").mockResolvedValue(undefined as never);

      const health = { messageId: "msg-overflow" };

      await maybeRespawnAfterTransientFailure(mockCtx, mockConfig, mockMeta, health, mockCtx.ui as unknown as ReturnType<typeof import("../../core/pipeline-ui").createPipelineUI>);

      expect(spawnSpy).not.toHaveBeenCalled();

      // Verify freeze via updateMeta with flowState: "blocked"
      expect(metaUpdateCalls).toContainEqual({
        flowState: "blocked",
        blockedReason: "transient_retry_overflow",
      });

      // Verify audit log for overflow (attempt is stringified count)
      expect(auditSpy).toHaveBeenCalledWith(
        "transient_retry_overflow_frozen",
        expect.objectContaining({
          pipelineId: "test-pipeline-123",
          stage: "develop",
        }),
        "warn",
      );

      // Verify UI notification (freezeAndPrompt uses its own message format)
      expect(notifyCalls.some(n => typeof n === 'string' && n.includes("Pipeline blocked: transient_retry_overflow"))).toBe(true);
    });

    test("D2. transientRetryCount = 1 (below limit) → spawn succeeds, count incremented to 2", async () => {
      mockMeta.transientRetryCount = 1;

      jest.spyOn(autoVerifier, "precheckRequiredFiles").mockResolvedValue({
        passed: false,
        missing: ["docs/design/189_req_plan.md"],
      });

      const spawnSpy = jest.spyOn(subagentRpc, "spawnStageSubagent").mockResolvedValue({
        spawned: true,
        fallback: false,
      });

      const auditSpy = jest.spyOn(auditLog, "writeAuditLog").mockResolvedValue(undefined as never);

      const health = { messageId: "msg-retry2" };

      await maybeRespawnAfterTransientFailure(mockCtx, mockConfig, mockMeta, health, mockCtx.ui as unknown as ReturnType<typeof import("../../core/pipeline-ui").createPipelineUI>);

      expect(spawnSpy).toHaveBeenCalledTimes(1);

      expect(metaUpdateCalls).toContainEqual({
        transientRetryCount: 2,
        lastTransientRespawnMsgId: "msg-retry2",
      });

      expect(auditSpy).toHaveBeenCalledWith("transient_auto_respawn", {
        pipelineId: "test-pipeline-123",
        stage: "develop",
        attempt: "2",
        basis: "rpc",
        missing: "docs/design/189_req_plan.md",
      });
    });

    test("D3. transientRetryCount = 0 (initial) → spawn succeeds, count incremented to 1", async () => {
      mockMeta.transientRetryCount = 0;

      jest.spyOn(autoVerifier, "precheckRequiredFiles").mockResolvedValue({
        passed: false,
        missing: ["docs/design/189_req_plan.md"],
      });

      const spawnSpy = jest.spyOn(subagentRpc, "spawnStageSubagent").mockResolvedValue({
        spawned: true,
        fallback: false,
      });

      const auditSpy = jest.spyOn(auditLog, "writeAuditLog").mockResolvedValue(undefined as never);

      const health = { messageId: "msg-retry1" };

      await maybeRespawnAfterTransientFailure(mockCtx, mockConfig, mockMeta, health, mockCtx.ui as unknown as ReturnType<typeof import("../../core/pipeline-ui").createPipelineUI>);

      expect(spawnSpy).toHaveBeenCalledTimes(1);

      expect(metaUpdateCalls).toContainEqual({
        transientRetryCount: 1,
        lastTransientRespawnMsgId: "msg-retry1",
      });

      expect(auditSpy).toHaveBeenCalledWith("transient_auto_respawn", {
        pipelineId: "test-pipeline-123",
        stage: "develop",
        attempt: "1",
        basis: "rpc",
        missing: "docs/design/189_req_plan.md",
      });
    });
  });

  describe("Spawn guard clearing", () => {
    test("E. stale spawnedStages[develop] cleared before spawn so duplicate-guard does not swallow the re-spawn", async () => {
      const staleTimestamp = 12345;
      mockMeta.spawnedStages = { develop: staleTimestamp };
      mockMeta.activeSpawns = {
        develop: { agentName: "pixis-dev", agentId: "abc", startedAt: staleTimestamp, reserved: false },
      };

      jest.spyOn(autoVerifier, "precheckRequiredFiles").mockResolvedValue({
        passed: false,
        missing: ["docs/design/189_req_plan.md"],
      });

      const spawnSpy = jest.spyOn(subagentRpc, "spawnStageSubagent").mockResolvedValue({
        spawned: true,
        fallback: false,
      });

      jest.spyOn(auditLog, "writeAuditLog").mockResolvedValue(undefined as never);

      const health = { messageId: "msg-clear" };

      await maybeRespawnAfterTransientFailure(mockCtx, mockConfig, mockMeta, health, mockCtx.ui as unknown as ReturnType<typeof import("../../core/pipeline-ui").createPipelineUI>);

      // Verify spawnedStages and activeSpawns were cleared for develop
      const spawnClearCall = metaUpdateCalls.find(
        (c) => c.spawnedStages !== undefined && c.activeSpawns !== undefined,
      );
      expect(spawnClearCall).toBeDefined();
      expect(spawnClearCall!.spawnedStages).toEqual(
        expect.objectContaining({ develop: undefined }),
      );
      expect(spawnClearCall!.activeSpawns).toEqual(
        expect.objectContaining({ develop: undefined }),
      );

      // Verify spawnStageSubagent was still called (not blocked by duplicate guard)
      expect(spawnSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe("Fix stage support", () => {
    test("Fix stage with precheck missing → spawn succeeds", async () => {
      mockMeta.currentStage = "fix";

      jest.spyOn(autoVerifier, "precheckRequiredFiles").mockResolvedValue({
        passed: false,
        missing: ["docs/design/189_fix_commit.md"],
      });

      const spawnSpy = jest.spyOn(subagentRpc, "spawnStageSubagent").mockResolvedValue({
        spawned: true,
        fallback: false,
      });

      const auditSpy = jest.spyOn(auditLog, "writeAuditLog").mockResolvedValue(undefined as never);

      const health = { messageId: "msg-fix" };

      await maybeRespawnAfterTransientFailure(mockCtx, mockConfig, mockMeta, health, mockCtx.ui as unknown as ReturnType<typeof import("../../core/pipeline-ui").createPipelineUI>);

      expect(spawnSpy).toHaveBeenCalledTimes(1);
      expect(spawnSpy.mock.calls[0][2]).toBe("fix");

      // Verify extraArgs contains fix commit path
      expect(spawnSpy.mock.calls[0][4]?.extraArgs).toContain("docs/design/189_fix_commit.md");

      expect(auditSpy).toHaveBeenCalledWith("transient_auto_respawn", {
        pipelineId: "test-pipeline-123",
        stage: "fix",
        attempt: "1",
        basis: "rpc",
        missing: "docs/design/189_fix_commit.md",
      });
    });
  });

  describe("Error handling", () => {
    test("spawnStageSubagent failure → error audit logged, no exception thrown", async () => {
      jest.spyOn(autoVerifier, "precheckRequiredFiles").mockResolvedValue({
        passed: false,
        missing: ["docs/design/189_req_plan.md"],
      });

      jest.spyOn(subagentRpc, "spawnStageSubagent").mockRejectedValue(
        new Error("Spawn failed: network timeout"),
      );

      const auditSpy = jest.spyOn(auditLog, "writeAuditLog").mockResolvedValue(undefined as never);

      const health = { messageId: "msg-error" };

      await expect(
        maybeRespawnAfterTransientFailure(mockCtx, mockConfig, mockMeta, health, mockCtx.ui as unknown as ReturnType<typeof import("../../core/pipeline-ui").createPipelineUI>),
      ).resolves.toBeUndefined();

      expect(auditSpy).toHaveBeenCalledWith("transient_respawn_error", {
        pipelineId: "test-pipeline-123",
        stage: "develop",
        error: "Spawn failed: network timeout",
      }, "warn");
    });

    test("precheckRequiredFiles exception → fail-open, no spawn, error audit logged", async () => {
      jest.spyOn(autoVerifier, "precheckRequiredFiles").mockRejectedValue(
        new Error("Precheck failed: disk error"),
      );

      const spawnSpy = jest.spyOn(subagentRpc, "spawnStageSubagent");
      const auditSpy = jest.spyOn(auditLog, "writeAuditLog").mockResolvedValue(undefined as never);

      const health = { messageId: "msg-precheck-error" };

      await expect(
        maybeRespawnAfterTransientFailure(mockCtx, mockConfig, mockMeta, health, mockCtx.ui as unknown as ReturnType<typeof import("../../core/pipeline-ui").createPipelineUI>),
      ).resolves.toBeUndefined();

      expect(spawnSpy).not.toHaveBeenCalled();
      expect(auditSpy).toHaveBeenCalledWith("transient_respawn_error", {
        pipelineId: "test-pipeline-123",
        stage: "develop",
        error: "Precheck failed: disk error",
      }, "warn");
    });
  });

  describe("Edge cases", () => {
    test("flowState aborted → no re-spawn", async () => {
      mockMeta.flowState = "aborted";

      jest.spyOn(autoVerifier, "precheckRequiredFiles").mockResolvedValue({
        passed: false,
        missing: ["docs/design/189_req_plan.md"],
      });

      const spawnSpy = jest.spyOn(subagentRpc, "spawnStageSubagent");
      const auditSpy = jest.spyOn(auditLog, "writeAuditLog").mockResolvedValue(undefined as never);

      const health = { messageId: "msg-aborted" };

      await maybeRespawnAfterTransientFailure(mockCtx, mockConfig, mockMeta, health, mockCtx.ui as unknown as ReturnType<typeof import("../../core/pipeline-ui").createPipelineUI>);

      expect(spawnSpy).not.toHaveBeenCalled();
      expect(auditSpy).not.toHaveBeenCalledWith("transient_auto_respawn", expect.anything());
    });

    test("transientRetryCount undefined (first time) → treated as 0", async () => {
      mockMeta.transientRetryCount = undefined;

      jest.spyOn(autoVerifier, "precheckRequiredFiles").mockResolvedValue({
        passed: false,
        missing: ["docs/design/189_req_plan.md"],
      });

      const spawnSpy = jest.spyOn(subagentRpc, "spawnStageSubagent").mockResolvedValue({
        spawned: true,
        fallback: false,
      });

      const auditSpy = jest.spyOn(auditLog, "writeAuditLog").mockResolvedValue(undefined as never);

      const health = { messageId: "msg-undefined" };

      await maybeRespawnAfterTransientFailure(mockCtx, mockConfig, mockMeta, health, mockCtx.ui as unknown as ReturnType<typeof import("../../core/pipeline-ui").createPipelineUI>);

      expect(spawnSpy).toHaveBeenCalledTimes(1);
      expect(metaUpdateCalls).toContainEqual({
        transientRetryCount: 1,
        lastTransientRespawnMsgId: "msg-undefined",
      });
    });

    test("extraArgs breakpoint prompt includes clear instructions", async () => {
      jest.spyOn(autoVerifier, "precheckRequiredFiles").mockResolvedValue({
        passed: false,
        missing: ["docs/design/189_req_plan.md", "docs/design/189_plan_commit.md"],
      });

      const spawnSpy = jest.spyOn(subagentRpc, "spawnStageSubagent").mockResolvedValue({
        spawned: true,
        fallback: false,
      });

      jest.spyOn(auditLog, "writeAuditLog").mockResolvedValue(undefined as never);

      const health = { messageId: "msg-instructions" };

      await maybeRespawnAfterTransientFailure(mockCtx, mockConfig, mockMeta, health, mockCtx.ui as unknown as ReturnType<typeof import("../../core/pipeline-ui").createPipelineUI>);

      const extraArgs = spawnSpy.mock.calls[0][4]?.extraArgs ?? "";

      // Verify breakpoint prompt contains all required instructions
      expect(extraArgs).toContain("[plugin auto-respawn]");
      expect(extraArgs).toContain("Previous run terminated unexpectedly (transient failure)");
      expect(extraArgs).toContain("docs/design/189_req_plan.md");
      expect(extraArgs).toContain("docs/design/189_plan_commit.md");
      expect(extraArgs).toContain("phases whose commit ids are already registered are DONE");
      expect(extraArgs).toContain("never re-execute completed phases");
    });
  });
});
