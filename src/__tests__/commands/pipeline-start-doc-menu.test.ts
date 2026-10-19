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
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as fsp from "node:fs/promises";
import fsSync from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createPipelineStartCommand } from "../../commands/pipeline-start";
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
