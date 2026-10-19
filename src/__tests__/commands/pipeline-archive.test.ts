/**
 * 206 Phase 4: tests for the /pipeline-archive TUI command
 * (flow orchestration + destructive-path protection).
 *
 * Coverage per plan:
 * - No ui.select → no_ui error, no file changes, audit has pipeline_archive_no_ui.
 * - Threshold menu cancel → no changes.
 * - Zero targets → notify + success.
 * - "Move to zip" + zip ok → zip generated, sources removed, empty dirs pruned,
 *   pipeline_archive_executed(action=move).
 * - "Move to zip" + zip failure (fake execFn returns non-zero) → sources still
 *   on disk + error audit.
 * - "Delete permanently" + second confirm No → no changes + cancelled audit.
 * - "Delete permanently" + confirm → files deleted + executed(action=delete).
 * - Edge: missing ctx.session (activeDoc undefined); absolute archiveDest.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as fsp from "node:fs/promises";
import fsSync from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createPipelineArchiveCommand } from "../../commands/pipeline-archive";
import { parseCommandArgs } from "../../utils/command-args";
import { makeTestConfig, auditLogFileFor } from "../helpers";
import { initAuditLog, setAuditPipelineContext } from "../../utils/auditLog";
import type { ExecFn, PipelineConfig } from "../../types";

let ROOT: string;
let HOME_DIR: string;
let cfg: PipelineConfig;

beforeEach(async () => {
  ROOT = fsSync.mkdtempSync(path.join(os.tmpdir(), "pi-archive-cmd-"));
  HOME_DIR = fsSync.mkdtempSync(path.join(os.tmpdir(), "pi-archive-home-"));
  cfg = makeTestConfig({
    projectRoot: ROOT,
    archiveDirs: ["docs/design"],
    auditDir: ".pi/audit",
    // Relative dest values resolve against os.homedir(); pin an absolute temp
    // HOME-bound destination so the real user home is never touched.
    archiveDest: HOME_DIR,
  });
  // Audit writes land in the temp project (safeWriteAuditLog uses module state).
  setAuditPipelineContext(null);
  await initAuditLog(cfg);
});

afterEach(async () => {
  await fsp.rm(ROOT, { recursive: true, force: true });
  await fsp.rm(HOME_DIR, { recursive: true, force: true });
});

const NOW = Date.now();
const DAY = 86_400_000;

async function writeOld(rel: string, content = "x, older content"): Promise<string> {
  const abs = path.join(ROOT, rel);
  await fsp.mkdir(path.dirname(abs), { recursive: true });
  await fsp.writeFile(abs, content, "utf-8");
  await fsp.utimes(abs, new Date(NOW - 30 * DAY), new Date(NOW - 30 * DAY));
  return abs;
}

interface MenuCtx {
  meta?: { requirementDoc?: string } | undefined;
  selectReturn?: string | undefined;
  confirmReturn?: boolean | undefined;
  hasConfirm?: boolean;
  hasSelect?: boolean;
}

/** Builds a TUI ctx with sequential select answers and notification capture. */
function makeTuiCtx(opts: MenuCtx = {}) {
  const notifications: string[] = [];
  const contents: string[] = [];
  const selectQuestions: string[] = [];
  let selectIdx = 0;
  const valid = opts.hasSelect !== false;
  const ctx = {
    ui: {
      select: valid
        ? (message: string, _options: string[]) => {
            selectQuestions.push(message);
            const answer = Array.isArray(opts.selectReturn)
              ? (opts.selectReturn as string[])[selectIdx++]
              : opts.selectReturn;
            return Promise.resolve(answer);
          }
        : undefined,
      confirm:
        opts.confirmReturn !== undefined
          ? async () => opts.confirmReturn ?? true
          : undefined,
      notify: (msg: string) => notifications.push(msg),
      content: (markdown: string) => contents.push(markdown),
    },
    session: opts.meta === undefined ? undefined : { getMeta: () => opts.meta },
    notifications,
    contents,
    selectQuestions,
  };
  return ctx;
}

/** Replaces the select with an ordered script of answers, consumed in order. */
type TuiCtx = ReturnType<typeof makeTuiCtx>;

function withScriptedSelects(ctx: TuiCtx, answers: string[]): TuiCtx {
  let idx = 0;
  ctx.ui.select = (message: string, _options: string[]) => {
    ctx.selectQuestions.push(message);
    const answer = answers[idx++] ?? undefined;
    return Promise.resolve(answer);
  };
  return ctx;
}

/** Reads today's audit log for the system segment of the temp project. */
async function readAudit(): Promise<string> {
  const file = auditLogFileFor(path.join(ROOT, ".pi", "audit"));
  try {
    return await fsp.readFile(file, "utf-8");
  } catch {
    return "";
  }
}

describe("pipeline-archive command (206 Phase 4)", () => {
  it("no ui.select → no_ui error, no file changes, audit has no_ui entry", async () => {
    await writeOld("docs/design/201_Old.md");
    const ctx = makeTuiCtx({ hasSelect: false });
    const result: any = await createPipelineArchiveCommand(cfg, { execFn: undefined }).execute(
      {},
      ctx as any,
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain("requires an interactive TUI session");
    expect(fsSync.existsSync(path.join(ROOT, "docs/design/201_Old.md"))).toBe(true);
    expect((await readAudit())).toContain("pipeline_archive_no_ui");
  });

  it("threshold menu cancel → no changes + cancelled audit", async () => {
    await writeOld("docs/design/202_Old.md");
    const ctx = makeTuiCtx({ selectReturn: "Cancel" });
    const result: any = await createPipelineArchiveCommand(cfg, { execFn: undefined }).execute(
      {},
      ctx as any,
    );
    expect(result.success).toBe(false);
    expect(await fsp.readdir(path.join(ROOT, "docs/design"))).toEqual(["202_Old.md"]);
    expect((await readAudit())).toContain("pipeline_archive_cancelled | stage=threshold");
  });

  it("zero targets → notify + success, no zip/menu flow", async () => {
    const abs = await writeOld("docs/design/203_New.md");
    await fsp.utimes(abs, new Date(NOW), new Date(NOW)); // fresh file
    const ctx = makeTuiCtx({ selectReturn: "7 days" });
    const result: any = await createPipelineArchiveCommand(cfg, { execFn: undefined }).execute(
      {},
      ctx as any,
    );
    expect(result.success).toBe(true);
    expect(ctx.notifications.some((n) => n.includes("No documents older than 7"))).toBe(true);
    expect((await readAudit())).toContain("pipeline_archive_scan");
  });

  it("Move to zip (zip ok) → zip written, sources removed, empty dirs pruned, executed audit", async () => {
    const execCalls: string[][] = [];
    const execFn: ExecFn = async (cmd, args) => {
      execCalls.push(args);
      // Fake a successful system zip by writing the target zip file ourselves
      const zipped = args[2];
      if (typeof zipped === "string" && zipped.endsWith(".zip")) {
        await fsp.writeFile(zipped, "PK-fake-zip-bytes", "utf-8");
      }
      return { stdout: "", stderr: "", code: 0 };
    };
    // Note: the scanner includes the constant `.pi/audit` root, but it is
    // missing here — validate `missingDirs` tolerance silently.
    await writeOld("docs/design/nested/204_VeryOld.md");
    await writeOld("docs/design/deep/205_OldToo.md");

    const ctx = withScriptedSelects(
      makeTuiCtx({ confirmReturn: true }),
      ["7 days", "Move to zip"],
    );
    const result: any = await createPipelineArchiveCommand(cfg, { execFn }).execute({}, ctx as any);

    expect(result.success).toBe(true);
    expect(result.message).toContain("Archived");
    // Sources gone
    expect(fsSync.existsSync(path.join(ROOT, "docs/design/nested/204_VeryOld.md"))).toBe(false);
    expect(fsSync.existsSync(path.join(ROOT, "docs/design/deep/205_OldToo.md"))).toBe(false);
    // Empty parent dirs pruned, scope root itself kept
    expect(fsSync.existsSync(path.join(ROOT, "docs/design/nested"))).toBe(false);
    expect(fsSync.existsSync(path.join(ROOT, "docs/design"))).toBe(true);
    // Zip file written into the temp HOME-bound destination
    const homeFiles = await fsp.readdir(HOME_DIR);
    const zipFile = homeFiles.find((f) => f.includes("_pipeline.zip"));
    expect(zipFile).toBeDefined();
    expect(execCalls.length).toBeGreaterThan(0);
    const audit = await readAudit();
    expect(audit).toContain("pipeline_archive_executed");
    expect(audit).toContain("action=move");
  });

  it("Move to zip with failing zip → sources untouched + error audit", async () => {
    // Pass the `zip -h` availability probe (args ["-h"]) but fail every real
    // zip batch with a non-zero exit code.
    const execFn: ExecFn = async (_cmd, args) =>
      args.length === 1 && args[0] === "-h"
        ? { stdout: "", stderr: "", code: 0 }
        : { stdout: "", stderr: "zip error: bad", code: 18 };
    await writeOld("docs/design/206_Old.md");
    const ctx = withScriptedSelects(
      makeTuiCtx({ confirmReturn: true }),
      ["7 days", "Move to zip"],
    );
    const result: any = await createPipelineArchiveCommand(cfg, { execFn }).execute({}, ctx as any);

    expect(result.success).toBe(true); // command flow completes, but reports failure
    expect(result.message).toContain("Zip failed");
    expect(fsSync.existsSync(path.join(ROOT, "docs/design/206_Old.md"))).toBe(true);
    expect((await readAudit())).toContain("pipeline_archive_error");
  });

  it("Delete permanently + second confirm No → no changes + cancelled audit", async () => {
    await writeOld("docs/design/207_Old.md");
    // No ui.confirm → the select fallback Yes/No dialog is used; script "No".
    const ctx = withScriptedSelects(
      makeTuiCtx({}),
      ["7 days", "Delete permanently", "No"],
    );
    expect(ctx.ui.confirm).toBeUndefined();
    const result: any = await createPipelineArchiveCommand(cfg, { execFn: undefined }).execute(
      {},
      ctx as any,
    );

    expect(result.success).toBe(false);
    expect(fsSync.existsSync(path.join(ROOT, "docs/design/207_Old.md"))).toBe(true);
    expect((await readAudit())).toContain("pipeline_archive_cancelled | stage=confirm");
  });

  it("Delete permanently + confirm → files deleted + executed audit (action=delete)", async () => {
    await writeOld("docs/design/208_Old.md");
    // Stale, date-rotated audit log directly under the constant `.pi/audit`
    // root — proves the constant scope root participates in archiving.
    // (Today's own audit writes land later under `.pi/audit/system/log/`.)
    await writeOld(".pi/audit/20250901_audit.log");
    const ctx = withScriptedSelects(
      makeTuiCtx({ confirmReturn: true }),
      ["7 days", "Delete permanently"],
    );
    const result: any = await createPipelineArchiveCommand(cfg, { execFn: undefined }).execute(
      {},
      ctx as any,
    );

    expect(result.success).toBe(true);
    expect(result.message).toContain("Deleted");
    expect(fsSync.existsSync(path.join(ROOT, "docs/design/208_Old.md"))).toBe(false);
    expect(fsSync.existsSync(path.join(ROOT, ".pi/audit/20250901_audit.log"))).toBe(false);
    const audit = await readAudit();
    expect(audit).toContain("pipeline_archive_executed");
    expect(audit).toContain("action=delete");
  });

  it("active requirementDoc pages are protected from both actions", async () => {
    await writeOld("docs/design/209_Bug.md");
    await writeOld("docs/design/209_Bug_Plan.md");
    const ctx = withScriptedSelects(
      makeTuiCtx({ meta: { requirementDoc: "docs/design/209_Bug.md" } }),
      ["7 days"],
    );
    const result: any = await createPipelineArchiveCommand(cfg, { execFn: undefined }).execute(
      {},
      ctx as any,
    );

    expect(result.success).toBe(true);
    expect(ctx.notifications.some((n) => n.includes("No documents older than 7"))).toBe(true);
    expect(fsSync.existsSync(path.join(ROOT, "docs/design/209_Bug.md"))).toBe(true);
    expect(fsSync.existsSync(path.join(ROOT, "docs/design/209_Bug_Plan.md"))).toBe(true);
  });

  it("absolute archiveDest kept as-is; command-args parses raw", async () => {
    const absDest = path.join(HOME_DIR, "abs-archive");
    expect(parseCommandArgs("pipeline-archive", "")).toEqual({ raw: "" });
    await writeOld("docs/design/210_Old.md");
    const absCfg = makeTestConfig({
      projectRoot: ROOT,
      archiveDirs: ["docs/design"],
      auditDir: ".pi/audit",
      archiveDest: absDest,
    });
    await initAuditLog(absCfg);
    const execFn: ExecFn = async (_cmd, args) => {
      const zipPath = args[2];
      if (typeof zipPath === "string" && zipPath.endsWith(".zip")) {
        await fsp.writeFile(zipPath, "PK-absolute", "utf-8");
      }
      return { stdout: "", stderr: "", code: 0 };
    };
    const ctx = withScriptedSelects(
      makeTuiCtx({ confirmReturn: true }),
      ["3 days", "Move to zip"],
    );
    const result: any = await createPipelineArchiveCommand(absCfg, { execFn }).execute(
      {},
      ctx as any,
    );
    expect(result.success).toBe(true);
    const dirEntries = await fsp.readdir(absDest);
    expect(dirEntries.some((f) => f.includes("_pipeline.zip"))).toBe(true);
  });
});
