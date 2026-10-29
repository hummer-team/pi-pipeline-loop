/**
 * @module whitelist-miss-decision
 * 218 Phase 2 (T2.2/T2.3/T2.5, F.2/F.3/D4): the three-state whitelist-miss
 * contract routed through the unified per-call write-candidate collector.
 *
 * Plan case table coverage:
 *  1.  one bash call, multi-segment multi-target → exactly ONE ask;
 *      "Allow these writes only" admits THIS call only (next call asks again)
 *  2.  mixed batch (protected + whitelist_miss) → one ask listing both;
 *      mode "allow" never silently passes a batch containing protected
 *  3.  ask ×3 dismissed → no violation / no freeze;
 *      deny ×3 → violation_overflow + freeze (HEAD regression, read_only_path
 *      bucket only — no re-judgement)
 *  3b. owner explicit Deny ×3 (same stage+pathClass) →
 *      whitelist_miss_denial_overflow + freeze, WITHOUT violation counting
 *  4.  no interactive UI → hard block + count + whitelist_miss_no_ui_fallback
 *  5.  session-allowed paths never ask; gitignored / protect.paths targets
 *      stay protected even under mode "allow"; out-of-root absolute file-arg
 *      targets join the same merged decision under the "@outside" class (T2.6)
 *  6.  read-only stage paths never reach the write-approval menu
 *  7.  child asks enqueue (never menu, never count, dedupe by fingerprint)
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createToolGuard } from "../../core/tool-guard";
import { makeTestConfig, makeTestMeta, createMockCtx, STAGE_LIST } from "../helpers";
import { resetGitignoreCache } from "../../utils/gitignore";
import { initAuditLog } from "../../utils/auditLog";
import { isFrozen, executeDecision } from "../../core/flow-state";
import { readDenialCount, recordDenial } from "../../core/write-scope/denials";
import type { PipelineConfig, SessionMeta, WhitelistMissMode } from "../../types";

/** Exact askWriteDecision option strings (protect-ask.ts). */
const W_DENY = "Follow plugin default rules (default)";
const W_ONCE = "Allow these writes only";
const W_SESSION = "Allow these writes for this session";
/** Exact askProtectDecision option string (HEAD protected channel). */
const P_DENY = "Follow plugin default rules (default)";

let TMP: string;

beforeEach(async () => {
  resetGitignoreCache();
  TMP = join(tmpdir(), "pi-wlmiss-dec-" + Date.now() + "-" + Math.random().toString(36).slice(2, 6));
  await fs.mkdir(TMP, { recursive: true });
  // .tmp-r4/ is gitignore-protected; secure/ is protect.paths-protected;
  // tmp/ is a PURE whitelist miss surface (untracked, not ignored).
  await fs.writeFile(join(TMP, ".gitignore"), ".tmp-r4/\n", "utf-8");
  await fs.mkdir(join(TMP, ".pi", "audit"), { recursive: true });
});

afterEach(async () => {
  await fs.rm(TMP, { recursive: true, force: true });
});

/**
 * Whitelist mode under test. Every stage writes only into `docs/`, so `tmp/…`
 * is a whitelist miss, `secure/…` and `.tmp-r4/…` are protected, `docs/…` hits.
 */
function wlConfig(whitelistMiss: WhitelistMissMode, protectAsk = true): PipelineConfig {
  const config = makeTestConfig({
    projectRoot: TMP,
    auditDir: join(TMP, ".pi/audit"),
    protect: { gitignore: true, paths: ["secure/"], allow: [], ask: protectAsk, whitelistMiss },
  });
  for (const s of STAGE_LIST) {
    config.stages[s] = { ...config.stages[s], allowedWritePaths: ["docs/"] } as PipelineConfig["stages"][typeof s];
  }
  return config;
}

type MenuCall = { title: string; options: string[] };

/**
 * ctx harness: menu spy + answer; `child` adds a parentSession header
 * (detectSessionRole) and `noUi` removes select entirely (probe → false).
 */
function harness(
  meta: SessionMeta,
  answer: string | undefined,
  opts?: { child?: boolean; noUi?: boolean },
) {
  const ctx = createMockCtx(meta, opts?.child ? { sessionHeader: { parentSession: "parent-x" } } : undefined);
  const menus: MenuCall[] = [];
  if (opts?.noUi) {
    delete (ctx.ui as { select?: unknown }).select;
  } else {
    ctx.ui.select = async (title: string, options: string[]) => {
      menus.push({ title, options });
      return answer;
    };
  }
  return { ctx, menus };
}

/** Drive one tool call through the guard. */
async function run(ctx: ReturnType<typeof createMockCtx>, name: string, args: Record<string, unknown>) {
  ctx.toolCall = { name, arguments: args } as never;
  const hook = createToolGuard(currentConfig);
  return (await hook.handler(ctx as never)) as { block?: boolean; reason?: string } | undefined;
}

let currentConfig: PipelineConfig;

/** Config + initialised audit sink for the running test. */
function boot(mode: WhitelistMissMode, protectAsk = true): PipelineConfig {
  currentConfig = wlConfig(mode, protectAsk);
  initAuditLog(currentConfig);
  return currentConfig;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Recursively collect every audit line under this test's audit dir. */
async function auditText(): Promise<string> {
  await sleep(30); // fire-and-forget audit flush
  const out: string[] = [];
  async function walk(dir: string) {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = join(dir, e.name);
      if (e.isDirectory()) await walk(full);
      else if (e.name.endsWith(".log")) out.push(await fs.readFile(full, "utf-8"));
    }
  }
  await walk(join(TMP, ".pi/audit"));
  return out.join("\n");
}

describe("whitelist-miss decision routing (218 Phase 2)", () => {
  // ── Case 1: one ask per bash call, merged across segments ───────────────
  it("ask: one bash call × 3 miss targets → ONE merged ask; deny keeps them blocked", async () => {
    const config = boot("ask");
    const meta = makeTestMeta({ pipelineId: "wl1", currentStage: "develop" });
    const { ctx, menus } = harness(meta, W_DENY);
    const res = await run(ctx, "bash", { command: "echo a > tmp/1.txt; echo b > tmp/2.txt; echo c > tmp/3.txt" });
    expect(res?.block).toBe(true);
    const writeMenus = menus.filter((m) => m.title.includes("Pipeline write approval"));
    expect(writeMenus.length).toBe(1); // ONE ask for the whole call (R6 fix)
    expect(writeMenus[0]!.title).toContain("tmp/1.txt");
    expect(writeMenus[0]!.title).toContain("tmp/3.txt");
    expect(meta.violations?.length ?? 0).toBe(0); // explicit deny feeds its OWN breaker
    expect((await auditText()).includes("pipeline_write_ask")).toBe(true);
    void config;
  });

  it("ask: 'Allow these writes only' admits this call; the NEXT call asks again", async () => {
    boot("ask");
    const meta = makeTestMeta({ pipelineId: "wl1b", currentStage: "develop" });
    const { ctx, menus } = harness(meta, W_ONCE);
    const r1 = await run(ctx, "bash", { command: "echo a > tmp/1.txt; echo b > tmp/2.txt" });
    expect(r1).toBeUndefined(); // call passed
    // Q22-A: allow_once is PER CALL — the next call must ASK AGAIN (a fresh
    // menu), not pass silently. Answering "dismiss" proves the ask happened.
    ctx.ui.select = async (title: string, options: string[]) => {
      menus.push({ title, options });
      return undefined; // dismissed → block (proves the re-ask)
    };
    const r2 = await run(ctx, "bash", { command: "echo a > tmp/1.txt" });
    expect(r2?.block).toBe(true); // asked again, dismissed → blocked
    expect(menus.filter((m) => m.title.includes("Pipeline write approval")).length).toBe(2);
    // allow_once must NOT persist a session grant.
    expect(meta.sessionAllowedWritePaths ?? []).toHaveLength(0);
  });

  // ── Case 2: mixed batch; protection wins ────────────────────────────────
  it("mixed protected + miss in one call → ONE ask listing both kinds", async () => {
    boot("ask");
    const meta = makeTestMeta({ pipelineId: "wl2a", currentStage: "develop" });
    const { ctx, menus } = harness(meta, W_ONCE);
    const res = await run(ctx, "bash", { command: "echo x > secure/s.txt; echo y > tmp/a.txt" });
    expect(res).toBeUndefined(); // owner explicitly approved the batch
    const writeMenus = menus.filter((m) => m.title.includes("Pipeline write approval"));
    expect(writeMenus.length).toBe(1); // ONE interaction for the mixed batch
    expect(writeMenus[0]!.title).toContain("secure/s.txt");
    expect(writeMenus[0]!.title).toContain("tmp/a.txt");
  });

  it("allow mode: pure misses pass silently with whitelist_miss_allowed; protected batches still ask", async () => {
    boot("allow");
    const meta = makeTestMeta({ pipelineId: "wl2b", currentStage: "develop" });
    const { ctx, menus } = harness(meta, undefined);
    const r1 = await run(ctx, "bash", { command: "echo y > tmp/a.txt" });
    expect(r1).toBeUndefined(); // allowed, no menu
    expect(menus.length).toBe(0);
    const audit = await auditText();
    expect(audit.includes("whitelist_miss_allowed")).toBe(true);

    // Mixed under allow: protected wins (F.3-2) → the batch is NOT passed
    // silently; it goes to the human channel as ONE merged interaction.
    const meta2 = makeTestMeta({ pipelineId: "wl2c", currentStage: "develop" });
    const h2 = harness(meta2, P_DENY);
    const r2 = await run(h2.ctx, "bash", { command: "echo x > secure/s.txt; echo y > tmp/b.txt" });
    expect(r2?.block).toBe(true);
    expect(h2.menus.length).toBe(1); // merged ask (protected + miss), one interaction
    expect((await auditText()).includes("whitelist_miss_allowed")).toBe(true); // only for the pure batch
  });

  // ── Case 3: ask ×3 clean; deny ×3 → violation_overflow (regression) ─────
  it("ask ×3 dismissed → menus shown, zero violations, zero freeze", async () => {
    boot("ask");
    const meta = makeTestMeta({ pipelineId: "wl3a", currentStage: "develop" });
    const { ctx, menus } = harness(meta, undefined); // no selection → dismissed
    for (let i = 0; i < 3; i++) {
      const res = await run(ctx, "write", { file_path: join(TMP, `tmp/f${i}.txt`) });
      expect(res?.block).toBe(true);
    }
    expect(menus.filter((m) => m.title.includes("Pipeline write approval")).length).toBe(3);
    expect(meta.violations?.length ?? 0).toBe(0); // dismissed is an environment fact (173 C11)
    expect(isFrozen(meta)).toBe(false);
  });

  it("deny ×3 → read_only_path counting + violation_overflow + freeze (HEAD parity)", async () => {
    boot("deny");
    const meta = makeTestMeta({ pipelineId: "wl3b", currentStage: "develop" });
    const { ctx, menus } = harness(meta, W_ONCE); // answer must never matter in deny mode
    for (let i = 0; i < 3; i++) {
      const res = await run(ctx, "write", { file_path: join(TMP, `tmp/g${i}.txt`) });
      expect(res?.block).toBe(true);
      expect(res?.reason).toContain("not in allowed write paths"); // 3c: HEAD wording
    }
    expect(menus.filter((m) => m.title.includes("Pipeline write approval")).length).toBe(0); // deny never asks
    expect(meta.violations?.length).toBe(3);
    expect(meta.violations?.every((v) => v.guardSource === "read_only_path")).toBe(true); // no git_policy re-judge
    expect(isFrozen(meta)).toBe(true);
    expect((await auditText()).includes("violation_overflow")).toBe(true);
  });

  // ── Case 3b: owner explicit-Deny breaker ────────────────────────────────
  it("explicit Deny ×2 stays below the breaker; Deny ×3 (same stage+pathClass) → denial_overflow + freeze", async () => {
    boot("ask");
    const meta = makeTestMeta({ pipelineId: "wl3c", currentStage: "develop" });
    const { ctx } = harness(meta, W_DENY);
    for (let i = 0; i < 2; i++) {
      expect((await run(ctx, "write", { file_path: join(TMP, `tmp/h${i}.txt`) }))?.block).toBe(true);
    }
    expect(isFrozen(meta)).toBe(false);
    expect(meta.violations?.length ?? 0).toBe(0); // denies are NOT violations (D1)
    expect(meta.whitelistMissDenials?.counts["tmp"]).toBe(2);

    expect((await run(ctx, "write", { file_path: join(TMP, "tmp/h2.txt") }))?.block).toBe(true);
    expect(isFrozen(meta)).toBe(true);
    expect(meta.whitelistMissDenials?.counts["tmp"]).toBe(3);
    expect((await auditText()).includes("whitelist_miss_denial_overflow")).toBe(true);
  });

  // ── Case 3c: 218 review #2 — the breaker never crosses pipeline periods ──
  it("restart → re-enter develop starts from zero (guide.md clear promise)", async () => {
    boot("ask");
    const meta = makeTestMeta({ pipelineId: "wl-period-restart", currentStage: "develop" });
    const { ctx } = harness(meta, W_DENY);
    for (let i = 0; i < 2; i++) {
      expect((await run(ctx, "write", { file_path: join(TMP, `tmp/pr${i}.txt`) }))?.block).toBe(true);
    }
    expect(meta.whitelistMissDenials?.counts["tmp"]).toBe(2);
    expect(meta.whitelistMissDenials?.pipelineId).toBe("wl-period-restart");

    const restart = await executeDecision(ctx as never, meta, "restart", currentConfig);
    expect(restart.success).toBe(true);
    expect(meta.whitelistMissDenials).toBeUndefined(); // explicit new-period clear

    // Re-enter the SAME stage in the NEW period: old strikes must not
    // resurrect (the pre-fix `stored.stage === stage` check alone would
    // continue from 2 and freeze on the very first deny).
    meta.currentStage = "develop";
    expect((await run(ctx, "write", { file_path: join(TMP, "tmp/pr2.txt") }))?.block).toBe(true);
    expect(meta.whitelistMissDenials?.counts["tmp"]).toBe(1);
    expect(meta.whitelistMissDenials?.pipelineId).toBe(meta.pipelineId);
    expect(isFrozen(meta)).toBe(false); // 1 < 3: a resurrected count would have frozen
  });

  it("rollback clears the deny record explicitly", async () => {
    boot("ask");
    const meta = makeTestMeta({ pipelineId: "wl-period-rollback", currentStage: "develop", previousStage: "plan" });
    const { ctx } = harness(meta, W_DENY);
    for (let i = 0; i < 2; i++) {
      expect((await run(ctx, "write", { file_path: join(TMP, `tmp/pl${i}.txt`) }))?.block).toBe(true);
    }
    expect(meta.whitelistMissDenials?.counts["tmp"]).toBe(2);

    meta.flowState = "blocked"; // rollback precondition: frozen decision point
    const res = await executeDecision(ctx as never, meta, "rollback", currentConfig);
    expect(res.success).toBe(true);
    expect(meta.whitelistMissDenials).toBeUndefined();
  });

  it("unit: legacy / foreign-period records fail closed; same-period strikes keep counting", () => {
    boot("ask");
    const meta = makeTestMeta({ pipelineId: "wl-period-unit", currentStage: "develop" });
    // Pre-fix record WITHOUT pipelineId: fail closed rather than trusted.
    meta.whitelistMissDenials = { stage: "develop", counts: { tmp: 2 }, updatedAt: Date.now() };
    expect(readDenialCount(meta, "develop", "tmp")).toBe(0);
    // Another period's record: not readable in this one.
    meta.whitelistMissDenials = { stage: "develop", pipelineId: "pipe-old", counts: { tmp: 2 }, updatedAt: Date.now() };
    expect(readDenialCount(meta, "develop", "tmp")).toBe(0);
    // Current-period record: counts continue.
    meta.whitelistMissDenials = { stage: "develop", pipelineId: "wl-period-unit", counts: { tmp: 2 }, updatedAt: Date.now() };
    const session = {
      getMeta: () => meta,
      updateMeta: (patch: Partial<SessionMeta>) => { Object.assign(meta, patch); return meta; },
    };
    expect(recordDenial(session, meta, "develop", "tmp")).toBe(3);
    expect(readDenialCount(meta, "develop", "tmp")).toBe(3);
    // A foreign-period record is never MERGED into — it restarts the table.
    meta.whitelistMissDenials = { stage: "develop", pipelineId: "pipe-old", counts: { tmp: 2 }, updatedAt: Date.now() };
    expect(recordDenial(session, meta, "develop", "tmp")).toBe(1);
  });

  // ── Case 4b: 218 review #5 — declared hasUI=true WITHOUT a select control ─
  it("hasUI declared true + no select → visible no-UI fallback (count + audit + notify)", async () => {
    boot("ask");
    const meta = makeTestMeta({ pipelineId: "wl4b", currentStage: "develop" });
    const { ctx, menus } = harness(meta, undefined, { noUi: true });
    // The buggy shape: the host DECLARES interactivity but ships no select.
    // Pre-fix, `hasInteractiveUI` trusted the declaration → the ask silently
    // degraded inside askWriteDecision (block with zero visible evidence).
    (ctx as { hasUI?: boolean }).hasUI = true;

    const res = await run(ctx, "write", { file_path: join(TMP, "tmp/nui.txt") });
    expect(res?.block).toBe(true);
    expect(menus.length).toBe(0); // no menu was attempted
    // Now it takes the SAME visible path as an undeclared no-UI host:
    expect(meta.violations?.length).toBe(1); // read_only_path counted
    expect(meta.violations?.[0]?.guardSource).toBe("read_only_path");
    expect((await auditText()).includes("whitelist_miss_no_ui_fallback")).toBe(true);
    // …and the model is NOT promised a prompt that can never appear.
    expect(res?.reason).not.toContain("when prompted");
  });

  // ── Case 4: no interactive UI ────────────────────────────────────────────
  it("no ui.select → hard block + read_only_path count + whitelist_miss_no_ui_fallback + exit hints", async () => {
    boot("ask");
    const meta = makeTestMeta({ pipelineId: "wl4", currentStage: "develop" });
    const { ctx } = harness(meta, undefined, { noUi: true });
    const res = await run(ctx, "write", { file_path: join(TMP, "tmp/k.txt") });
    expect(res?.block).toBe(true);
    expect(res?.reason).toContain("no interactive UI");
    expect(res?.reason).toContain("$TMPDIR"); // exit hints present (hint only)
    expect(meta.violations?.length).toBe(1);
    expect(meta.violations?.[0]?.guardSource).toBe("read_only_path");
    expect((await auditText()).includes("whitelist_miss_no_ui_fallback")).toBe(true);
  });

  // ── Case 5: session allowance + protection interplay ─────────────────────
  it("sessionAllowedWritePaths → no ask; gitignored and protect.paths targets stay protected under allow", async () => {
    boot("ask");
    const meta = makeTestMeta({
      pipelineId: "wl5a", currentStage: "develop", sessionAllowedWritePaths: ["tmp/a.txt"],
    });
    const { ctx, menus } = harness(meta, undefined);
    expect(await run(ctx, "write", { file_path: join(TMP, "tmp/a.txt") })).toBeUndefined();
    expect(menus.length).toBe(0); // allowed path never asks

    // gitignore-protected target under mode allow → protected class, ask=false
    // → immediate hard block (protection never relaxes).
    boot("allow", false);
    const meta2 = makeTestMeta({ pipelineId: "wl5b", currentStage: "develop" });
    const h2 = harness(meta2, undefined);
    const r = await run(h2.ctx, "bash", { command: "echo x > .tmp-r4/db.sql" });
    expect(r?.block).toBe(true);
    expect(r?.reason).toContain("not in allowed write paths"); // protected via miss re-class
    expect(h2.menus.length).toBe(0);
  });

  // ── Case 5b (T2.6, Q24-B): out-of-root absolute file-arg targets ─────────
  it("out-of-root bash file-arg → ONE @outside ask; Deny counts '@outside'; session Allow stores absolute path", async () => {
    boot("ask");
    const OUT = join(tmpdir(), "pi-wlmiss-out-" + Date.now());
    const outTarget = join(OUT, "o.txt");
    const meta = makeTestMeta({ pipelineId: "wl5c", currentStage: "develop" });

    // (1) explicit Deny → ONE merged menu for the call, "@outside" breaker class.
    const h1 = harness(meta, W_DENY);
    const r1 = await run(h1.ctx, "bash", { command: `touch ${outTarget}` });
    expect(r1?.block).toBe(true);
    const menus1 = h1.menus.filter((m) => m.title.includes("Pipeline write approval"));
    expect(menus1.length).toBe(1);
    expect(menus1[0]!.title).toContain(outTarget);
    expect(meta.violations?.length ?? 0).toBe(0); // denied ≠ violation (D1)
    expect(meta.whitelistMissDenials?.counts["@outside"]).toBe(1);

    // (2) session Allow → the ABSOLUTE path persists, deny pressure cleared.
    const h2 = harness(meta, W_SESSION);
    expect(await run(h2.ctx, "bash", { command: `touch ${outTarget}` })).toBeUndefined();
    expect(meta.sessionAllowedWritePaths).toContain(outTarget);
    expect(meta.whitelistMissDenials).toBeUndefined(); // any Allow clears

    // (3) follow-up call passes via absolute-path bookkeeping — NO menu.
    const h3 = harness(meta, undefined);
    expect(await run(h3.ctx, "bash", { command: `touch ${outTarget}` })).toBeUndefined();
    expect(h3.menus.filter((m) => m.title.includes("Pipeline write approval")).length).toBe(0);
  });

  it("out-of-root write tool → ONE @outside ask, Deny counts '@outside' (no violation)", async () => {
    boot("ask");
    const OUT = join(tmpdir(), "pi-wlmiss-out-w-" + Date.now());
    const outTarget = join(OUT, "w.txt");
    const meta = makeTestMeta({ pipelineId: "wl5d", currentStage: "develop" });
    const { ctx, menus } = harness(meta, W_DENY);
    const res = await run(ctx, "write", { file_path: outTarget, content: "x" });
    expect(res?.block).toBe(true);
    const writeMenus = menus.filter((m) => m.title.includes("Pipeline write approval"));
    expect(writeMenus.length).toBe(1);
    expect(writeMenus[0]!.title).toContain(outTarget);
    expect(meta.whitelistMissDenials?.counts["@outside"]).toBe(1);
    expect(meta.violations?.length ?? 0).toBe(0);
  });

  // ── Case 6: read-only stage paths never reach the write menu ────────────
  it("read-only deliverable path → pre-218 hard block in every mode (no write-approval menu)", async () => {
    for (const mode of ["ask", "allow", "deny"] as WhitelistMissMode[]) {
      const config = boot(mode);
      config.stages.develop = { ...config.stages.develop, allowedReadOnlyPaths: ["specs/"] } as never;
      const meta = makeTestMeta({ pipelineId: `wl6-${mode}`, currentStage: "develop" });
      const { ctx, menus } = harness(meta, W_ONCE);
      const res = await run(ctx, "bash", { command: "echo x > specs/out.md" });
      expect(res?.block).toBe(true);
      expect(res?.reason).toContain("read-only paths"); // kind=readonly → HEAD flow
      expect(menus.filter((m) => m.title.includes("Pipeline write approval")).length).toBe(0);
    }
  });

  // ── Case 7: child never menus; asks enqueue ─────────────────────────────
  it("child whitelist-miss → block + ONE enqueued write approval per distinct batch; no menu, no counting", async () => {
    boot("ask");
    const meta = makeTestMeta({ pipelineId: "wl7", currentStage: "develop" });
    const { ctx, menus } = harness(meta, undefined, { child: true });
    const r1 = await run(ctx, "bash", { command: "echo a > tmp/x.txt; echo b > tmp/y.txt" });
    expect(r1?.block).toBe(true);
    expect(r1?.reason).toContain("owner approval");
    const r2 = await run(ctx, "bash", { command: "echo a > tmp/x.txt; echo b > tmp/y.txt" }); // same batch → dedup
    expect(r2?.block).toBe(true);
    expect(menus.length).toBe(0); // child NEVER menus in-call (D6)
    expect(meta.violations?.length ?? 0).toBe(0); // enqueue never counts (Q22-A)
    expect(isFrozen(meta)).toBe(false);
    const queued = Object.values(meta.pendingOwnerApprovals ?? {});
    expect(queued.length).toBe(1); // fingerprint dedupe on retry
    expect(queued[0]?.kind).toBe("write");
    if (queued[0]?.kind === "write") {
      expect(queued[0].targets.sort()).toEqual(["tmp/x.txt", "tmp/y.txt"]);
    }
    expect((await auditText()).includes("write_approval_queued")).toBe(true);
  });

  it("child protected-path write → immediate git_policy hard block, never enqueued (D3/R9b)", async () => {
    boot("ask");
    const meta = makeTestMeta({ pipelineId: "wl7p", currentStage: "develop" });
    const { ctx, menus } = harness(meta, undefined, { child: true });
    const res = await run(ctx, "write", { file_path: join(TMP, "secure", "s.txt"), content: "x" });
    expect(res?.block).toBe(true);
    expect(menus.length).toBe(0);
    expect(meta.pendingOwnerApprovals ?? {}).toEqual({}); // never delegated
    expect(meta.violations?.[0]?.guardSource).toBe("git_policy");
  });
});
