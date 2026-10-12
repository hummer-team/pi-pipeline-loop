/**
 * @module violation-tracker-phase7.test
 * Phase 7 (195_Bug): Bucket-based violation counting tests.
 *
 * Test coverage:
 * - Bucket threshold: Each bucket uses DEFAULT_MAX_VIOLATIONS
 * - bash_destructive bucket NEVER triggers freeze
 * - Audit fields: guardSource, bucketCount, bucketLimit
 * - Legacy compatibility: Items without guardSource count as legacy
 */

import { describe, it, expect, beforeAll, afterEach } from "bun:test";
import { recordViolation, checkViolationBreaker, groupViolationsByGuardSource, type GuardSource } from "../../core/violation-tracker";
import { makeTestConfig, makeTestMeta } from "../helpers";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initAuditLog, getDateAuditFileName, __resetAuditDirPath } from "../../utils/auditLog";
import type { SessionMeta, ViolationItem } from "../../types";
import { DEFAULT_MAX_VIOLATIONS, DEFAULT_BASH_DESTRUCTIVE_PROMPT_MAX } from "../../constants";
import { auditLogFileFor } from "../helpers";

const TMP = join(tmpdir(), "pi-violation-tracker-phase7-test-" + Date.now());

function createCtx(meta: SessionMeta) {
  const updates: SessionMeta[] = [];
  return {
    session: {
      getMeta: () => meta,
      updateMeta: (patch: Partial<SessionMeta>) => {
        const merged = { ...meta, ...patch };
        updates.push(merged);
        Object.assign(meta, merged);
        return merged;
      },
    },
    ui: {
      notify: (_msg: string) => {},
      select: async (_msg: string, _opts: string[]) => undefined,
    },
    updates,
  };
}

function makeViolationWithGuardSource(
  type: ViolationItem["type"] = "write_protected",
  guardSource?: GuardSource
): ViolationItem {
  return {
    type,
    tool: "write",
    detail: `Test ${type} violation with guardSource=${guardSource ?? "none"}`,
    timestamp: Date.now(),
    ...(guardSource !== undefined ? { guardSource } : {}),
  };
}

beforeAll(async () => {
  await mkdir(TMP, { recursive: true });
  await initAuditLog(makeTestConfig({ projectRoot: TMP }));
});

afterEach(() => {
  __resetAuditDirPath();
});

describe("Phase 7: groupViolationsByGuardSource", () => {
  it("groups violations by guardSource correctly", () => {
    const violations: ViolationItem[] = [
      makeViolationWithGuardSource("write_protected", "read_only_path"),
      makeViolationWithGuardSource("write_protected", "read_only_path"),
      makeViolationWithGuardSource("git_protected", "git_policy"),
      makeViolationWithGuardSource("bash_destructive", "bash_destructive"),
      makeViolationWithGuardSource("write_protected", "dynamic_write_scope"),
    ];

    const buckets = groupViolationsByGuardSource(violations);

    expect(buckets.read_only_path).toBe(2);
    expect(buckets.git_policy).toBe(1);
    expect(buckets.bash_destructive).toBe(1);
    expect(buckets.dynamic_write_scope).toBe(1);
    expect(buckets.legacy).toBe(0);
  });

  it("counts items without guardSource as legacy", () => {
    const violations: ViolationItem[] = [
      makeViolationWithGuardSource("write_protected"), // No guardSource
      makeViolationWithGuardSource("write_protected"), // No guardSource
      makeViolationWithGuardSource("git_protected", "git_policy"),
    ];

    const buckets = groupViolationsByGuardSource(violations);

    expect(buckets.legacy).toBe(2);
    expect(buckets.git_policy).toBe(1);
  });

  it("returns all zeros for empty array", () => {
    const buckets = groupViolationsByGuardSource([]);

    expect(buckets.read_only_path).toBe(0);
    expect(buckets.dynamic_write_scope).toBe(0);
    expect(buckets.git_policy).toBe(0);
    expect(buckets.bash_destructive).toBe(0);
    expect(buckets.legacy).toBe(0);
  });
});

describe("Phase 7: recordViolation audit fields", () => {
  it("writes audit entry with guardSource, bucketCount, bucketLimit", async () => {
    await initAuditLog(makeTestConfig({ projectRoot: TMP }));
    const config = makeTestConfig({ projectRoot: TMP });
    const meta = makeTestMeta();
    const ctx = createCtx(meta);

    const item: ViolationItem = makeViolationWithGuardSource("write_protected", "read_only_path");
    await recordViolation(ctx as any, meta, item);

    const logPath = auditLogFileFor(join(TMP, ".pi", "audit"));
    const logContent = await readFile(logPath, "utf-8");

    expect(logContent).toContain("pipeline_violation");
    expect(logContent).toContain("guardSource=read_only_path");
    expect(logContent).toContain("bucketCount=1");
    expect(logContent).toContain(`bucketLimit=${DEFAULT_MAX_VIOLATIONS}`);
  });

  it("writes audit entry with legacy guardSource when guardSource is undefined", async () => {
    await initAuditLog(makeTestConfig({ projectRoot: TMP }));
    const config = makeTestConfig({ projectRoot: TMP });
    const meta = makeTestMeta();
    const ctx = createCtx(meta);

    const item: ViolationItem = {
      type: "write_protected",
      tool: "write",
      detail: "Test violation without guardSource",
      timestamp: Date.now(),
    };
    await recordViolation(ctx as any, meta, item);

    const logPath = auditLogFileFor(join(TMP, ".pi", "audit"));
    const logContent = await readFile(logPath, "utf-8");

    expect(logContent).toContain("guardSource=legacy");
  });

  it("uses DEFAULT_BASH_DESTRUCTIVE_PROMPT_MAX as bucketLimit for bash_destructive", async () => {
    await initAuditLog(makeTestConfig({ projectRoot: TMP }));
    const config = makeTestConfig({ projectRoot: TMP });
    const meta = makeTestMeta();
    const ctx = createCtx(meta);

    const item: ViolationItem = makeViolationWithGuardSource("bash_destructive", "bash_destructive");
    await recordViolation(ctx as any, meta, item);

    const logPath = auditLogFileFor(join(TMP, ".pi", "audit"));
    const logContent = await readFile(logPath, "utf-8");

    expect(logContent).toContain("guardSource=bash_destructive");
    expect(logContent).toContain(`bucketLimit=${DEFAULT_BASH_DESTRUCTIVE_PROMPT_MAX}`);
  });

  it("increments bucketCount correctly for same bucket", async () => {
    await initAuditLog(makeTestConfig({ projectRoot: TMP }));
    const config = makeTestConfig({ projectRoot: TMP });
    const meta = makeTestMeta();
    const ctx = createCtx(meta);

    // Add 3 violations to the same bucket
    await recordViolation(ctx as any, meta, makeViolationWithGuardSource("write_protected", "read_only_path"));
    await recordViolation(ctx as any, meta, makeViolationWithGuardSource("write_protected", "read_only_path"));
    await recordViolation(ctx as any, meta, makeViolationWithGuardSource("write_protected", "read_only_path"));

    const logPath = auditLogFileFor(join(TMP, ".pi", "audit"));
    const logContent = await readFile(logPath, "utf-8");
    const lines = logContent.trim().split("\n");

    // Check the last 3 entries have incrementing bucketCount
    expect(lines[lines.length - 3]).toContain("bucketCount=1");
    expect(lines[lines.length - 2]).toContain("bucketCount=2");
    expect(lines[lines.length - 1]).toContain("bucketCount=3");
  });
});

describe("Phase 7: checkViolationBreaker bucket-based threshold", () => {
  it("does NOT freeze when each bucket is below threshold", async () => {
    const config = makeTestConfig();
    const meta = makeTestMeta({
      violations: [
        makeViolationWithGuardSource("write_protected", "read_only_path"),
        makeViolationWithGuardSource("git_protected", "git_policy"),
        makeViolationWithGuardSource("bash_destructive", "bash_destructive"),
      ],
    });
    const ctx = createCtx(meta);

    await checkViolationBreaker(ctx as any, meta, config);

    expect(meta.flowState).not.toBe("blocked");
  });

  it("freezes when read_only_path bucket reaches threshold", async () => {
    const config = makeTestConfig();
    const violations: ViolationItem[] = [];
    for (let i = 0; i < DEFAULT_MAX_VIOLATIONS; i++) {
      violations.push(makeViolationWithGuardSource("write_protected", "read_only_path"));
    }
    const meta = makeTestMeta({ violations });
    const ctx = createCtx(meta);

    await checkViolationBreaker(ctx as any, meta, config);

    expect(meta.flowState).toBe("blocked");
    expect(meta.blockedReason).toBe("violation_overflow");
  });

  it("freezes when git_policy bucket reaches threshold", async () => {
    const config = makeTestConfig();
    const violations: ViolationItem[] = [];
    for (let i = 0; i < DEFAULT_MAX_VIOLATIONS; i++) {
      violations.push(makeViolationWithGuardSource("git_protected", "git_policy"));
    }
    const meta = makeTestMeta({ violations });
    const ctx = createCtx(meta);

    await checkViolationBreaker(ctx as any, meta, config);

    expect(meta.flowState).toBe("blocked");
    expect(meta.blockedReason).toBe("violation_overflow");
  });

  it("freezes when dynamic_write_scope bucket reaches threshold", async () => {
    const config = makeTestConfig();
    const violations: ViolationItem[] = [];
    for (let i = 0; i < DEFAULT_MAX_VIOLATIONS; i++) {
      violations.push(makeViolationWithGuardSource("write_protected", "dynamic_write_scope"));
    }
    const meta = makeTestMeta({ violations });
    const ctx = createCtx(meta);

    await checkViolationBreaker(ctx as any, meta, config);

    expect(meta.flowState).toBe("blocked");
    expect(meta.blockedReason).toBe("violation_overflow");
  });

  it("NEVER freezes for bash_destructive bucket, even at high count", async () => {
    const config = makeTestConfig();
    const violations: ViolationItem[] = [];
    // Add way more than DEFAULT_MAX_VIOLATIONS
    for (let i = 0; i < DEFAULT_MAX_VIOLATIONS * 3; i++) {
      violations.push(makeViolationWithGuardSource("bash_destructive", "bash_destructive"));
    }
    const meta = makeTestMeta({ violations });
    const ctx = createCtx(meta);

    await checkViolationBreaker(ctx as any, meta, config);

    // bash_destructive is advisory-only, never triggers freeze
    expect(meta.flowState).not.toBe("blocked");
    expect(meta.blockedReason).not.toBe("violation_overflow");
  });

  it("freezes when legacy bucket reaches threshold", async () => {
    const config = makeTestConfig();
    const violations: ViolationItem[] = [];
    for (let i = 0; i < DEFAULT_MAX_VIOLATIONS; i++) {
      violations.push(makeViolationWithGuardSource("write_protected")); // No guardSource
    }
    const meta = makeTestMeta({ violations });
    const ctx = createCtx(meta);

    await checkViolationBreaker(ctx as any, meta, config);

    expect(meta.flowState).toBe("blocked");
    expect(meta.blockedReason).toBe("violation_overflow");
  });

  it("handles mixed buckets correctly - freezes only when one bucket hits threshold", async () => {
    const config = makeTestConfig();
    const violations: ViolationItem[] = [];
    // Add violations to multiple buckets, but only read_only_path hits threshold
    for (let i = 0; i < DEFAULT_MAX_VIOLATIONS; i++) {
      violations.push(makeViolationWithGuardSource("write_protected", "read_only_path"));
    }
    for (let i = 0; i < DEFAULT_MAX_VIOLATIONS - 1; i++) {
      violations.push(makeViolationWithGuardSource("git_protected", "git_policy"));
    }
    for (let i = 0; i < 10; i++) {
      violations.push(makeViolationWithGuardSource("bash_destructive", "bash_destructive"));
    }
    const meta = makeTestMeta({ violations });
    const ctx = createCtx(meta);

    await checkViolationBreaker(ctx as any, meta, config);

    // Should freeze because read_only_path hit threshold
    expect(meta.flowState).toBe("blocked");
    expect(meta.blockedReason).toBe("violation_overflow");
  });
});
