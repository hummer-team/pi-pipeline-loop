/**
 * 227 Phase 4 (D-3): the unattended contract is injected EXACTLY once on both
 * rendering paths (default assembly and a project yml template).
 */
import { describe, it, expect, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import type { SessionMeta } from "../../types";
import { createPromptInjector } from "../../core/prompt-injector";
import { resetPromptConfigCache } from "../../core/prompt-config";
import { makeTestConfig, makeTestMeta } from "../helpers";
import { __setSafeWriteAuditLogOverride } from "../../utils/auditLog";
import { clearAllDecisionTimers } from "../../core/flow-state";

const roots: string[] = [];

function makeRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), "pi-227-unattended-"));
  roots.push(root);
  return root;
}

function makeCtx(meta: SessionMeta) {
  return {
    session: {
      getMeta: () => meta,
      updateMeta: (patch: Partial<SessionMeta>) => Object.assign(meta, patch),
    },
    ui: { notify: () => {}, setStatus: () => {}, select: async () => undefined },
    _ctx: { sessionManager: { getBranch: () => [], getEntries: () => [] } },
  } as never;
}

function autoMeta(): SessionMeta {
  return makeTestMeta({
    currentStage: "develop",
    autoJob: { jobId: "unattended_loop", jobPath: "docs/jobs/unattended_loop.yaml", docIndex: 0, totalDocs: 2 },
  });
}

function countSection(text: string): number {
  return text.split("# UNATTENDED AUTO JOB").length - 1;
}

afterEach(() => {
  clearAllDecisionTimers();
  __setSafeWriteAuditLogOverride(null);
  resetPromptConfigCache();
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe("227 P4: unattended section injection", () => {
  it("default rendering path injects it exactly once", async () => {
    __setSafeWriteAuditLogOverride(async () => undefined);
    const root = makeRoot();
    const config = makeTestConfig({ projectRoot: root });
    const hook = createPromptInjector(config);

    const result = (await hook.handler(makeCtx(autoMeta())))!;

    expect(countSection(result.systemPrompt!)).toBe(1);
    expect(result.systemPrompt!).toContain("UNATTENDED AUTO JOB");
  });

  it("yml template path injects it exactly once", async () => {
    __setSafeWriteAuditLogOverride(async () => undefined);
    const root = makeRoot();
    const refs = path.join(root, ".pi", "references");
    mkdirSync(refs, { recursive: true });
    writeFileSync(
      path.join(refs, "pipeline-stage-prompt.yml"),
      'stage_executor_develop: "Custom develop template body"\n',
      "utf-8",
    );
    const config = makeTestConfig({ projectRoot: root });
    const hook = createPromptInjector(config);

    const result = (await hook.handler(makeCtx(autoMeta())))!;

    expect(result.systemPrompt!).toContain("Custom develop template body");
    expect(countSection(result.systemPrompt!)).toBe(1);
  });

  it("human track stays byte-identical (no section)", async () => {
    __setSafeWriteAuditLogOverride(async () => undefined);
    const root = makeRoot();
    const config = makeTestConfig({ projectRoot: root });
    const hook = createPromptInjector(config);

    const result = (await hook.handler(makeCtx(makeTestMeta({ currentStage: "develop" }))))!;

    expect(countSection(result.systemPrompt!)).toBe(0);
  });
});
