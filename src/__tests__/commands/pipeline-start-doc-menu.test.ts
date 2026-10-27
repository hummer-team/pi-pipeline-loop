/**
 * 206 Phase 2: tests for the /pipeline-start document-candidate menu
 * (empty-file interactive starts).
 *
 * Coverage per plan:
 * - clarify candidates exclude *_Plan.md and Code_Review_*, mtime desc, cap 5.
 * - Selecting a candidate propagates it into meta.requirementDoc.
 * - "Cancel" keeps the ORIGINAL error string (backward compatibility).
 * - No ui.select (hasSelect=false) keeps the ORIGINAL error string.
 * - Stage dir missing + archiveDirs fallback hit → auto-select + notify.
 * - Explicit file → select is never called (behavior unchanged, Round 2 Q1-A).
 *
 * 213 Phase 2 (D14/D15) additions — direct `promptDocSelection` calls:
 * - `currentDoc` pinned first with a ` (default)` label; selection resolves by
 *   OPTION INDEX and returns the bare project-relative path.
 * - Absolute/relative spellings of one file dedupe into a single row.
 * - Invalid `currentDoc` → title carries `(current requirement doc missing: …)`,
 *   remaining candidates behave as usual.
 * - `currentDoc` supplied + zero candidates → NO auto-select, NO autoselect
 *   audit (boundary rule); no `currentDoc` + zero candidates → auto-select
 *   regression.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as fsp from "node:fs/promises";
import fsSync from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  createPipelineStartCommand,
  promptDocSelection,
} from "../../commands/pipeline-start";
import { createPipelineUI } from "../../core/pipeline-ui";
import { __setSafeWriteAuditLogOverride } from "../../utils/auditLog";
import { createMockCtx, makeTestConfig, makeTestMeta } from "../helpers";
import type { SessionMeta } from "../../types";

/**
 * Test-local mock context shape: includes the assertion helpers returned by
 * createMockCtx plus the minimal TUI dialog surface used by the doc menu.
 * Cast helper keeps production-code calls honest (`ctx as any` mirrors the
 * existing test-file pattern for the SDK-untyped ctx).
 */
interface DocMenuCtx {
  ui: {
    notify: (msg: string) => void;
    setStatus: (key: string, text: string | undefined) => void;
    select?: (message: string, options: string[]) => Promise<string | undefined>;
    confirm?: (message: string) => Promise<boolean>;
    input?: (message: string) => Promise<string | undefined>;
  };
  metadataUpdates: SessionMeta[];
  notifications: string[];
}

let ROOT: string;

beforeEach(async () => {
  ROOT = fsSync.mkdtempSync(path.join(os.tmpdir(), "pi-start-doc-"));
});

afterEach(async () => {
  await fsp.rm(ROOT, { recursive: true, force: true });
});

async function touch(rel: string, mtimeMs: number): Promise<string> {
  const abs = path.join(ROOT, rel);
  await fsp.mkdir(path.dirname(abs), { recursive: true });
  await fsp.writeFile(abs, `# ${path.basename(rel)}\n`, "utf-8");
  await fsp.utimes(abs, new Date(mtimeMs), new Date(mtimeMs));
  return rel;
}

async function scaffoldSkills(): Promise<void> {
  // Minimal .pi/skills bodies so the template-residue gate passes
  const skillsDir = path.join(ROOT, ".pi", "skills");
  await fsp.mkdir(skillsDir, { recursive: true });
  for (const stage of ["design", "plan", "design-review", "develop", "review", "fix"]) {
    const stageDir = path.join(skillsDir, stage);
    await fsp.mkdir(stageDir, { recursive: true });
    await fsp.writeFile(path.join(stageDir, "SKILL.md"), `# ${stage}\n- **Must** ok\n`, "utf-8");
  }
}

function makeDocMenuCtx(meta: SessionMeta, selectReturn: string | undefined): DocMenuCtx {
  return createMockCtx(meta, { selectReturn }) as unknown as DocMenuCtx;
}

/** Installs a spying ui.select that records messages and returns a canned value. */
function installSelect(ctx: DocMenuCtx, returns: string | undefined, seen: { options: string[] }): void {
  (ctx.ui as NonNullable<DocMenuCtx["ui"]>).select = async (_message: string, options: string[]) => {
    seen.options = options;
    return returns;
  };
}

function freshMeta(): SessionMeta {
  return makeTestMeta({
    currentStage: undefined as unknown as SessionMeta["currentStage"],
    pipelineId: undefined,
  });
}

const NOW = Date.now();

describe("pipeline-start doc-candidate menu (206 Phase 2)", () => {
  it("clarify candidates contain only requirement docs (no Plan/Code_Review), mtime desc", async () => {
    await scaffoldSkills();
    await touch("docs/design/203_Bug.md", NOW - 2000);
    await touch("docs/design/203_Bug_Plan.md", NOW);
    await touch("docs/design/204_Bug.md", NOW - 1000);
    await touch("docs/review/Code_Review_204_Bug_Develop_Commit_1.md", NOW);

    const ctx = makeDocMenuCtx(freshMeta(), undefined);
    const seen = { options: [] as string[] };
    installSelect(ctx, undefined, seen);
    const result: any = await createPipelineStartCommand(makeTestConfig({ projectRoot: ROOT })).execute(
      {},
      ctx as any,
    );

    expect(result.success).toBe(false);
    expect(seen.options).toEqual([
      "docs/design/204_Bug.md",
      "docs/design/203_Bug.md",
      "Manual input path",
      "Cancel",
    ]);
    // selectReturn undefined → cancel → original error string retained
    expect(result.error).toBe("run /pipeline-start <doc_file> start pipeline loop");
  });

  it("selecting a candidate starts the pipeline with that requirementDoc", async () => {
    await scaffoldSkills();
    const doc = await touch("docs/design/204_Bug.md", NOW - 1000);

    const ctx = makeDocMenuCtx(freshMeta(), doc);
    const result: any = await createPipelineStartCommand(makeTestConfig({ projectRoot: ROOT })).execute(
      {},
      ctx as any,
    );

    expect(result.success).toBe(true);
    expect(result.pipelineId).toBeDefined();
    const update = ctx.metadataUpdates[ctx.metadataUpdates.length - 1];
    expect(update.requirementDoc).toBe(doc);
    expect(update.currentStage).toBe("clarify");
  });

  it("selectReturn 'Cancel' → original error string (backward compatibility)", async () => {
    await scaffoldSkills();
    await touch("docs/design/204_Bug.md", NOW);

    const ctx = makeDocMenuCtx(freshMeta(), "Cancel");
    const result: any = await createPipelineStartCommand(makeTestConfig({ projectRoot: ROOT })).execute(
      {},
      ctx as any,
    );

    expect(result.success).toBe(false);
    expect(result.error).toBe("run /pipeline-start <doc_file> start pipeline loop");
  });

  it("no ui.select → original error string (degraded, no execution)", async () => {
    await scaffoldSkills();
    await touch("docs/design/204_Bug.md", NOW);

    const ctx = makeDocMenuCtx(freshMeta(), undefined);
    delete ctx.ui.select;
    const result: any = await createPipelineStartCommand(makeTestConfig({ projectRoot: ROOT })).execute(
      {},
      ctx as any,
    );

    expect(result.success).toBe(false);
    expect(result.error).toBe("run /pipeline-start <doc_file> start pipeline loop");
  });

  it("stage dir missing + archiveDirs fallback hit → auto-select with notify", async () => {
    await scaffoldSkills();
    // No /docs/design at all — fallback must find the doc under docs/elsewhere
    await touch("docs/elsewhere/205_Solo.md", NOW);

    const ctx = makeDocMenuCtx(freshMeta(), undefined);
    const result: any = await createPipelineStartCommand(
      makeTestConfig({ projectRoot: ROOT, archiveDirs: ["docs/elsewhere"] }),
    ).execute({}, ctx as any);

    expect(result.success).toBe(true);
    const update = ctx.metadataUpdates[ctx.metadataUpdates.length - 1];
    expect(update.requirementDoc).toBe("docs/elsewhere/205_Solo.md");
    expect(
      ctx.notifications.some((n) => n.includes("Auto-selected latest document: docs/elsewhere/205_Solo.md")),
    ).toBe(true);
  });

  it("explicit file → select never called (existing behavior unchanged)", async () => {
    await scaffoldSkills();
    const doc = await touch("docs/design/204_Bug.md", NOW);

    const ctx = makeDocMenuCtx(freshMeta(), "should-not-be-returned");
    const seen = { options: [] as string[] };
    let selectCalls = 0;
    (ctx.ui as NonNullable<DocMenuCtx["ui"]>).select = async (_m: string, options: string[]) => {
      selectCalls++;
      seen.options = options;
      return "should-not-be-returned";
    };
    const result: any = await createPipelineStartCommand(makeTestConfig({ projectRoot: ROOT })).execute(
      { file: doc },
      ctx as any,
    );

    expect(result.success).toBe(true);
    expect(selectCalls).toBe(0);
    const update = ctx.metadataUpdates[ctx.metadataUpdates.length - 1];
    expect(update.requirementDoc).toBe(doc);
  });

  it("'Manual input path' → valid relative path starts the pipeline (review issue 1)", async () => {
    await scaffoldSkills();
    const doc = await touch("docs/design/206_Feat.md", NOW);

    // No candidate in the stage dir so the manual branch is offered directly,
    // then the host input dialog returns a project-relative path.
    const ctx = makeDocMenuCtx(freshMeta(), "Manual input path");
    (ctx.ui as NonNullable<DocMenuCtx["ui"]>).input = async () => doc;

    const result: any = await createPipelineStartCommand(makeTestConfig({ projectRoot: ROOT })).execute(
      {},
      ctx as any,
    );

    expect(result.success).toBe(true);
    const update = ctx.metadataUpdates[ctx.metadataUpdates.length - 1];
    expect(update.requirementDoc).toBe(doc);
    expect(update.currentStage).toBe("clarify");
  });

  it("'Manual input path' → absolute path outside projectRoot is re-rooted safely (review issue 2)", async () => {
    await scaffoldSkills();
    const outsideRoot = fsSync.mkdtempSync(path.join(os.tmpdir(), "pi-doc-outside-"));
    try {
      const abs = path.join(outsideRoot, "206_Feat.md");
      await fsp.writeFile(abs, "# outside requirement\n", "utf-8");

      const ctx = makeDocMenuCtx(freshMeta(), "Manual input path");
      (ctx.ui as NonNullable<DocMenuCtx["ui"]>).input = async () => abs;

      const result: any = await createPipelineStartCommand(makeTestConfig({ projectRoot: ROOT })).execute(
        {},
        ctx as any,
      );

      expect(result.success).toBe(true);
      const update = ctx.metadataUpdates[ctx.metadataUpdates.length - 1];
      // Stored as a project-relative path that still resolves to the same file.
      expect(path.resolve(ROOT, update.requirementDoc!)).toBe(abs);
    } finally {
      await fsp.rm(outsideRoot, { recursive: true, force: true });
    }
  });
});

// ─── 213 Phase 2 (D14/D15): shared promptDocSelection with a current-doc row ──

interface DirectCtx {
  ui: {
    notify: (msg: string) => void;
    select: (message: string, options: string[]) => Promise<string | undefined>;
    input?: (message: string) => Promise<string | undefined>;
  };
}

/**
 * Direct-call harness: records every (title, options) pair handed to the host
 * select dialog and answers with a canned choice. Structurally compatible with
 * the production `DocMenuCtx` (which only requires optional `ui.select`/
 * `ui.input`); the extra `notify` feeds `ui.notify` in the shared shell.
 */
function makeDirectCtx(
  choice: string | undefined,
  seen: Array<{ title: string; options: string[] }>,
  notifications: string[],
): DirectCtx {
  return {
    ui: {
      notify: (msg: string) => {
        notifications.push(msg);
      },
      select: async (title: string, options: string[]) => {
        seen.push({ title, options });
        return choice;
      },
    },
  };
}

describe("promptDocSelection with currentDoc (213 Phase 2 / D14/D15)", () => {
  const NOW213 = Date.now();

  afterEach(() => {
    __setSafeWriteAuditLogOverride(null);
  });

  it("current doc is pinned FIRST with a ' (default)' label; selection returns the bare rel path", async () => {
    await touch("docs/design/14_Feat.md", NOW213 - 500);
    await touch("docs/design/13_A_Plan.md", NOW213);
    await touch("docs/design/12_B_Plan.md", NOW213 - 1000);

    const seen: Array<{ title: string; options: string[] }> = [];
    const notifications: string[] = [];
    // Pick the suffixed first row — exactly what a host menu hands back.
    const ctx = makeDirectCtx("docs/design/14_Feat.md (default)", seen, notifications);
    const selected = await promptDocSelection(
      ctx,
      makeTestConfig({ projectRoot: ROOT }),
      createPipelineUI(makeTestConfig({ projectRoot: ROOT })),
      "design-review",
      "resume_new",
      "docs/design/14_Feat.md",
    );

    // Head row: the requirement doc survives the *_Plan.md stage filter ONLY
    // because it is pinned; plans fill in behind by mtime.
    expect(seen).toHaveLength(1);
    expect(seen[0]!.options).toEqual([
      "docs/design/14_Feat.md (default)",
      "docs/design/13_A_Plan.md",
      "docs/design/12_B_Plan.md",
      "Manual input path",
      "Cancel",
    ]);
    // Index mapping: the returned path carries NO label suffix.
    expect(selected).toBe("docs/design/14_Feat.md");
    expect(notifications.join("")).not.toContain("Auto-selected");
  });

  it("meta-acceptance shape: default row + plans by mtime, total rows ≤ MAX_DOC_CANDIDATES (5)", async () => {
    await touch("docs/design/14_Feat.md", NOW213 - 500);
    for (let i = 1; i <= 6; i++) {
      await touch(`docs/design/${200 + i}_X_Plan.md`, NOW213 - i * 1000);
    }
    const seen: Array<{ title: string; options: string[] }> = [];
    const ctx = makeDirectCtx(undefined, seen, []);
    await promptDocSelection(
      ctx,
      makeTestConfig({ projectRoot: ROOT }),
      createPipelineUI(makeTestConfig({ projectRoot: ROOT })),
      "design-review",
      "resume_new",
      "docs/design/14_Feat.md",
    );
    // 5 doc rows (1 pinned + 4 newest plans) + manual + cancel = 7 options.
    expect(seen[0]!.options).toHaveLength(7);
    expect(seen[0]!.options[0]).toBe("docs/design/14_Feat.md (default)");
    expect(seen[0]!.options.slice(1, 5)).toEqual([
      "docs/design/201_X_Plan.md",
      "docs/design/202_X_Plan.md",
      "docs/design/203_X_Plan.md",
      "docs/design/204_X_Plan.md",
    ]);
  });

  it("absolute and relative spellings of the current doc dedupe into ONE row, returned posix-rel", async () => {
    await touch("docs/design/204_Bug_Plan.md", NOW213);
    await touch("docs/design/203_Old_Plan.md", NOW213 - 1000);

    const seen: Array<{ title: string; options: string[] }> = [];
    const ctx = makeDirectCtx("docs/design/204_Bug_Plan.md (default)", seen, []);
    const selected = await promptDocSelection(
      ctx,
      makeTestConfig({ projectRoot: ROOT }),
      createPipelineUI(makeTestConfig({ projectRoot: ROOT })),
      "design-review",
      "resume_new",
      path.join(ROOT, "docs/design/204_Bug_Plan.md"), // absolute spelling in meta
    );

    const planRows = seen[0]!.options.filter((o) => o.includes("204_Bug_Plan"));
    expect(planRows).toEqual(["docs/design/204_Bug_Plan.md (default)"]);
    // Write-back form is project-relative posix even though meta held absolute.
    expect(selected).toBe("docs/design/204_Bug_Plan.md");
  });

  it("invalid currentDoc → title notes the missing doc, remaining candidates as usual", async () => {
    await touch("docs/design/13_A_Plan.md", NOW213);

    const seen: Array<{ title: string; options: string[] }> = [];
    const ctx = makeDirectCtx("docs/design/13_A_Plan.md", seen, []);
    const selected = await promptDocSelection(
      ctx,
      makeTestConfig({ projectRoot: ROOT }),
      createPipelineUI(makeTestConfig({ projectRoot: ROOT })),
      "design-review",
      "resume_new",
      "docs/design/gone_Plan.md",
    );

    expect(seen[0]!.title).toContain("(current requirement doc missing: docs/design/gone_Plan.md)");
    expect(seen[0]!.options).toEqual(["docs/design/13_A_Plan.md", "Manual input path", "Cancel"]);
    expect(selected).toBe("docs/design/13_A_Plan.md");
  });

  it("invalid currentDoc + ZERO candidates → NO auto-select, NO autoselect audit, manual/cancel menu", async () => {
    await fsp.mkdir(path.join(ROOT, "docs/design"), { recursive: true });
    const auditEvents: string[] = [];
    __setSafeWriteAuditLogOverride(async (stage: string) => {
      auditEvents.push(stage);
    });

    const seen: Array<{ title: string; options: string[] }> = [];
    const notifications: string[] = [];
    const ctx = makeDirectCtx("Cancel", seen, notifications);
    const selected = await promptDocSelection(
      ctx,
      makeTestConfig({ projectRoot: ROOT }),
      createPipelineUI(makeTestConfig({ projectRoot: ROOT })),
      "design-review",
      "resume_new",
      "docs/design/gone_Plan.md",
    );

    expect(selected).toBeNull(); // Cancel from the manual/cancel menu
    // The fallback menu is reached directly — no auto-pick happened.
    expect(seen).toHaveLength(1);
    expect(seen[0]!.title).toBe(
      "No candidate document found for design-review. (current requirement doc missing: docs/design/gone_Plan.md)",
    );
    expect(notifications.join("")).not.toContain("Auto-selected");
    expect(auditEvents.filter((e) => e === "pipeline_start_doc_menu_autoselect")).toHaveLength(0);
  });

  it("NO currentDoc + zero candidates → auto-select latest stays (regression), audit reason forwarded", async () => {
    await touch("docs/elsewhere/205_Solo.md", NOW213);
    const auditEvents: string[] = [];
    __setSafeWriteAuditLogOverride(async (stage: string) => {
      auditEvents.push(stage);
    });

    const seen: Array<{ title: string; options: string[] }> = [];
    const notifications: string[] = [];
    const ctx = makeDirectCtx(undefined, seen, notifications);
    const cfg = makeTestConfig({ projectRoot: ROOT, archiveDirs: ["docs/elsewhere"] });
    const selected = await promptDocSelection(
      ctx,
      cfg,
      createPipelineUI(cfg),
      "clarify",
      "resume_new",
    );

    expect(selected).toBe("docs/elsewhere/205_Solo.md");
    expect(notifications.some((n) => n.includes("Auto-selected latest document: docs/elsewhere/205_Solo.md"))).toBe(true);
    expect(auditEvents.filter((e) => e === "pipeline_start_doc_menu_autoselect")).toHaveLength(1);
    expect(seen).toHaveLength(0); // auto-select short-circuits before any menu
  });

  it("unknown return value from the host dialog degrades to manual input (index mapping guard)", async () => {
    await touch("docs/design/13_A_Plan.md", NOW213);
    const seen: Array<{ title: string; options: string[] }> = [];
    const ctx = makeDirectCtx("__not_an_option__", seen, []);
    ctx.ui.input = async () => undefined; // user aborts the input dialog too
    const selected = await promptDocSelection(
      ctx,
      makeTestConfig({ projectRoot: ROOT }),
      createPipelineUI(makeTestConfig({ projectRoot: ROOT })),
      "design-review",
      "resume_new",
      "docs/design/13_A_Plan.md",
    );
    // Index lookup failed → manual path attempted → no input → null.
    expect(selected).toBeNull();
    expect(seen).toHaveLength(1);
  });
});
