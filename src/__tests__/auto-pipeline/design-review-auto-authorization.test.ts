/**
 * 219 Phase 3 (G3 / B3): design-review entry authorisation on the auto channel.
 *
 * Key behaviors:
 * - The auto channel skips ONLY Step 3 (TUI detection) and Step 4
 *   (`ui.confirm`); Step 1 (child rejection) and Step 2 (prerequisite
 *   validation) stay verbatim.
 * - A host without any `ui.confirm` can authorise an auto job
 *   (`result: "authorised_auto"`, `source: "auto_pipeline"`).
 * - Without the opts the same host still fails `tui_unavailable` — proving the
 *   channel is opt-in and that the call sites must pass it (B3).
 * - `HumanDecision.source` is untouched (this is a gate answer, not a
 *   fabricated human decision).
 */
import { describe, it, expect, beforeEach, afterEach, spyOn } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";
import type { PipelineConfig, SessionMeta } from "../../types";
import type { RuntimeCtx } from "../../core/runtime-ctx";
import { designReviewAuthorisationGate } from "../../core/design-review/authorization";
import { __setSafeWriteAuditLogOverride } from "../../utils/auditLog";

const SRC_ROOT = path.resolve(__dirname, "..", "..", "..");

let ROOT: string;
let audits: Array<{ stage: string; message: Record<string, unknown> }>;
let errorSpy: ReturnType<typeof spyOn>;
let config: PipelineConfig;
let meta: SessionMeta;

function makeCtx(overrides?: { header?: () => Record<string, unknown>; ui?: Record<string, unknown> }): RuntimeCtx {
  const header = overrides?.header ?? (() => ({ type: "session", id: "session-owner", cwd: ROOT }));
  return {
    session: {
      getMeta: () => meta,
      updateMeta: () => undefined,
      getBranch: () => [],
      getEntries: () => [],
      getHeader: header,
      getSessionName: () => "owner-session",
    },
    ui: overrides?.ui ?? {},
    _ctx: {
      sessionManager: {
        getBranch: () => [],
        getEntries: () => [],
        getHeader: header,
        getSessionName: () => "owner-session",
      },
    },
  } as unknown as RuntimeCtx;
}

beforeEach(() => {
  ROOT = fs.mkdtempSync(path.join(tmpdir(), "pi-219-dr-auth-"));
  fs.writeFileSync(path.join(ROOT, "requirements.md"), "# Requirements\n\nTest requirements", "utf8");
  fs.writeFileSync(path.join(ROOT, "requirements_Plan.md"), "# Plan\n\nTest plan content", "utf8");

  audits = [];
  errorSpy = spyOn(console, "error").mockImplementation(() => undefined);
  __setSafeWriteAuditLogOverride(async (stage, message) => {
    audits.push({ stage, message: (message ?? {}) as Record<string, unknown> });
  });

  config = {
    projectRoot: ROOT,
    stages: {
      "design-review": {
        agentPath: ".pi/agents/design-review-agent.md",
        skillPath: "design-review/SKILL.md",
        nextStage: "develop",
      },
    },
  } as unknown as PipelineConfig;

  meta = {
    requirementDoc: "requirements.md",
    pipelineId: "pipe-auto-1",
    currentStage: "plan",
  } as unknown as SessionMeta;
});

afterEach(() => {
  __setSafeWriteAuditLogOverride(null);
  errorSpy.mockRestore();
  fs.rmSync(ROOT, { recursive: true, force: true });
});

describe("design-review auto authorisation — auto channel", () => {
  it("authorises on a host without any TUI and audits authorised_auto", async () => {
    const result = await designReviewAuthorisationGate(makeCtx(), config, meta, {
      autoPipeline: { jobId: "alpha" },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.state.authorizationId.length).toBeGreaterThan(0);

    const row = audits.find((a) => a.stage === "design_review_authorisation_gate" && a.message.result === "authorised_auto");
    expect(row).toBeDefined();
    expect(row?.message.source).toBe("auto_pipeline");
    expect(row?.message.jobId).toBe("alpha");
  });

  it("is opt-in: the same UI-less host still fails with tui_unavailable (B3)", async () => {
    const result = await designReviewAuthorisationGate(makeCtx(), config, meta);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("tui_unavailable");
  });

  it("still rejects child sessions (Step 1 is never skipped)", async () => {
    const ctx = makeCtx({
      header: () => ({
        type: "session",
        id: "session-child",
        cwd: ROOT,
        parentSession: "parent-owner",
      }),
    });
    const result = await designReviewAuthorisationGate(ctx, config, meta, {
      autoPipeline: { jobId: "alpha" },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("child_session_cannot_authorise");
    expect(audits.some((a) => a.message.result === "rejected_child_session")).toBe(true);
  });

  it("still rejects missing prerequisites (Step 2 is never skipped)", async () => {
    meta = { ...meta, requirementDoc: undefined } as unknown as SessionMeta;
    const noDoc = await designReviewAuthorisationGate(makeCtx(), config, meta, {
      autoPipeline: { jobId: "alpha" },
    });
    expect(noDoc.ok).toBe(false);
    if (!noDoc.ok) expect(noDoc.reason).toBe("requirement_doc_missing");

    meta = { ...meta, requirementDoc: "requirements.md" } as unknown as SessionMeta;
    fs.rmSync(path.join(ROOT, "requirements_Plan.md"));
    const noPlan = await designReviewAuthorisationGate(makeCtx(), config, meta, {
      autoPipeline: { jobId: "alpha" },
    });
    expect(noPlan.ok).toBe(false);
    if (!noPlan.ok) expect(noPlan.reason).toBe("plan_doc_missing");
  });
});

describe("design-review auto authorisation — human path unchanged", () => {
  it("human host + no opts still shows the confirm dialog", async () => {
    let confirmed = 0;
    const ctx = makeCtx({
      ui: {
        select: async () => "x",
        confirm: async () => {
          confirmed += 1;
          return true;
        },
      },
    });
    const result = await designReviewAuthorisationGate(ctx, config, meta);
    expect(result.ok).toBe(true);
    expect(confirmed).toBe(1);
    // Human authorisation is never tagged as the auto channel.
    expect(audits.some((a) => a.message.result === "authorised_auto")).toBe(false);
  });

  it("a human cancel still denies", async () => {
    const ctx = makeCtx({ ui: { select: async () => "x", confirm: async () => false } });
    const result = await designReviewAuthorisationGate(ctx, config, meta);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("user_cancelled");
  });
});

describe("design-review auto authorisation — B3 wiring", () => {
  it("BOTH production call sites pass autoPipelineAuthOpts()", () => {
    for (const rel of ["src/core/flow-state.ts", "src/commands/pipeline-resume-menu.ts"]) {
      const text = fs.readFileSync(path.join(SRC_ROOT, rel), "utf8");
      expect(text).toContain("designReviewAuthorisationGate(");
      expect(text).toContain("autoPipelineAuthOpts()");
    }
  });
});
