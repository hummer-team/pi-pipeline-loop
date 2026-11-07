/**
 * 220 review round 2 (issue 1, Medium): the verify-failure hard stop must judge
 * the SAME cap the verify chain freezes on.
 *
 * `verify.maxAttempts` is inherit-not-overlay (Phase 2 task 2 + template
 * comment): an unconfigured job keeps `pipeline_loop.json`'s
 * `maxVerifyAttempts`. Judging the schema default instead let the two
 * thresholds diverge — the job stopped at 3 while the verify chain ran to 5,
 * or the chain froze before the job could ever stop.
 *
 * Sealed behaviors:
 * - `resolveVerifyMaxAttempts` reads the live config first (the verify chain's
 *   own expression), the job value only as a fallback;
 * - `evaluateHardStop` uses the supplied effective cap;
 * - the settle seam passes it, so `handleAutoSettle` inherits the JSON value.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { makeTestMeta } from "../helpers";
import { createJobState, type AutoJobState } from "../../core/auto-pipeline/job-state";
import { parseAutoJob, type AutoJobConfig } from "../../core/auto-pipeline/job-schema";
import {
  evaluateHardStop,
  resolveVerifyMaxAttempts,
} from "../../core/auto-pipeline/stop-policy";
import { handleAutoSettle } from "../../core/auto-pipeline/settle-seam";
import { __resetAutoJobLockForTests } from "../../core/auto-pipeline/config-overlay";
import { __resetFinalizeStateForTests } from "../../core/auto-pipeline/finalize";
import { __setSafeWriteAuditLogOverride } from "../../utils/auditLog";
import { createAutoHarness, createSessionStub, deployHarnessAgents, HARNESS_DOCS, HARNESS_JOB_YAML, type AutoHarness } from "./auto-harness";

/** The harness job deliberately configures NO `verify` block (inherit case). */
const JOB_YAML = [
  "version: 1",
  "enabled: true",
  "docs:",
  "  list:",
  "    - doc: docs/design/a.md",
].join("\n");

const NOW = 30_000_000;

function job(): AutoJobConfig {
  const parsed = parseAutoJob(JOB_YAML, "docs/jobs/alpha_loop.yaml");
  if (!parsed.ok) throw new Error(parsed.errors.join("; "));
  return parsed.job;
}

function state(): AutoJobState {
  return createJobState({
    jobId: "alpha_loop",
    jobPath: "docs/jobs/alpha_loop.yaml",
    jobHash: "h",
    docs: [{ doc: "docs/design/a.md" }],
  });
}

describe("resolveVerifyMaxAttempts — inherit rule", () => {
  it("live config wins over the job default (the verify chain's own value)", () => {
    expect(resolveVerifyMaxAttempts({ maxVerifyAttempts: 5, maxLoops: 3 }, job())).toBe(5);
  });

  it("falls back to maxLoops, then to the job default", () => {
    expect(resolveVerifyMaxAttempts({ maxLoops: 4 }, job())).toBe(4);
    expect(resolveVerifyMaxAttempts({}, job())).toBe(job().verify.maxAttempts);
  });
});

describe("evaluateHardStop — effective verify cap", () => {
  it("an unconfigured job does NOT stop at the schema default when JSON says 5", () => {
    const cap = resolveVerifyMaxAttempts({ maxVerifyAttempts: 5 }, job());
    const atThree = makeTestMeta({ verifyAttempts: 3 });
    expect(evaluateHardStop({ state: state(), meta: atThree, job: job(), now: NOW, verifyMaxAttempts: cap }).kind).toBe(
      "continue",
    );
    const atFive = makeTestMeta({ verifyAttempts: 5 });
    expect(evaluateHardStop({ state: state(), meta: atFive, job: job(), now: NOW, verifyMaxAttempts: cap })).toEqual({
      kind: "hard",
      stopReason: "verify_failures",
    });
  });

  it("omitted cap keeps the job value (predicate stays total)", () => {
    const atThree = makeTestMeta({ verifyAttempts: 3 });
    expect(evaluateHardStop({ state: state(), meta: atThree, job: job(), now: NOW })).toEqual({
      kind: "hard",
      stopReason: "verify_failures",
    });
  });
});

describe("handleAutoSettle — the seam passes the effective cap", () => {
  let harness: AutoHarness;

  beforeEach(async () => {
    harness = createAutoHarness();
    // 226 Phase 2: the startup clarify round will be dispatched by these
    // settle tests — the configured executor must resolve its agent file.
    deployHarnessAgents(harness);
    await harness.install();
    __resetFinalizeStateForTests();
    __setSafeWriteAuditLogOverride(async () => {});
  });

  afterEach(() => {
    __setSafeWriteAuditLogOverride(null);
    __resetFinalizeStateForTests();
    __resetAutoJobLockForTests();
    harness.dispose();
  });

  function ctx(): unknown {
    const stub = createSessionStub(makeTestMeta({ requirementDoc: HARNESS_DOCS[0]! }));
    return {
      session: stub.session,
      ui: stub.ui,
      pi: { sendUserMessage: () => {} },
      _ctx: { sessionManager: { getHeader: () => ({}), getSessionName: () => "owner" } },
    };
  }

  it("job without verify.maxAttempts + JSON maxVerifyAttempts=5 → stops at 5, not 3", async () => {
    harness.config.maxVerifyAttempts = 5;

    const atThree = makeTestMeta({ currentStage: "develop", verifyAttempts: 3 });
    expect(await handleAutoSettle(ctx() as never, harness.config, atThree)).toBe(false);

    const atFive = makeTestMeta({ currentStage: "develop", verifyAttempts: 5 });
    expect(await handleAutoSettle(ctx() as never, harness.config, atFive)).toBe(true);
    expect(harness.state().docs[0]?.failReason).toBe("verify_failures");
  });

  it("226 Phase 3: a hard stop keeps the cause on the doc — freeze_unresolvable(<blockedReason>)", async () => {
    // Make the freeze unresolvable for this reason under the job policy.
    const jobPath = path.join(harness.root, "docs", "jobs", "alpha_loop.yaml");
    fs.writeFileSync(
      jobPath,
      HARNESS_JOB_YAML.replace("  onFreeze: resume", "  onFreeze: stop-and-report"),
      "utf8",
    );

    const blocked = makeTestMeta({
      currentStage: "develop",
      flowState: "blocked",
      blockedReason: "wall_clock_hit",
    });
    expect(await handleAutoSettle(ctx() as never, harness.config, blocked)).toBe(true);

    const state = harness.state();
    // The DOC-level receipt carries the SOURCE cause; the JOB-level label stays
    // `freeze_unresolvable` (no new stop reason — review B-#8g).
    expect(state.docs[0]?.failReason).toBe("freeze_unresolvable(wall_clock_hit)");
    expect(state.stopReason).toBe("freeze_unresolvable");
    expect(state.status).toBe("failed");
  });
});
