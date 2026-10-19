import { describe, it, expect } from "bun:test";
import { mkdir, writeFile, readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildPlanDocFeedback } from "../../core/plan-doc-feedback";
import { applyVerifyFail } from "../../core/verify-advance";
import { planDocRelPathFromRequirementDoc } from "../../core/naming/doc-naming";
import { makeTestConfig, makeTestMeta, auditLogFileFor } from "../helpers";
import { initAuditLog, setAuditPipelineContext } from "../../utils/auditLog";
import { createPipelineUI } from "../../core/pipeline-ui";
import type { SessionMeta, VerifyFailureItem } from "../../types";

const REQ = "docs/design/204_Bug.md";
const EXPECTED = "docs/design/204_Bug_Plan.md";

function fail(ruleType: string, detail = "Missing files: docs/design/204_Bug_Plan.md"): VerifyFailureItem {
  return { ruleType, detail, timestamp: Date.now() };
}

async function makeRoot(name: string): Promise<string> {
  const dir = join(tmpdir(), `pi-plan-feedback-${name}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  await mkdir(dir, { recursive: true });
  return dir;
}

/** Concatenates every audit file under `<root>/.pi/audit` (path-shape agnostic). */
async function allAuditText(root: string): Promise<string> {
  const base = join(root, ".pi", "audit");
  let rel: string[];
  try {
    rel = await readdir(base, { recursive: true }) as string[];
  } catch {
    return "";
  }
  const parts: string[] = [];
  for (const relPath of rel) {
    try {
      parts.push(await readFile(join(base, relPath), "utf-8"));
    } catch {
      // directory entry
    }
  }
  return parts.join("\n");
}

function meta(overrides: Record<string, unknown> = {}): SessionMeta {
  return makeTestMeta({ currentStage: "plan", requirementDoc: REQ, ...overrides });
}

describe("204 Phase 3: buildPlanDocFeedback", () => {
  it("surfaces an existing near-name candidate plus the expected path", async () => {
    const TMP = await makeRoot("candidate");
    await mkdir(join(TMP, "docs", "design"), { recursive: true });
    await writeFile(join(TMP, "docs", "design", "12_Feat_x_fix_plan.md"), "# stale plan");

    const res = await buildPlanDocFeedback({
      config: makeTestConfig({ projectRoot: TMP }),
      meta: meta(),
      stageName: "plan",
      failures: [fail("requiredFile")],
    });

    expect(res).not.toBeNull();
    expect(res!.candidates).toEqual(["docs/design/12_Feat_x_fix_plan.md"]);
    expect(res!.message).toContain(EXPECTED);
    expect(res!.message).toContain("docs/design/12_Feat_x_fix_plan.md");
    expect(res!.message).toContain("Found non-conforming candidate(s)");

    await rm(TMP, { recursive: true, force: true });
  });

  it("says no plan-like document was found when the directory has none", async () => {
    const TMP = await makeRoot("none");
    await mkdir(join(TMP, "docs", "design"), { recursive: true });
    await writeFile(join(TMP, "docs", "design", "204_Bug.md"), "# requirement");

    const res = await buildPlanDocFeedback({
      config: makeTestConfig({ projectRoot: TMP }),
      meta: meta(),
      stageName: "plan",
      failures: [fail("requiredFiles")],
    });

    expect(res!.candidates).toEqual([]);
    expect(res!.message).toContain("No plan-like document found");
    expect(res!.message).toContain(EXPECTED);

    await rm(TMP, { recursive: true, force: true });
  });

  it("does not fire outside plan / without requirementDoc / on unrelated rule types", async () => {
    const TMP = await makeRoot("nofire");
    const config = makeTestConfig({ projectRoot: TMP });

    expect(await buildPlanDocFeedback({ config, meta: meta(), stageName: "develop", failures: [fail("requiredFile")] })).toBeNull();
    expect(await buildPlanDocFeedback({ config, meta: meta({ requirementDoc: undefined }), stageName: "plan", failures: [fail("requiredFile")] })).toBeNull();
    expect(await buildPlanDocFeedback({ config, meta: meta(), stageName: "plan", failures: [fail("keywords"), fail("requiredCommand")] })).toBeNull();

    await rm(TMP, { recursive: true, force: true });
  });

  it("degrades to null without config and fail-opens on a missing directory", async () => {
    expect(await buildPlanDocFeedback({ meta: meta(), stageName: "plan", failures: [fail("requiredFile")] })).toBeNull();

    const TMP = await makeRoot("nodir");
    const res = await buildPlanDocFeedback({
      config: makeTestConfig({ projectRoot: TMP }),
      meta: meta(),
      stageName: "plan",
      failures: [fail("fileContentPattern")],
    });
    expect(res!.candidates).toEqual([]);
    expect(res!.message).toContain(EXPECTED);

    await rm(TMP, { recursive: true, force: true });
  });

  it("ranks this requirement's family first and labels other requirements' plan docs (review issue 4)", async () => {
    const TMP = await makeRoot("foreign");
    const dir = join(TMP, "docs", "design");
    await mkdir(dir, { recursive: true });
    // Other requirements' plan docs (must never be renamed/overwritten).
    await writeFile(join(dir, "201_Feat_plan.md"), "# other");
    await writeFile(join(dir, "201_Feat_plan_commit.md"), "# other");
    await writeFile(join(dir, "203_Bug_Plan.md"), "# other");
    // This requirement's near-name candidate.
    await writeFile(join(dir, "204_Bug_plan_draft.md"), "# mine");

    const res = await buildPlanDocFeedback({
      config: makeTestConfig({ projectRoot: TMP }),
      meta: meta(),
      stageName: "plan",
      failures: [fail("requiredFile")],
    });

    expect(res).not.toBeNull();
    // reqBase family is ranked first even though "201_..." sorts earlier.
    expect(res!.candidates[0]).toBe("docs/design/204_Bug_plan_draft.md");
    expect(res!.candidates).toEqual([
      "docs/design/204_Bug_plan_draft.md",
      "docs/design/201_Feat_plan.md",
      "docs/design/201_Feat_plan_commit.md",
      "docs/design/203_Bug_Plan.md",
    ]);
    // ...and the foreign ones are explicitly flagged as off-limits.
    expect(res!.message).toContain("never rename, move or overwrite them");
    expect(res!.message).toContain("docs/design/201_Feat_plan.md");
    expect(res!.message).not.toContain("never rename, move or overwrite them: docs/design/204_Bug_plan_draft.md");
    expect(res!.scanFailed).toBe(false);

    await rm(TMP, { recursive: true, force: true });
  });

  it("treats a case-mixed sibling as this requirement's own doc, not a foreign one (review issue 1)", async () => {
    // Repo reality: `_plan.md` / `_Plan.md` casings are both in use. With a bare
    // case-sensitive `includes(reqBase)` test the ONLY candidate on disk is
    // reported as "belongs to OTHER requirement(s) — never rename" AND asked to
    // be renamed, so the model would create a second plan document.
    const TMP = await makeRoot("case-mixed");
    const dir = join(TMP, "docs", "design");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "204_bug_Plan.md"), "# mine, wrong casing");

    const res = await buildPlanDocFeedback({
      config: makeTestConfig({ projectRoot: TMP }),
      meta: meta(),
      stageName: "plan",
      failures: [fail("requiredFile")],
    });

    expect(res!.candidates).toEqual(["docs/design/204_bug_Plan.md"]);
    // Ranked as our own family (first) and therefore NOT labelled off-limits.
    expect(res!.message).not.toContain("never rename, move or overwrite");

    await rm(TMP, { recursive: true, force: true });
  });

  it("does not absorb a near-index foreign doc as this requirement's family (review issue 2)", async () => {
    // `1204_Bugfix` contains "204_Bug" as a bare substring; an unanchored test
    // would rank it 0 and drop its off-limits label, exposing another
    // requirement's document to a rename.
    const TMP = await makeRoot("near-index");
    const dir = join(TMP, "docs", "design");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "1204_Bugfix_Plan.md"), "# other requirement");
    await writeFile(join(dir, "204_Bug_plan_draft.md"), "# mine");

    const res = await buildPlanDocFeedback({
      config: makeTestConfig({ projectRoot: TMP }),
      meta: meta(),
      stageName: "plan",
      failures: [fail("requiredFile")],
    });

    // Own family first (rank 0), the near-index foreign doc last (rank 2)...
    expect(res!.candidates).toEqual([
      "docs/design/204_Bug_plan_draft.md",
      "docs/design/1204_Bugfix_Plan.md",
    ]);
    // ...and it IS flagged off-limits.
    expect(res!.message).toContain(
      "never rename, move or overwrite them: docs/design/1204_Bugfix_Plan.md",
    );

    await rm(TMP, { recursive: true, force: true });
  });

  it("never offers this requirement's own commit doc as a rename candidate (review issue 1)", async () => {
    // `{reqBase}_plan_commit.md` is the Phase-1 deliverable that records the
    // commit ids and is NOT regenerable. It satisfies "contains 'plan' and is
    // not the expected name", and the reqBase-family rank would put it FIRST —
    // so a bare candidate list makes the model `git mv` it onto the plan path.
    const TMP = await makeRoot("own-commit");
    const dir = join(TMP, "docs", "design");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "204_Bug_Plan_commit.md"), "# commit ids");

    const res = await buildPlanDocFeedback({
      config: makeTestConfig({ projectRoot: TMP }),
      meta: meta(),
      stageName: "plan",
      failures: [fail("requiredFile")],
    });

    expect(res).not.toBeNull();
    // Excluded from the rename candidates...
    expect(res!.candidates).toEqual([]);
    expect(res!.message).not.toContain("Found non-conforming candidate(s)");
    // ...and reported on its own "keep it" line instead.
    expect(res!.message).toContain("This requirement's OWN commit doc is NOT the plan doc — KEEP it");
    expect(res!.message).toContain("docs/design/204_Bug_Plan_commit.md");
    // The plan doc genuinely does not exist yet.
    expect(res!.message).toContain("No plan-like document found");

    await rm(TMP, { recursive: true, force: true });
  });

  it("keeps the real plan draft first when the own commit doc is also on disk (review issue 1)", async () => {
    const TMP = await makeRoot("own-commit-plus-draft");
    const dir = join(TMP, "docs", "design");
    await mkdir(dir, { recursive: true });
    // Same reqBase family, but a "`P`" (80) < "`p`" (112) code-unit order would
    // put the commit doc first and push the real fix target to slot 2.
    await writeFile(join(dir, "204_Bug_Plan_commit.md"), "# commit ids");
    await writeFile(join(dir, "204_Bug_plan_draft.md"), "# mine");
    await writeFile(join(dir, "203_Bug_Plan.md"), "# other");

    const res = await buildPlanDocFeedback({
      config: makeTestConfig({ projectRoot: TMP }),
      meta: meta(),
      stageName: "plan",
      failures: [fail("requiredFile")],
    });

    expect(res!.candidates).toEqual([
      "docs/design/204_Bug_plan_draft.md",
      "docs/design/203_Bug_Plan.md",
    ]);
    expect(res!.message).toContain("KEEP it, never rename, move or overwrite it to docs/design/204_Bug_Plan.md");
    // The commit doc is neither a candidate nor off-limits (it is ours).
    expect(res!.message).not.toContain("never rename, move or overwrite them: docs/design/204_Bug_Plan_commit.md");

    await rm(TMP, { recursive: true, force: true });
  });

  it("distinguishes an unreadable directory from an empty one and audits the failure (review issue 5)", async () => {
    setAuditPipelineContext("");
    const TMP = await makeRoot("unreadable");
    const config = makeTestConfig({ projectRoot: TMP });
    await initAuditLog(config);
    // `docs/design` exists but as a FILE → readdir fails with ENOTDIR, which is
    // "unreadable", not "not created yet".
    await mkdir(join(TMP, "docs"), { recursive: true });
    await writeFile(join(TMP, "docs", "design"), "not a directory");

    const res = await buildPlanDocFeedback({
      config,
      meta: meta({ pipelineId: "pipe-plan-fb-scan" }),
      stageName: "plan",
      failures: [fail("requiredFile")],
    });

    expect(res).not.toBeNull();
    expect(res!.scanFailed).toBe(true);
    expect(res!.candidates).toEqual([]);
    expect(res!.message).toContain("UNREADABLE");
    // The factually wrong claim must NOT be emitted for an unreadable dir.
    expect(res!.message).not.toContain("No plan-like document found");

    const audit = await allAuditText(TMP);
    expect(audit).toContain("plan_doc_feedback_scan_failed");
    expect(audit).toContain("code=ENOTDIR");

    await rm(TMP, { recursive: true, force: true });
  });

  it("treats a not-yet-created directory as empty instead of a scan failure (review issue 5)", async () => {
    const TMP = await makeRoot("missing-dir");
    const res = await buildPlanDocFeedback({
      config: makeTestConfig({ projectRoot: TMP }),
      meta: meta(),
      stageName: "plan",
      failures: [fail("requiredFile")],
    });

    expect(res!.scanFailed).toBe(false);
    expect(res!.message).toContain("No plan-like document found");

    await rm(TMP, { recursive: true, force: true });
  });

  it("reuses the Phase 2 naming single source verbatim", async () => {
    const TMP = await makeRoot("naming");
    const res = await buildPlanDocFeedback({
      config: makeTestConfig({ projectRoot: TMP }),
      meta: meta(),
      stageName: "plan",
      failures: [fail("requiredFile")],
    });
    expect(res!.planDoc).toBe(planDocRelPathFromRequirementDoc(REQ));
    expect(res!.planDoc).toBe(EXPECTED);
    expect(res!.message).toContain("## 用户确认");

    await rm(TMP, { recursive: true, force: true });
  });
});

describe("204 Phase 3: verify-advance integration", () => {
  it("plan requiredFile failure → plan feedback in message/wake + audit, verifyAttempts still +1", async () => {
    setAuditPipelineContext("");
    const TMP = await makeRoot("integration");
    await mkdir(join(TMP, "docs", "design"), { recursive: true });
    await writeFile(join(TMP, "docs", "design", "204_Bug_x_plan_fix.md"), "# stale plan");

    const config = makeTestConfig({ projectRoot: TMP, maxVerifyAttempts: 5 });
    await initAuditLog(config);

    const m = meta({ pipelineId: "pipe-plan-fb-1", verifyAttempts: 0 });
    const updates: SessionMeta[] = [];
    const notifications: string[] = [];
    const wakes: string[] = [];
    const pipelineUI = createPipelineUI(config);

    const ctx = {
      session: {
        getMeta: () => m,
        updateMeta: (patch: SessionMeta) => {
          const merged = { ...m, ...patch } as SessionMeta;
          updates.push(merged);
          Object.assign(m, merged);
          return merged;
        },
        setModel: async () => {},
      },
      ui: {
        notify: (msg: string) => notifications.push(msg),
        setStatus: () => {},
        select: async () => undefined,
      },
      pi: { sendUserMessage: (msg: string) => wakes.push(msg) },
    } as any;

    const result = await applyVerifyFail(
      ctx,
      m,
      "plan",
      {
        passed: false,
        ruleMissing: [],
        structuredResult: { failures: [{ ruleType: "requiredFiles", detail: "Missing files: docs/design/204_Bug_Plan.md" }] },
      } as any,
      "rule",
      pipelineUI,
      config,
    );

    // message + wake text both carry the actionable plan feedback
    expect(result.message).toContain(EXPECTED);
    expect(result.message).toContain("204_Bug_x_plan_fix.md");
    expect(wakes).toHaveLength(1);
    expect(wakes[0]).toContain(EXPECTED);
    expect(wakes[0]).toContain("204_Bug_x_plan_fix.md");

    // TUI label reflects the plan-doc class of failure
    expect(notifications).toContain("[ pipe-plan-fb-1 • plan ] ⚠ plan doc invalid");

    // budget accounting is untouched
    expect(m.verifyAttempts).toBe(1);

    const log = await readFile(auditLogFileFor(join(TMP, ".pi", "audit"), "pipe-plan-fb-1"), "utf-8");
    expect(log).toContain("plan_doc_feedback");
    expect(log).toContain("planDoc=docs/design/204_Bug_Plan.md");

    await rm(TMP, { recursive: true, force: true });
  });

  it("generic verify failure still uses the legacy text and label", async () => {
    setAuditPipelineContext("");
    const TMP = await makeRoot("generic");
    const config = makeTestConfig({ projectRoot: TMP, maxVerifyAttempts: 5 });
    await initAuditLog(config);

    const m = meta({ pipelineId: "pipe-plan-fb-2", verifyAttempts: 0 });
    const notifications: string[] = [];
    const pipelineUI = createPipelineUI(config);
    const ctx = {
      session: {
        getMeta: () => m,
        updateMeta: (patch: SessionMeta) => Object.assign(m, patch),
        setModel: async () => {},
      },
      ui: { notify: (msg: string) => notifications.push(msg), setStatus: () => {}, select: async () => undefined },
      pi: { sendUserMessage: () => {} },
    } as any;

    const result = await applyVerifyFail(
      ctx,
      m,
      "plan",
      {
        passed: false,
        ruleMissing: [],
        structuredResult: { failures: [{ ruleType: "keywords", detail: "Missing keywords: x" }] },
      } as any,
      "tool",
      pipelineUI,
      config,
    );

    expect(result.message).toContain("strictly follow the SKILL output format");
    expect(notifications).toContain("[ pipe-plan-fb-2 • plan ] ⚠ verify failed");

    await rm(TMP, { recursive: true, force: true });
  });
});
