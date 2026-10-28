/**
 * 217 Phase 3 (T3.3–T3.4): destructive-command escalation through the REAL
 * hooks — `tool_guard` child fail-closed escalation and `agent_settled` owner
 * consumption.
 *
 * Acceptance (plan ②/③ from the Phase-3 list):
 * - child destructive command → block + `destructive_command_escalated` audit
 *   + a queued `pendingOwnerApprovals` entry, and the child NEVER opens a
 *   `ui.select` dialog (zero calls — the 217 incident carry-in assumption);
 * - owner settle → the approval menu opens ONCE; choosing
 *   "Allow for this session" writes the EXISTING `sessionAllowedCommands`,
 *   audits `destructive_command_approved`, and clears the queue;
 * - "Deny (block)" audits `destructive_command_denied` and clears the queue
 *   WITHOUT writing the allowlist.
 */
import { describe, it, expect, afterEach } from "bun:test";
import { createToolGuard } from "../../core/tool-guard";
import { createAgentSettled } from "../../core/agent-settled";
import { createMockCtx } from "../helpers";
import { makeTestConfig, makeTestMeta } from "../helpers";
import { mkdir, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initAuditLog, __resetAuditDirPath, __resetAuditRoutingState } from "../../utils/auditLog";
import { auditLogFileFor } from "../helpers";
import { resetGitignoreCache } from "../../utils/gitignore";
import { commandFingerprint as key } from "../../core/owner-approval";
import type { SessionMeta } from "../../types";

describe("217 T3.3: child destructive command escalates (real tool-guard)", () => {
  let root: string;

  afterEach(async () => {
    
    __resetAuditRoutingState();
    __resetAuditDirPath();
    resetGitignoreCache();
    if (root) await rm(root, { recursive: true, force: true });
  });

  it("block + escalated audit + queue entry; protect.ask dialog NEVER reached", async () => {
    root = join(tmpdir(), "pi-217-escal-" + Date.now());
    await mkdir(join(root, ".pi", "audit"), { recursive: true });
    const config = makeTestConfig({ projectRoot: root, protect: { ask: true } });
    await initAuditLog(config);

    const meta = makeTestMeta({ currentStage: "fix", pipelineId: "pipe-217-escal" });
    // CHILD ctx: parent header + executor sessionName (171 detection shape).
    const ctx = createMockCtx(meta, {
      sessionHeader: { parentSession: "/sessions/owner.jsonl" },
      sessionName: "fix-executor#a1b2c3d4",
    });
    const selectCalls: string[] = [];
    ctx.ui.select = async (message: string) => {
      selectCalls.push(message);
      return "Allow for this session";
    };
    ctx.toolCall = { name: "bash", arguments: { command: "rm -rf /" } };

    const result = await createToolGuard(config).handler(ctx as never) as { block?: boolean; reason?: string };

    // Fail-closed (block) with an escalation-aware reason.
    expect(result?.block).toBe(true);
    expect(String(result?.reason)).toContain("Submitted to the owner session for approval");
    // Zero select invocations on the child path — the host does NOT inherit
    // the owner's dialog.
    expect(selectCalls).toHaveLength(0);
    // The approval is queued for the owner, keyed by fingerprint.
    expect(meta.pendingOwnerApprovals && Object.keys(meta.pendingOwnerApprovals)).toHaveLength(1);
    const [entry] = Object.values(meta.pendingOwnerApprovals ?? {});
    expect(entry).toMatchObject({ command: "rm -rf /", stage: "fix", attempts: 0 });
    // Audit trail (disk).
    const logContent = await readFile(
      auditLogFileFor(join(root, ".pi", "audit")),
      "utf-8",
    );
    expect(logContent).toContain("destructive_command_escalated");
    // In-flight dialog host check: protect.ask would have opened a THREE-way
    // protect dialog; with escalation it must not even try (no dialog audit).
    expect(meta.violations ?? []).toHaveLength(0);
  });
});

describe("217 T3.4: owner settle consumes the approval (real agent-settled)", () => {
  let root: string;

  afterEach(async () => {
    
    __resetAuditRoutingState();
    __resetAuditDirPath();
    resetGitignoreCache();
    if (root) await rm(root, { recursive: true, force: true });
  });

  it("approve → sessionAllowedCommands written, queue cleared", async () => {
    root = join(tmpdir(), "pi-217-appr-" + Date.now());
    await mkdir(join(root, ".pi", "audit"), { recursive: true });
    const config = makeTestConfig({ projectRoot: root });
    await initAuditLog(config);

    const meta = makeTestMeta({ currentStage: "fix", pipelineId: "pipe-217-appr" });
    const session = {
      getMeta: () => meta,
      updateMeta: (patch: Partial<SessionMeta>) => { Object.assign(meta, patch); return meta; },
    };
    session.updateMeta({
      pendingOwnerApprovals: {
        [key("rm -rf /")]: {
          command: "rm -rf /",
          stage: "fix",
          requestedAt: Date.now(),
          attempts: 0,
        },
      },
    });

    const ownerCtx = createMockCtx(meta);
    const selectCalls: string[] = [];
    ownerCtx.ui.select = async (message: string, _options: string[]) => {
      selectCalls.push(message);
      return "Allow for this session";
    };

    // Real owner settle; post-consume machinery is fail-safe (try/catch) —
    // the assertion targets the approval outcome, not the full settle chain.
    await createAgentSettled(config).handler(ownerCtx as never);

    expect(selectCalls).toHaveLength(1);
    expect(meta.sessionAllowedCommands).toContain("rm -rf /");
    expect(meta.pendingOwnerApprovals).toStrictEqual({});
  });

  it("deny → allowlist untouched, queue cleared", async () => {
    root = join(tmpdir(), "pi-217-deny-" + Date.now());
    await mkdir(join(root, ".pi", "audit"), { recursive: true });
    const config = makeTestConfig({ projectRoot: root });
    await initAuditLog(config);

    const meta = makeTestMeta({ currentStage: "fix", pipelineId: "pipe-217-deny" });
    const session = {
      getMeta: () => meta,
      updateMeta: (patch: Partial<SessionMeta>) => { Object.assign(meta, patch); return meta; },
    };
    session.updateMeta({
      pendingOwnerApprovals: {
        [key("rm -rf /")]: {
          command: "rm -rf /",
          stage: "fix",
          requestedAt: Date.now(),
          attempts: 0,
        },
      },
    });

    const ownerCtx = createMockCtx(meta);
    const selectCalls: string[] = [];
    ownerCtx.ui.select = async (message: string) => {
      selectCalls.push(message);
      return "Deny (block)";
    };

    await createAgentSettled(config).handler(ownerCtx as never);

    expect(selectCalls).toHaveLength(1);
    expect(meta.sessionAllowedCommands ?? []).not.toContain("rm -rf /");
    expect(meta.pendingOwnerApprovals).toStrictEqual({});
  });
});
