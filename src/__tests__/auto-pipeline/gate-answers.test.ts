/**
 * 219 Phase 3 (G5): automatic answers for the three write/command dialogs.
 *
 * Key behaviors:
 * - Only an ACTIVE auto job answers; otherwise `auto: false` (human mode).
 * - In auto mode `"ask"` NEVER becomes "allow" — protected paths and
 *   destructive commands are ALWAYS blocked (the job must not widen itself).
 * - `whitelist_miss` follows the resolved mode: allow → allow, deny/ask → block.
 * - The verdict never depends on the dialog detail (policy keys are the only
 *   authority), and hard boundaries are decided before this module is reached.
 */
import { describe, it, expect, beforeEach, afterEach, spyOn } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { makeTestConfig, makeTestMeta } from "../helpers";
import { resolveAutoGate } from "../../core/auto-pipeline/gate-answers";
import {
  acquireJobLock,
  releaseJobLock,
  __resetAutoJobLockForTests,
} from "../../core/auto-pipeline/config-overlay";
import { __setSafeWriteAuditLogOverride } from "../../utils/auditLog";

let ROOT: string;
let errorSpy: ReturnType<typeof spyOn>;

beforeEach(() => {
  ROOT = fs.mkdtempSync(path.join(tmpdir(), "pi-219-gates-"));
  __resetAutoJobLockForTests();
  __setSafeWriteAuditLogOverride(async () => undefined);
  errorSpy = spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  __setSafeWriteAuditLogOverride(null);
  errorSpy.mockRestore();
  __resetAutoJobLockForTests();
  fs.rmSync(ROOT, { recursive: true, force: true });
});

function configWith(protect: Record<string, unknown>) {
  return makeTestConfig({
    projectRoot: ROOT,
    protect: { gitignore: true, paths: [], allow: [], ...protect } as never,
  });
}

function activateAutoJob(): string {
  const acquired = acquireJobLock({ projectRoot: ROOT, jobId: "alpha_loop" });
  if (!acquired.ok) throw new Error("lock acquire failed");
  return acquired.token;
}

describe("gate-answers — human mode", () => {
  it("all three kinds are inert without an active auto job", () => {
    const config = configWith({});
    const meta = makeTestMeta();
    for (const kind of ["protected_path", "destructive_command", "whitelist_miss"] as const) {
      expect(resolveAutoGate(kind, config, meta, { path: "src/a.ts" })).toEqual({ auto: false });
    }
  });

  it("releasing the lock restores the inert verdict", () => {
    const token = activateAutoJob();
    const config = configWith({});
    expect(resolveAutoGate("protected_path", config, makeTestMeta(), {}).auto).toBe(true);
    releaseJobLock({ projectRoot: ROOT, token });
    expect(resolveAutoGate("protected_path", config, makeTestMeta(), {})).toEqual({ auto: false });
  });
});

describe("gate-answers — protected_path matrix", () => {
  const cases: Array<[string, Record<string, unknown>]> = [
    ["explicit deny", { protectedPathPolicy: "deny" }],
    ["explicit ask", { protectedPathPolicy: "ask" }],
    ["ask fallback (ask:true)", { ask: true }],
    ["deny fallback (ask:false)", { ask: false }],
    ["no protect block", {}],
  ];
  for (const [label, protect] of cases) {
    it(`${label} → block (auto never converts a question into consent)`, () => {
      activateAutoJob();
      const verdict = resolveAutoGate("protected_path", configWith(protect), makeTestMeta(), {
        path: "src/protected/a.ts",
      });
      expect(verdict.auto).toBe(true);
      if (!verdict.auto) return;
      expect(verdict.decision).toBe("block");
      expect(verdict.reason).toContain("protected_path_policy=");
    });
  }
});

describe("gate-answers — destructive_command matrix", () => {
  const cases: Array<[string, Record<string, unknown>]> = [
    ["explicit deny", { destructiveCommand: "deny" }],
    ["explicit ask", { destructiveCommand: "ask" }],
    ["ask fallback (ask:true)", { ask: true }],
    ["deny fallback (ask:false)", { ask: false }],
  ];
  for (const [label, protect] of cases) {
    it(`${label} → block`, () => {
      activateAutoJob();
      const verdict = resolveAutoGate("destructive_command", configWith(protect), makeTestMeta(), {
        command: "rm -rf src",
      });
      expect(verdict.auto).toBe(true);
      if (!verdict.auto) return;
      expect(verdict.decision).toBe("block");
      expect(verdict.reason).toContain("destructive_command_policy=");
    });
  }
});

describe("gate-answers — whitelist_miss matrix", () => {
  it("resolved mode allow → allow", () => {
    activateAutoJob();
    const verdict = resolveAutoGate(
      "whitelist_miss",
      configWith({ whitelistMiss: "allow" }),
      makeTestMeta(),
      { path: "docs/a.md" },
    );
    expect(verdict).toMatchObject({ auto: true, decision: "allow" });
  });

  it("resolved mode deny → block", () => {
    activateAutoJob();
    const verdict = resolveAutoGate(
      "whitelist_miss",
      configWith({ whitelistMiss: "deny" }),
      makeTestMeta(),
      { path: "docs/a.md" },
    );
    expect(verdict).toMatchObject({ auto: true, decision: "block" });
  });

  it("mode ask (configured or default) → block, never allow", () => {
    activateAutoJob();
    for (const config of [configWith({ whitelistMiss: "ask" }), configWith({})]) {
      expect(resolveAutoGate("whitelist_miss", config, makeTestMeta(), { path: "docs/a.md" })).toMatchObject({
        auto: true,
        decision: "block",
      });
    }
  });

  it("honours the stage-level whitelistMiss override (Tier 1)", () => {
    activateAutoJob();
    const base = makeTestConfig({ projectRoot: ROOT, protect: { gitignore: true, paths: [], allow: [] } });
    base.stages.develop = {
      ...base.stages.develop!,
      protect: { whitelistMiss: "allow" },
    } as typeof base.stages.develop;
    const verdict = resolveAutoGate(
      "whitelist_miss",
      base,
      makeTestMeta({ currentStage: "develop" }),
      { path: "docs/a.md" },
    );
    expect(verdict).toMatchObject({ auto: true, decision: "allow" });
  });
});

describe("gate-answers — verdict is policy-only", () => {
  it("detail never changes the verdict", () => {
    activateAutoJob();
    const config = configWith({ whitelistMiss: "allow" });
    const meta = makeTestMeta();
    const withoutDetail = resolveAutoGate("whitelist_miss", config, meta);
    const withDetail = resolveAutoGate("whitelist_miss", config, meta, { path: "src/x.ts" });
    expect(withoutDetail).toMatchObject({ auto: true });
    expect(withDetail).toMatchObject({ auto: true });
    if (withoutDetail.auto && withDetail.auto) {
      expect(withoutDetail.decision).toBe(withDetail.decision);
    }
  });
});
