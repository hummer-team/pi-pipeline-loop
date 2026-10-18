/**
 * 203_Bug Phase 2 (RC3): environmental-only verification failures must be
 * persisted but NOT counted against verifyAttempts, so a stage whose outputs
 * live under pipeline-managed/ignored paths can never freeze on
 * verify_attempt_overflow. Mixed failures keep the original counting semantics.
 */
import { beforeAll, describe, expect, it } from "bun:test";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { applyVerifyFail, isEnvironmentalOnly } from "../../core/verify-advance";
import { createPipelineUI } from "../../core/pipeline-ui";
import { initAuditLog } from "../../utils/auditLog";
import { makeTestConfig, makeTestMeta, auditLogFileFor } from "../helpers";
import type { PipelineConfig, SessionMeta } from "../../types";

const TMP = join(tmpdir(), "pi-verify-env-blocked-" + Date.now());
const AUDIT_ROOT = join(TMP, ".pi", "audit");

const config: PipelineConfig = makeTestConfig({ projectRoot: TMP });

function createCtx(meta: SessionMeta) {
  const notifications: string[] = [];
  const updates: SessionMeta[] = [];
  return {
    session: {
      getMeta: () => meta,
      updateMeta: (patch: Partial<SessionMeta>) => {
        const merged = { ...meta, ...patch } as SessionMeta;
        updates.push(merged);
        Object.assign(meta, merged);
        return merged;
      },
    },
    ui: {
      notify: (msg: string) => {
        notifications.push(msg);
      },
    },
    pipelineUI: createPipelineUI(config),
    notifications,
    updates,
  };
}

beforeAll(async () => {
  await mkdir(TMP, { recursive: true });
  await initAuditLog(config);
});

describe("isEnvironmentalOnly", () => {
  it("is false for an empty failure set", () => {
    expect(isEnvironmentalOnly([])).toBe(false);
  });

  it("is true when every failure is non-countable", () => {
    expect(isEnvironmentalOnly([{ nonCountable: true }, { nonCountable: true }])).toBe(true);
  });

  it("is false when any failure is countable", () => {
    expect(isEnvironmentalOnly([{ nonCountable: true }, {}])).toBe(false);
  });
});

describe("applyVerifyFail environmental downgrade", () => {
  it("persists the failure without counting or freezing", async () => {
    const meta = makeTestMeta({ currentStage: "review", pipelineId: "pipe-env-001" });
    const ctx = createCtx(meta);

    const result = await applyVerifyFail(
      ctx as never,
      meta,
      "review",
      {
        structuredResult: {
          failures: [{
            ruleType: "requiredGit",
            detail: "Working tree is not clean: docs-only changes",
            nonCountable: true,
          }],
        },
        ruleMissing: [],
        verifyResult: null,
      },
      "tool",
      ctx.pipelineUI,
      config,
    );

    // Persisted, not counted.
    expect(meta.verifyFailures?.length).toBe(1);
    expect(meta.verifyFailures?.[0].nonCountable).toBe(true);
    expect(meta.verifyAttempts ?? 0).toBe(0);
    expect(meta.flowState).not.toBe("blocked");

    expect(result.success).toBe(false);
    expect(result.passed).toBe(false);
    expect(result.message).toContain("environmental");
    expect(result.failures[0].nonCountable).toBe(true);
    expect(ctx.notifications.some((n) => n.includes("environmental"))).toBe(true);

    const logContent = await readFile(
      auditLogFileFor(AUDIT_ROOT, "pipe-env-001"),
      "utf-8",
    );
    expect(logContent).toContain("auto_verify_env_blocked");
    expect(logContent).not.toContain("auto_verify_fail ");
  });

  it("never reaches verify_attempt_overflow across repeated environmental fails", async () => {
    const meta = makeTestMeta({ currentStage: "review", pipelineId: "pipe-env-repeat-001" });
    const ctx = createCtx(meta);
    const shared = {
      structuredResult: {
        failures: [{
          ruleType: "requiredGit",
          detail: "Working tree is not clean: .pi-only changes",
          nonCountable: true,
        }],
      },
      ruleMissing: [],
      verifyResult: null,
    };

    for (let i = 0; i < (config.maxVerifyAttempts ?? 3) + 2; i++) {
      await applyVerifyFail(ctx as never, meta, "review", shared, "tool", ctx.pipelineUI, config);
    }

    expect(meta.verifyAttempts ?? 0).toBe(0);
    expect(meta.flowState).not.toBe("blocked");
  });

  it("keeps counting when environmental and ordinary failures are mixed", async () => {
    const meta = makeTestMeta({ currentStage: "develop", pipelineId: "pipe-env-mixed-001" });
    const ctx = createCtx(meta);

    await applyVerifyFail(
      ctx as never,
      meta,
      "develop",
      {
        structuredResult: {
          failures: [
            { ruleType: "requiredGit", detail: "managed-path dirt", nonCountable: true },
            { ruleType: "requiredFiles", detail: "missing: docs/design/out.md" },
          ],
        },
        ruleMissing: [],
        verifyResult: null,
      },
      "tool",
      ctx.pipelineUI,
      config,
    );

    expect(meta.verifyAttempts).toBe(1);
    expect(meta.flowState).not.toBe("blocked");

    const logContent = await readFile(
      auditLogFileFor(AUDIT_ROOT, "pipe-env-mixed-001"),
      "utf-8",
    );
    expect(logContent).toContain("auto_verify_fail");
    expect(logContent).not.toContain("auto_verify_env_blocked");
  });

  it("adds missing-keyword failures as countable items (no silent downgrade)", async () => {
    const meta = makeTestMeta({ currentStage: "develop", pipelineId: "pipe-env-keywords-001" });
    const ctx = createCtx(meta);

    await applyVerifyFail(
      ctx as never,
      meta,
      "develop",
      {
        structuredResult: {
          failures: [{ ruleType: "requiredGit", detail: "managed-path dirt", nonCountable: true }],
        },
        ruleMissing: ["deployment-ready"],
        verifyResult: null,
      },
      "tool",
      ctx.pipelineUI,
      config,
    );

    expect(meta.verifyFailures?.some((f) => f.ruleType === "keywords")).toBe(true);
    expect(meta.verifyAttempts).toBe(1);
  });
});
