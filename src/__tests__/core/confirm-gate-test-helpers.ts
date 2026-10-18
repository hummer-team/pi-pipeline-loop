import { beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { makeTestConfig } from "../helpers";
import { initAuditLog } from "../../utils/auditLog";
import type { SessionMeta } from "../../types";

// ── Shared tmpDir setup for confirm-gate test files ──────────────────────────

let tmpDir: string;

export function getTmpDir(): string {
  return tmpDir;
}

export function setupConfirmGateTmpDir(): void {
  beforeEach(async () => {
    tmpDir = path.join(tmpdir(), "pi-confirm-gate-" + Date.now());
    await fs.mkdir(tmpDir, { recursive: true });
    // Initialize audit log so writeAuditLog doesn't fail with ENOENT
    await initAuditLog(makeTestConfig({ projectRoot: tmpDir }));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });
}

// ── Shared helper: makePlanConfigWithConfirm ─────────────────────────────────

export function makePlanConfigWithConfirm(root: string, confirmMode: "auto" | "manual" | "smart", maxRejections?: number) {
  const base = makeTestConfig({ projectRoot: root });
  const planStage = {
    ...base.stages.plan,
    allowedWritePaths: ["docs/", "doc/", "documentation/"],
    confirm: { mode: confirmMode, ...(maxRejections !== undefined ? { maxRejections } : {}) },
  };
  return {
    ...base,
    stages: { ...base.stages, plan: planStage as typeof base.stages.plan },
  };
}

// ── Shared helper: createPlanDoc ─────────────────────────────────────────────

export async function createPlanDoc(content: string): Promise<string> {
  const docsDir = path.join(tmpDir, "docs", "design");
  await fs.mkdir(docsDir, { recursive: true });
  const planPath = path.join(docsDir, "77_Config_Plan.md");
  await fs.writeFile(planPath, content, "utf-8");
  return planPath;
}

// ── Shared helper: createProductionSemanticsCtx ──────────────────────────────
//
// createMockCtx (helpers.ts) uses Object.assign(meta, patch) in updateMeta,
// which mutates the caller's `meta` snapshot in place. Production
// createSessionState.updateMeta() (session-state.ts:174) creates a new object
// via { ...current, ...patch } and does NOT mutate the caller's reference;
// getMeta() returns a fresh JSON.parse on every call.
//
// This helper mimics production semantics so regression tests genuinely cover
// the production path (review round-2 finding: in-place mutation caused a
// false-positive pass).

export function createProductionSemanticsCtx(initialMeta: SessionMeta) {
  // Internal "persisted" state — starts as a copy of the input snapshot.
  let persisted: SessionMeta = { ...initialMeta };
  const statusCalls: { key: string; text: string | undefined }[] = [];
  const notifications: string[] = [];

  return {
    session: {
      // Production getMeta returns a fresh copy each time.
      getMeta: (): SessionMeta => ({ ...persisted }),
      // Production updateMeta returns a new merged object without mutating
      // the caller's reference (session-state.ts:174).
      updateMeta: (patch: Partial<SessionMeta>): SessionMeta => {
        persisted = { ...persisted, ...patch };
        return persisted;
      },
    },
    ui: {
      notify: (_msg: string) => { /* capture via outer scope if needed */ },
      setStatus: (key: string, text: string | undefined) => {
        statusCalls.push({ key, text });
      },
      select: undefined as ((message: string, options: string[]) => Promise<string | undefined>) | undefined,
    },
    _statusCalls: statusCalls,
    _notifications: notifications,
    _persisted: () => persisted,
  };
}
