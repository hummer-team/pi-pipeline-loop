/**
 * 226 Phase 3 — the pipeline-turn detector (`isBarePipelineTurn`) through the
 * REAL `agent_settled` settle seam.
 *
 * Covered acceptance items (plan §Phase 3, four-state matrix):
 * - auto (`!!meta.autoJob`): the plugin's self-dispatched prompt
 *   `docs/x.md 1\n\n[auto-pipeline] … / Pipeline: <id>` is a pipeline turn —
 *   the trailing suffix must not demote its own turn to ordinary chat;
 * - the three HUMAN states stay BYTE-IDENTICAL to the pre-change strict regex:
 *   `docs/x.md 2 答\n\n…` → turn, `docs/x.md full-und?\n\n…` → turn,
 *   `docs/x.md 1\n\n…` (bare round number + prose) → ordinary chat;
 * - a message whose head belongs to an UNBOUND (different) doc never matches.
 *
 * The verdict is the OBSERVABLE audit split of the source gate:
 * `agent_settled_non_pipeline_turn` (rejected) vs the settle continuing
 * (`agent_settled_bare_turn_matched` is written by the bare-form branch;
 * a static-signature turn continues without a gate audit row). Detection is
 * exercised EXACTLY like production: the extraction reads the LAST USER
 * message from the session branch entries.
 */
import { describe, it, expect, afterEach } from "bun:test";
import * as fs from "node:fs";
import { join } from "node:path";
import { createAgentSettled } from "../../core/agent-settled";
import { makeTestConfig, makeTestMeta, createMockCtx, auditLogFileFor, type MockRuntimeCtx } from "../helpers";
import { initAuditLog, __resetAuditRoutingState } from "../../utils/auditLog";
import type { PipelineConfig, SessionMeta } from "../../types";

/**
 * The plugin self-dispatched prompt shape: `<doc> <args>` followed by an
 * instruction block and the `Pipeline: <id>` marker (subagent-rpc
 * `appendPipelineIdMarker` shape).
 */
function selfDispatchMessage(doc: string, args: string, pipelineId: string): string {
  return `${doc} ${args}\n\n[auto-pipeline] This run is unattended — no human will answer.\nPipeline: ${pipelineId}`;
}

type Verdict = "turn" | "chat";

/** Run ONE settle with the given LAST USER message, classify the turn. */
async function classifyTurn(
  lastUserMessage: string,
  overrides: Partial<SessionMeta> = {},
): Promise<Verdict> {
  const config: PipelineConfig = makeTestConfig();
  await initAuditLog(config);
  const meta = makeTestMeta({
    currentStage: "clarify",
    requirementDoc: "docs/design/x.md",
    ...overrides,
  } as Partial<SessionMeta>);
  const ctx = createMockCtx(meta, {}) as unknown as MockRuntimeCtx;
  // The bare-turn detector reads the LAST USER message from the session branch.
  (ctx as unknown as { _ctx: { sessionManager: Record<string, unknown> } })._ctx.sessionManager.getBranch =
    () =>
      [
        {
          type: "message",
          message: { role: "user", content: lastUserMessage },
        },
      ] as never;

  const hook = createAgentSettled(config);
  await hook.handler(ctx as never);

  const auditPath = auditLogFileFor(join(String(config.projectRoot), ".pi", "audit"), meta.pipelineId);
  const auditContent = fs.readFileSync(auditPath, "utf8");
  const bareMatched = auditContent.includes("agent_settled_bare_turn_matched");
  const nonPipeline = auditContent.includes("agent_settled_non_pipeline_turn");
  // A static-signature turn is never gate-audited; the settle continues with
  // only the base `agent_settled` row. Bare-form turns audit the match row.
  return bareMatched ? "turn" : nonPipeline ? "chat" : "turn";
}

describe("226 Phase 3: bare-form pipeline-turn — the four-state matrix", () => {
  const DOC = "docs/design/x.md";
  const AUTO_JOB = {
    jobId: "alpha_loop",
    jobPath: "docs/jobs/alpha_loop.yaml",
    docIndex: 0,
    totalDocs: 1,
    designReviewMaxRounds: 3,
    designReviewRounds: 0,
  };

  it("auto: self-dispatched round-1 prompt with the Pipeline marker → turn", async () => {
    const verdict = await classifyTurn(selfDispatchMessage(DOC, "1", "pipe-226-auto"), {
      autoJob: AUTO_JOB as never,
    });
    expect(verdict).toBe("turn");
  });

  it("human: '2 答' followed by prose → turn (strict, byte-identical)", async () => {
    const verdict = await classifyTurn(`${DOC} 2 答\n\nSure, working on it.`);
    expect(verdict).toBe("turn");
  });

  it("human: 'full-und?' followed by prose → turn (strict, byte-identical)", async () => {
    const verdict = await classifyTurn(`${DOC} full-und?\n\nfinalising now`);
    expect(verdict).toBe("turn");
  });

  it("human: bare '1' followed by prose → ordinary chat (strict keeps the historical reading)", async () => {
    const verdict = await classifyTurn(`${DOC} 1\n\nsome ordinary chat text`);
    expect(verdict).toBe("chat");
  });

  it("auto: bare '1' followed by prose becomes a turn ONLY for auto jobs (relaxed)", async () => {
    const verdict = await classifyTurn(`${DOC} 1\n\nsome ordinary chat text`, {
      autoJob: AUTO_JOB as never,
    });
    expect(verdict).toBe("turn");
  });

  it("unbound document (different doc head) → never a pipeline turn", async () => {
    const verdict = await classifyTurn("docs/design/other.md 2 答\n\nprose");
    expect(verdict).toBe("chat");
  });

  it("unbound requirementDoc → fail-open to non-pipeline", async () => {
    const verdict = await classifyTurn("docs/design/other.md 2 答", {
      requirementDoc: undefined,
    } as Partial<SessionMeta>);
    expect(verdict).toBe("chat");
  });
});

afterEach(() => {
  __resetAuditRoutingState();
});
