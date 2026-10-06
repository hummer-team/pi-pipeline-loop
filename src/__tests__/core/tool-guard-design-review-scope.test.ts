/**
 * 192 fix (issue 4, plan Phase 4 task 9): design-review scope enforcement
 * at the REAL guard level, closing the gaps the 191 interception surface
 * left open:
 *
 * - rename/delete BOTH-END per-arg: every operand of `rm a b` / `mv a b`
 *   goes through the canonical scope check (the old extractor checked only
 *   the first operand of rm, leaving later delete targets unvalidated);
 * - SOURCE and REAL TARGET both verified: a lexical in-scope path that
 *   resolves OUTSIDE the project root (symlink escape) FAILS CLOSED —
 *   never a fallback to the lexical path;
 * - git default block is landed explicitly: the built-in matrix declares
 *   design-review = "block", and the guard blocks git write commands while
 *   the design-review stage is active.
 *
 * No mock.module(): controlled temp roots + createMockCtx harness.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { PipelineConfig, SessionMeta } from "../../types";
import { createToolGuard } from "../../core/tool-guard";
import { makeTestConfig, makeTestMeta, createMockCtx } from "../helpers";
import { createInitialState, computeHash } from "../../core/design-review/state";
import { resolveGitModifyPolicy, describeGitModifySource } from "../../utils/protect";

describe("192 issue-4: design-review guard scope (rename/delete two-end + git default block)", () => {
  let projectRoot: string;
  let outsideRoot: string;
  let planDoc: string;
  let reportDoc: string;
  let planHash: string;

  beforeEach(() => {
    projectRoot = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "dr-guard-scope-"));
    outsideRoot = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "dr-guard-outside-"));
    fs.mkdirSync(path.join(projectRoot, "docs"), { recursive: true });
    planDoc = path.join(projectRoot, "docs", "plan.md");
    reportDoc = path.join(projectRoot, "docs", "review-design-1-plan.md");
    fs.writeFileSync(planDoc, "# Plan\nv1\n", "utf-8");
    planHash = computeHash(fs.readFileSync(planDoc, "utf-8"));
  });

  afterEach(() => {
    fs.rmSync(projectRoot, { recursive: true, force: true });
    fs.rmSync(outsideRoot, { recursive: true, force: true });
  });

  /** Session meta with an ACTIVE review operation (write scope: report only). */
  function reviewOpMeta(): SessionMeta {
    const base = createInitialState(planDoc, "menu", planHash, undefined, {
      pipelineId: "pipe-test-001",
    });
    const now = Date.now();
    return makeTestMeta({
      currentStage: "design-review",
      requirementDoc: "docs/req.md",
      designReview: {
        ...base,
        phase: "review_running",
        round: 1,
        reportDoc,
        operation: {
          operationId: "op-guard-scope-1",
          kind: "review",
          stageVisitId: now,
          attempt: 1,
          dispatchState: "dispatched",
          agentId: "agent-guard",
          inputHash: planHash,
          round: 1,
          createdAt: now,
          updatedAt: now,
        },
      },
    });
  }

  function runGuard(config: PipelineConfig, meta: SessionMeta, toolName: string, args: Record<string, unknown>) {
    const ctx = createMockCtx(meta);
    ctx.toolCall = { name: toolName, arguments: args };
    const hook = createToolGuard(config);
    return { ctx, result: hook.handler(ctx as never) as Promise<{ block?: boolean; reason?: string } | undefined> };
  }

  // ─── rename/delete BOTH-END per-arg ────────────────────────────────────────

  it("bash rm of an in-scope report PLUS an out-of-scope operand: blocked on the SECOND operand", async () => {
    fs.writeFileSync(reportDoc, "report", "utf-8");
    const config = makeTestConfig({ projectRoot });
    const { ctx, result } = runGuard(
      config,
      reviewOpMeta(),
      "bash",
      { command: `rm docs/review-design-1-plan.md docs/plan.md` },
    );
    const res = await result;
    // The OLD extractor only checked the first operand → this command passed.
    expect(res?.block).toBe(true);
    expect(res?.reason).toContain("design-review dynamic write scope");
    const violations = ((ctx.session.getMeta() as SessionMeta).violations ?? []);
    expect(violations.some((v) => v.tool === "bash" && v.type === "write_protected")).toBe(true);
  });

  it("bash mv from an out-of-scope SOURCE into the in-scope report: blocked (source end checked)", async () => {
    fs.writeFileSync(reportDoc, "report", "utf-8");
    const evil = path.join(projectRoot, "docs", "evil.md");
    fs.writeFileSync(evil, "x", "utf-8");
    const config = makeTestConfig({ projectRoot });
    const res = await runGuard(config, reviewOpMeta(), "bash", {
      command: `mv docs/evil.md docs/review-design-1-plan.md`,
    }).result;
    expect(res?.block).toBe(true);
    expect(res?.reason).toContain("design-review dynamic write scope");
  });

  it("bash mv INTO an out-of-scope DESTINATION from the in-scope report: blocked (destination end checked)", async () => {
    fs.writeFileSync(reportDoc, "report", "utf-8");
    const config = makeTestConfig({ projectRoot });
    const res = await runGuard(config, reviewOpMeta(), "bash", {
      command: `mv docs/review-design-1-plan.md docs/plan.md`,
    }).result;
    expect(res?.block).toBe(true);
    expect(res?.reason).toContain("design-review dynamic write scope");
  });

  it("bash rm targeting ONLY the in-scope report passes the scope gate", async () => {
    fs.writeFileSync(reportDoc, "report", "utf-8");
    const config = makeTestConfig({ projectRoot });
    const res = await runGuard(config, reviewOpMeta(), "bash", {
      command: `rm docs/review-design-1-plan.md`,
    }).result;
    // In-scope target must NOT be blocked by the design-review scope check
    // (it may still pass through the ordinary protection chain — here it is
    // an unprotected path, so the guard lets it through).
    expect(res?.block).toBeUndefined();
  });

  // ─── SOURCE and REAL TARGET both verified (symlink escape fail-closed) ─────

  it("write to an in-scope path that is a symlink OUTSIDE the root: FAIL-CLOSED block", async () => {
    const outsideTarget = path.join(outsideRoot, "stolen.md");
    fs.writeFileSync(outsideTarget, "existing", "utf-8");
    // The REPORT path itself is a symlink escaping the project root: the
    // lexical source matches scope, the real target escapes — the old code
    // fell back to the lexical path and ALLOWED the escape.
    fs.symlinkSync(outsideTarget, reportDoc, "file");
    const config = makeTestConfig({ projectRoot });
    const res = await runGuard(config, reviewOpMeta(), "write", {
      file_path: reportDoc,
      content: "escape attempt",
    }).result;
    expect(res?.block).toBe(true);
    expect(res?.reason).toContain("outside design-review dynamic write scope");
  });

  it("bash write through a symlinked PARENT dir escaping the root: FAIL-CLOSED block", async () => {
    const linkedDir = path.join(projectRoot, "docs", "linked");
    fs.symlinkSync(outsideRoot, linkedDir, "dir");
    fs.writeFileSync(reportDoc, "report", "utf-8");
    const config = makeTestConfig({ projectRoot });
    // Source name is under linked/ (in project lexically), real target is in
    // the OUTSIDE directory → resolvedRelPath non-null? It resolves outside
    // root → null → fail closed.
    const res = await runGuard(config, reviewOpMeta(), "bash", {
      command: `touch docs/linked/review-design-1-plan.md`,
    }).result;
    expect(res?.block).toBe(true);
  });

  // ─── git default block landed in the actual guard ──────────────────────────

  it("built-in matrix declares design-review git writes BLOCK by default", () => {
    const config = makeTestConfig();
    expect(resolveGitModifyPolicy(config, null, "design-review")).toBe("block");
    expect(describeGitModifySource(config, "design-review")).toBe("matrix-default");
  });

  it("bash git commit while the design-review stage is active: blocked by the guard", async () => {
    const config = makeTestConfig({ projectRoot });
    const { ctx, result } = runGuard(config, makeTestMeta({ currentStage: "design-review" }), "bash", {
      command: `git commit -m "design review changes"`,
    });
    const res = await result;
    expect(res?.block).toBe(true);
    expect(res?.reason).toContain("git write command blocked in stage 'design-review'");
    expect(res?.reason).toContain("matrix default");
    const violations = ((ctx.session.getMeta() as SessionMeta).violations ?? []);
    expect(violations.some((v) => v.type === "git_protected")).toBe(true);
  });

  it("bash git status (read-only) while design-review is active: not blocked", async () => {
    const config = makeTestConfig({ projectRoot });
    const res = await runGuard(config, makeTestMeta({ currentStage: "design-review" }), "bash", {
      command: `git status`,
    }).result;
    expect(res?.block).toBeUndefined();
  });
});
