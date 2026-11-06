/**
 * 225 Phase 0: prompt-injector git-capability consistency.
 *
 * Two contract points:
 * 1. The injected `Git:` line reflects the EFFECTIVE policy (the same
 *    three-tier chain tool-guard uses): allow → writable, ask → gated,
 *    block → read-only. An `ask` stage must NOT be reported read-only
 *    because the guard will ask (and may allow) each write.
 * 2. A contract stage with an explicit `requireCommitContract: false` opt-out
 *    freezes through the shared freeze entry: `blockedReason` is the exact
 *    machine token, the `pipeline_blocked` audit exists, and the decision
 *    menu is requested exactly once — and the handler returns no injection.
 */

import { describe, it, expect, afterEach } from "bun:test";
import type { PipelineConfig, SessionMeta } from "../../types";
import { createPromptInjector } from "../../core/prompt-injector";
import { makeTestConfig, makeTestMeta } from "../helpers";
import {
  __setSafeWriteAuditLogOverride,
} from "../../utils/auditLog";
import { clearAllDecisionTimers } from "../../core/flow-state";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

/** Captured audit records via the safe-write override. */
interface CapturedAudit {
  event: string;
  detail?: Record<string, unknown>;
}
const audits: CapturedAudit[] = [];

afterEach(() => {
  clearAllDecisionTimers();
  __setSafeWriteAuditLogOverride(null);
});

function installAuditCapture(): void {
  audits.length = 0;
  __setSafeWriteAuditLogOverride((stage: string, payload?: Record<string, string | boolean>) => {
    audits.push({ event: stage, detail: payload });
    return Promise.resolve();
  });
}

type GateCtx = {
  ctx: Parameters<ReturnType<typeof createPromptInjector>["handler"]>[0];
  metadataUpdates: SessionMeta[];
  notifications: string[];
  selectCalls: string[][];
};

function makeGateCtx(meta: SessionMeta): GateCtx {
  const metadataUpdates: SessionMeta[] = [];
  const notifications: string[] = [];
  const selectCalls: string[][] = [];
  const ctx = {
    session: {
      getMeta: () => meta,
      updateMeta: (patch: Partial<SessionMeta>) => {
        Object.assign(meta, patch);
        metadataUpdates.push({ ...meta });
        return meta;
      },
    },
    ui: {
      notify: (msg: string) => {
        notifications.push(msg);
      },
      select: async (_message: string, options: string[]) => {
        selectCalls.push(options);
        return undefined; // selection dismissed; the freeze fact is what we assert
      },
      setStatus: () => {},
    },
    _ctx: { sessionManager: { getBranch: () => [], getEntries: () => [] } },
  };
  return { ctx: ctx as unknown as GateCtx["ctx"], metadataUpdates, notifications, selectCalls };
}

function commitContractVerifySpec(config: PipelineConfig, stage: SessionMeta["currentStage"]) {
  const specDir = path.join(config.projectRoot, ".pi", "references", `${stage}_spec`);
  mkdirSync(specDir, { recursive: true });
  writeFileSync(
    path.join(specDir, "verify.md"),
    "---\nrules:\n  path: \"{designDir}/*_Develop_Commit.md\"\n  groups:\n    - name: commit-ready\n      ruleMode: and\n      rules:\n        - type: requiredGit\n          cleanWorkingTree: true\n---\nbody",
    "utf-8",
  );
}

// ─── Tri-state Git capability line ───────────────────────────────────────────

describe("stage write scope: tri-state Git line (same source as tool-guard)", () => {
  it("global block → Git: read-only for a non-loop stage", async () => {
    const config = makeTestConfig();
    (config.protect as Record<string, unknown>).gitModify = "block";
    const meta = makeTestMeta({ currentStage: "review" });
    const { ctx } = makeGateCtx(meta);
    const hook = createPromptInjector(config);
    const result = (await hook.handler(ctx))!;
    expect(result.systemPrompt!).toContain("Git: read-only (add/commit/push forbidden)");
  });

  it("global ask → Git: gated (an ask stage is NOT read-only)", async () => {
    const config = makeTestConfig();
    (config.protect as Record<string, unknown>).gitModify = "ask";
    const meta = makeTestMeta({ currentStage: "review" });
    const { ctx } = makeGateCtx(meta);
    const hook = createPromptInjector(config);
    const result = (await hook.handler(ctx))!;
    expect(result.systemPrompt!).toContain("Git: gated (each git write is asked; a denied/dismissed ask blocks it)");
    expect(result.systemPrompt!).not.toContain("Git: read-only");
  });

  it("stage-level allow beats the global block → Git: writable", async () => {
    const config = makeTestConfig();
    (config.protect as Record<string, unknown>).gitModify = "block";
    config.stages.review.protect = { gitModify: "allow" };
    const meta = makeTestMeta({ currentStage: "review" });
    const { ctx } = makeGateCtx(meta);
    const hook = createPromptInjector(config);
    const result = (await hook.handler(ctx))!;
    expect(result.systemPrompt!).toContain("Git: writable (commit contract active)");
  });
});

// ─── Contract conflict freeze ────────────────────────────────────────────────

describe("prompt-injector: commit-contract conflict freezes through the shared entry", () => {
  it("disabled contract → blockedReason token, pipeline_blocked audit, ONE decision menu", async () => {
    installAuditCapture();
    const config = makeTestConfig();
    commitContractVerifySpec(config, "fix");
    config.stages.fix.verify = { requireCommitContract: false };
    const meta = makeTestMeta({ currentStage: "fix" });
    const { ctx, selectCalls, notifications } = makeGateCtx(meta);

    const hook = createPromptInjector(config);
    const result = await hook.handler(ctx);

    expect(result).toBeUndefined(); // no injection once frozen
    expect(meta.flowState).toBe("blocked");
    expect(meta.blockedReason).toBe("commit_contract_capability_disabled");
    expect(audits.some((a) => a.event === "pipeline_blocked")).toBe(true);
    expect(audits.some((a) => a.event === "commit_contract_capability_disabled")).toBe(true);
    expect(selectCalls.length).toBe(1); // decision menu requested exactly once
    const notifyText = notifications.join(" ");
    expect(notifyText).toContain("Commit contract unsatisfied at stage 'fix'");
  });

  it("enabled contract stage elevates and does not freeze the pipeline", async () => {
    installAuditCapture();
    const config = makeTestConfig();
    commitContractVerifySpec(config, "fix");
    (config.protect as Record<string, unknown>).gitModify = "block";
    const meta = makeTestMeta({ currentStage: "fix" });
    const { ctx } = makeGateCtx(meta);

    const hook = createPromptInjector(config);
    const result = (await hook.handler(ctx))!;
    expect(result.systemPrompt!.length).toBeGreaterThan(0);
    expect(meta.flowState).toBeUndefined();
    expect(meta.blockedReason).toBeUndefined();
    // The elevation freed git for this stage — the same cache tool-guard consults.
    expect(config.stages.fix.protect?.gitModify).toBe("allow");
  });
});
