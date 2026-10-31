/**
 * 219 Phase 0 (H1): the `protect.whitelistAllow` whitelist-miss exemption.
 *
 * Covers:
 * - `whitelistMiss:"deny"` + glob hit → pass + throttled `whitelist_allow_exempt` audit
 * - `whitelistMiss:"deny"` + no glob hit → pre-218 hard block verbatim
 * - `whitelistMiss:"ask"` + glob hit → pass WITHOUT any dialog
 * - negatives: protected (gitignore / hardcoded) paths are NEVER exempted;
 *   out-of-root targets hit by the same glob are still blocked.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { createToolGuard } from "../../core/tool-guard";
import { makeTestConfig, makeTestMeta, createMockCtx, auditLogFileFor } from "../helpers";
import { writeFile, mkdir, readFile } from "node:fs/promises";
import { writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resetGitignoreCache } from "../../utils/gitignore";
import { initAuditLog } from "../../utils/auditLog";
import { __resetMemoryThrottle } from "../../utils/audit-throttle";
import type { PipelineConfig, SessionMeta } from "../../types";

/**
 * Build a whitelist-mode config: every stage only allows `data/`, so a write
 * to `docs/**` or `src/*.ts` is a whitelist miss.
 */
function whitelistConfig(projectRoot: string, protect: PipelineConfig["protect"]): PipelineConfig {
  const base = makeTestConfig({ projectRoot, protect });
  return {
    ...base,
    stages: Object.fromEntries(
      Object.entries(base.stages).map(([stage, cfg]) => [
        stage,
        { ...cfg, allowedWritePaths: ["data/"] },
      ]),
    ),
  } as PipelineConfig;
}

describe("protect.whitelistAllow — whitelist-miss exemption (219 H1)", () => {
  let TMP: string;

  beforeEach(async () => {
    resetGitignoreCache();
    // Throttle isolation: the exemption audit is process-window throttled.
    __resetMemoryThrottle();
    TMP = join(tmpdir(), `pi-219-wlallow-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await mkdir(join(TMP, "docs"), { recursive: true });
    await mkdir(join(TMP, "src"), { recursive: true });
    await mkdir(join(TMP, "data"), { recursive: true });
    await mkdir(join(TMP, ".pi"), { recursive: true });
    await writeFile(join(TMP, "docs", "file.md"), "content\n");
    await writeFile(join(TMP, "src", "code.ts"), "code\n");
  });

  afterEach(() => {
    try { rmSync(TMP, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  async function runWrite(
    config: PipelineConfig,
    filePath: string,
    metaOverrides?: Partial<SessionMeta>,
    selectReturn?: string,
  ): Promise<{ result: unknown; audit: string }> {
    await initAuditLog(config);
    const meta = makeTestMeta({ ...metaOverrides });
    const ctx = createMockCtx(meta, { selectReturn });
    ctx.toolCall = { name: "write", arguments: { file_path: filePath } };
    const hook = createToolGuard(config);
    const result = await hook.handler(ctx as never);
    const auditFile = auditLogFileFor(join(config.projectRoot, ".pi", "audit"));
    const audit = await readFile(auditFile, "utf-8").catch(() => "");
    return { result, audit };
  }

  it("deny mode + glob hit (docs/**) → pass + whitelist_allow_exempt audit", async () => {
    const config = whitelistConfig(TMP, {
      gitignore: false,
      whitelistMiss: "deny",
      whitelistAllow: ["docs/**", "src/*.ts"],
    });
    const { result, audit } = await runWrite(config, join(TMP, "docs", "file.md"));
    expect(result).toBeUndefined();
    expect(audit).toContain("whitelist_allow_exempt");
  });

  it("deny mode + glob hit via src/*.ts single-star glob → pass", async () => {
    const config = whitelistConfig(TMP, { gitignore: false, whitelistMiss: "deny", whitelistAllow: ["src/*.ts"] });
    const { result } = await runWrite(config, join(TMP, "src", "code.ts"));
    expect(result).toBeUndefined();
  });

  it("deny mode + NO glob hit → hard block (pre-218 verbatim reason)", async () => {
    const config = whitelistConfig(TMP, { gitignore: false, whitelistMiss: "deny", whitelistAllow: ["src/*.ts"] });
    const { result } = await runWrite(config, join(TMP, "docs", "file.md"));
    expect((result as { block?: boolean }).block).toBe(true);
    expect((result as { reason?: string }).reason).toContain("not in allowed write paths for 'develop' stage");
  });

  it("ask mode + glob hit → pass WITHOUT dialog (no pipeline_write ask audit)", async () => {
    const config = whitelistConfig(TMP, { gitignore: false, whitelistMiss: "ask", whitelistAllow: ["docs/**"] });
    const { result, audit } = await runWrite(config, join(TMP, "docs", "file.md"));
    expect(result).toBeUndefined();
    expect(audit).not.toContain("whitelist_miss");
  });

  it("protected path (gitignore) hit by the same glob → still blocked (protection never relaxes)", async () => {
    writeFileSync(join(TMP, ".gitignore"), "docs\n", "utf8");
    resetGitignoreCache();
    const config = whitelistConfig(TMP, {
      gitignore: true,
      whitelistMiss: "deny",
      whitelistAllow: ["docs/**"],
    });
    const { result, audit } = await runWrite(config, join(TMP, "docs", "file.md"));
    expect((result as { block?: boolean }).block).toBe(true);
    expect((result as { reason?: string }).reason).toContain("FORBIDDEN");
    expect(audit).not.toContain("whitelist_allow_exempt");
  });

  it("hardcoded-protected path (.pi/domains, '**' glob) → still blocked", async () => {
    await mkdir(join(TMP, ".pi", "domains"), { recursive: true });
    const config = whitelistConfig(TMP, {
      gitignore: false,
      whitelistMiss: "deny",
      whitelistAllow: ["**"],
    } as PipelineConfig["protect"]);
    const { result } = await runWrite(config, join(TMP, ".pi", "domains", "x.md"));
    expect((result as { block?: boolean }).block).toBe(true);
    expect((result as { reason?: string }).reason).toContain("FORBIDDEN");
  });

  it("whitelist-hit paths need no exemption (gitignore implicitly bypassed by whitelist)", async () => {
    await writeFile(join(TMP, ".gitignore"), "data\n", "utf8");
    resetGitignoreCache();
    const config = whitelistConfig(TMP, { gitignore: true, whitelistMiss: "deny" });
    const { result } = await runWrite(config, join(TMP, "data", "new.md"));
    expect(result).toBeUndefined();
  });

  it("throttling: consecutive exempted writes within the window log the exemption once", async () => {
    const config = whitelistConfig(TMP, { gitignore: false, whitelistMiss: "deny", whitelistAllow: ["docs/**"] });
    await initAuditLog(config);
    const meta = makeTestMeta();
    const hook = createToolGuard(config);
    for (const name of ["a.md", "b.md", "c.md"]) {
      await writeFile(join(TMP, "docs", name), "x\n");
      const ctx = createMockCtx(meta, {});
      ctx.toolCall = { name: "write", arguments: { file_path: join(TMP, "docs", name) } };
      await hook.handler(ctx as never);
    }
    const audit = await readFile(auditLogFileFor(join(TMP, ".pi", "audit")), "utf-8").catch(() => "");
    const lines = audit.split("\n").filter((l) => l.includes("whitelist_allow_exempt"));
    expect(lines.length).toBe(1);
  });
});
