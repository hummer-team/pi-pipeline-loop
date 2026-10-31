/**
 * 219 Phase 0 (B1/M4): fine-grained protect policy keys.
 *
 * Covers:
 * - the two read-point resolver functions (`resolveDestructiveCommandPolicy` /
 *   `resolveProtectedPathPolicy`) over the ask × newKey matrix
 * - configs that never went through `resolvePipelineConfig` (M4 regression)
 * - loader validation: invalid values warn AND inherit `protect.ask`
 * - `whitelistAllow` normalization (trim / dedupe / reject absolute + "..")
 * - behavior-level guards: ① legacy default unchanged, ② ask:true dialogs,
 *   ③ literal non-resolved config dialogs, ④ B1 truth-table rows 3/4,
 *   ⑤ destructiveCommand governs only the destructive branch.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { createToolGuard } from "../../core/tool-guard";
import { loadJsonConfig, resolvePipelineConfig } from "../../core/json-config-loader";
import {
  resolveDestructiveCommandPolicy,
  resolveProtectedPathPolicy,
  resolveWhitelistAllowGlobs,
} from "../../utils/protect";
import { makeTestConfig, makeTestMeta, createMockCtx, auditLogFileFor } from "../helpers";
import { writeFile, mkdir, readFile } from "node:fs/promises";
import { writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resetGitignoreCache } from "../../utils/gitignore";
import { initAuditLog } from "../../utils/auditLog";
import type { PipelineConfig } from "../../types";

const ASK_FOLLOW_DEFAULT = "Follow plugin default rules (default)";

// ─── Resolver matrix (pure) ──────────────────────────────────────────────────

describe("protect policy resolvers — 219 B1/M4", () => {
  describe(resolveDestructiveCommandPolicy.name, () => {
    it("matrix: unset key inherits ask (ask true → ask, false/absent → deny)", () => {
      expect(resolveDestructiveCommandPolicy({} as PipelineConfig)).toBe("deny");
      expect(resolveDestructiveCommandPolicy({ protect: {} } as PipelineConfig)).toBe("deny");
      expect(resolveDestructiveCommandPolicy({ protect: { ask: false } } as PipelineConfig)).toBe("deny");
      expect(resolveDestructiveCommandPolicy({ protect: { ask: true } } as PipelineConfig)).toBe("ask");
    });

    it("matrix: explicit key wins over ask in both directions", () => {
      expect(resolveDestructiveCommandPolicy({ protect: { ask: true, destructiveCommand: "deny" } } as PipelineConfig)).toBe("deny");
      expect(resolveDestructiveCommandPolicy({ protect: { ask: false, destructiveCommand: "ask" } } as PipelineConfig)).toBe("ask");
    });

    it("M4: a bare config literal (no resolvePipelineConfig) still resolves correctly", () => {
      // Direct literal — the defensive read point must not depend on the resolver.
      const literal = { protect: { ask: true } } as PipelineConfig;
      expect(resolveDestructiveCommandPolicy(literal)).toBe("ask");
    });
  });

  describe(resolveProtectedPathPolicy.name, () => {
    it("matrix: unset key inherits ask (ask true → ask, false/absent → deny)", () => {
      expect(resolveProtectedPathPolicy({} as PipelineConfig)).toBe("deny");
      expect(resolveProtectedPathPolicy({ protect: {} } as PipelineConfig)).toBe("deny");
      expect(resolveProtectedPathPolicy({ protect: { ask: false } } as PipelineConfig)).toBe("deny");
      expect(resolveProtectedPathPolicy({ protect: { ask: true } } as PipelineConfig)).toBe("ask");
    });

    it("matrix: explicit key wins over ask in both directions", () => {
      expect(resolveProtectedPathPolicy({ protect: { ask: true, protectedPathPolicy: "deny" } } as PipelineConfig)).toBe("deny");
      expect(resolveProtectedPathPolicy({ protect: { ask: false, protectedPathPolicy: "ask" } } as PipelineConfig)).toBe("ask");
    });

    it("M4: a bare config literal (no resolvePipelineConfig) still resolves correctly", () => {
      const literal = { protect: { ask: true } } as PipelineConfig;
      expect(resolveProtectedPathPolicy(literal)).toBe("ask");
    });
  });

  it("resolveWhitelistAllowGlobs tolerates missing protect / invalid values → []", () => {
    expect(resolveWhitelistAllowGlobs({} as PipelineConfig)).toEqual([]);
    expect(resolveWhitelistAllowGlobs({ protect: { whitelistAllow: ["docs/**"] } } as PipelineConfig)).toEqual(["docs/**"]);
  });

  it("protect.allow and whitelistAllow coexist without interacting", () => {
    const config = { protect: { allow: ["docs/design/"], whitelistAllow: ["src/*.ts"] } } as PipelineConfig;
    expect(resolveWhitelistAllowGlobs(config)).toEqual(["src/*.ts"]);
    expect(resolveProtectedPathPolicy(config)).toBe("deny");
  });
});

// ─── Loader validation ───────────────────────────────────────────────────────

describe("protect policy keys — json-config-loader validation", () => {
  let TMP: string;
  let warns: string[];
  const origWarn = console.warn;

  beforeEach(async () => {
    TMP = join(tmpdir(), `pi-219-policy-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await mkdir(join(TMP, ".pi"), { recursive: true });
    warns = [];
    console.warn = (msg: string) => { warns.push(msg); };
  });

  afterEach(() => {
    console.warn = origWarn;
    try { rmSync(TMP, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  function writeConfig(json: Record<string, unknown>): string {
    const p = join(TMP, "pipeline_loop.json");
    writeFileSync(p, JSON.stringify(json), "utf8");
    return p;
  }

  function minimalStages(): Record<string, unknown> {
    return Object.fromEntries(
      ["clarify", "plan", "design-review", "develop", "review", "fix", "awaiting_human", "completed"].map((s) => [
        s,
        { agentPath: "./agents/test-agent.md", skillPath: "test-skill/SKILL.md", nextStage: "plan" },
      ]),
    );
  }

  it("invalid destructiveCommand values warn and stay unset (inherit ask)", () => {
    const p = writeConfig({
      stages: minimalStages(),
      protect: { ask: true, destructiveCommand: "allow" },
    });
    const json = loadJsonConfig(p);
    expect(json.protect?.destructiveCommand).toBeUndefined();
    expect(warns.some((w) => w.includes("protect.destructiveCommand"))).toBe(true);
    const config = resolvePipelineConfig(json);
    // Inheritance: ask survives, dangerous-policy falls back to it.
    expect(resolveDestructiveCommandPolicy(config)).toBe("ask");
  });

  it("non-string destructiveCommand (123 / null) warns and inherits", () => {
    const p = writeConfig({
      stages: minimalStages(),
      protect: { ask: false, destructiveCommand: 123 },
    });
    const json = loadJsonConfig(p);
    expect(json.protect?.destructiveCommand).toBeUndefined();
    expect(resolveDestructiveCommandPolicy(resolvePipelineConfig(json))).toBe("deny");
  });

  it("invalid protectedPathPolicy warns and stays unset", () => {
    const p = writeConfig({
      stages: minimalStages(),
      protect: { ask: true, protectedPathPolicy: "allow" },
    });
    const json = loadJsonConfig(p);
    expect(json.protect?.protectedPathPolicy).toBeUndefined();
    expect(warns.some((w) => w.includes("protect.protectedPathPolicy"))).toBe(true);
  });

  it("valid keys survive load + resolve with defaults", () => {
    const p = writeConfig({
      stages: minimalStages(),
      protect: { ask: false, destructiveCommand: "ask", protectedPathPolicy: "deny", whitelistAllow: ["docs/**"] },
    });
    const config = resolvePipelineConfig(loadJsonConfig(p));
    expect(config.protect?.destructiveCommand).toBe("ask");
    expect(config.protect?.protectedPathPolicy).toBe("deny");
    expect(config.protect?.whitelistAllow).toEqual(["docs/**"]);
    expect(config.audit?.autoDecisions).toBe(true); // default true
  });

  it("whitelistAllow: trims, drops empties, dedupes, rejects absolute and ..", () => {
    const p = writeConfig({
      stages: minimalStages(),
      protect: {
        whitelistAllow: ["docs/**", " docs/** ", "", "/abs/path", "../escape", "src/*.ts"],
      },
    });
    const json = loadJsonConfig(p);
    expect(json.protect?.whitelistAllow).toEqual(["docs/**", "src/*.ts"]);
    expect(warns.some((w) => w.includes("/abs/path"))).toBe(true);
    expect(warns.some((w) => w.includes("../escape"))).toBe(true);
  });

  it("audit.autoDecisions non-boolean warns and defaults to true", () => {
    const p = writeConfig({
      stages: minimalStages(),
      audit: { autoDecisions: "yes" },
    });
    const json = loadJsonConfig(p);
    expect(warns.some((w) => w.includes("audit.autoDecisions"))).toBe(true);
    expect((resolvePipelineConfig(json)).audit?.autoDecisions).toBe(true);
  });
});

// ─── Behavior: tool-guard wiring (scenes ①–⑤) ────────────────────────────────

describe("protect policy keys — tool-guard behavior wiring (219 acceptance)", () => {
  let TMP: string;

  beforeEach(async () => {
    resetGitignoreCache();
    TMP = join(tmpdir(), `pi-219-guard-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await mkdir(join(TMP, "docs"), { recursive: true });
    await mkdir(join(TMP, ".pi"), { recursive: true });
    await writeFile(join(TMP, ".gitignore"), "docs\n");
    await writeFile(join(TMP, "docs", "file.md"), "content\n");
  });

  afterEach(() => {
    try { rmSync(TMP, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  async function runGuard(config: PipelineConfig, selectReturn?: string): Promise<{ result: unknown; audit: string }> {
    await initAuditLog(config);
    const meta = makeTestMeta();
    const ctx = createMockCtx(meta, { selectReturn });
    ctx.toolCall = { name: "write", arguments: { file_path: join(TMP, "docs", "file.md") } };
    const hook = createToolGuard(config);
    const result = await hook.handler(ctx as never);
    const auditFile = auditLogFileFor(join(TMP, ".pi", "audit"));
    const audit = await readFile(auditFile, "utf-8").catch(() => "");
    return { result, audit };
  }

  it("② legacy: ask:true + no new key → protected edit still dialog (pipeline_protect_ask)", async () => {
    const config = makeTestConfig({ projectRoot: TMP, protect: { gitignore: true, ask: true } });
    const { result, audit } = await runGuard(config, ASK_FOLLOW_DEFAULT);
    expect((result as { block?: boolean }).block).toBe(true);
    expect((result as { reason?: string }).reason).toContain("gitignore protected");
    expect(audit).toContain("pipeline_protect_ask");
  });

  it("③ M4: literal config (no resolvePipelineConfig) with ask:true → dialog still used", async () => {
    const literal = makeTestConfig({ projectRoot: TMP, protect: { gitignore: true, ask: true } });
    const { result, audit } = await runGuard(literal, ASK_FOLLOW_DEFAULT);
    expect((result as { block?: boolean }).block).toBe(true);
    expect(audit).toContain("pipeline_protect_ask");
  });

  it("B1 row 4: ask:true + protectedPathPolicy:'deny' → hard block, NO dialog", async () => {
    const config = makeTestConfig({
      projectRoot: TMP,
      protect: { gitignore: true, ask: true, protectedPathPolicy: "deny" },
    });
    const { result, audit } = await runGuard(config);
    expect((result as { block?: boolean }).block).toBe(true);
    expect((result as { reason?: string }).reason).toContain("gitignore protected");
    expect(audit).not.toContain("pipeline_protect_ask");
  });

  it("B1 row 3: ask:false + protectedPathPolicy:'ask' → dialog appears", async () => {
    const config = makeTestConfig({
      projectRoot: TMP,
      protect: { gitignore: true, ask: false, protectedPathPolicy: "ask" },
    });
    const { result, audit } = await runGuard(config, ASK_FOLLOW_DEFAULT);
    expect((result as { block?: boolean }).block).toBe(true);
    expect((result as { reason?: string }).reason).toContain("gitignore protected");
    expect(audit).toContain("pipeline_protect_ask");
  });

  it("① legacy: ask:false + no new key → hard block, no dialog (pre-change verbatim)", async () => {
    const config = makeTestConfig({ projectRoot: TMP, protect: { gitignore: true } });
    const { result, audit } = await runGuard(config);
    expect((result as { block?: boolean }).block).toBe(true);
    expect((result as { reason?: string }).reason).toContain("gitignore protected");
    expect(audit).not.toContain("pipeline_protect_ask");
  });
});

describe("destructiveCommand — tool-guard behavior wiring", () => {
  let TMP: string;

  beforeEach(async () => {
    resetGitignoreCache();
    TMP = join(tmpdir(), `pi-219-destructive-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await mkdir(join(TMP, ".pi"), { recursive: true });
  });

  afterEach(() => {
    try { rmSync(TMP, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  async function runBash(config: PipelineConfig, selectReturn?: string): Promise<{ result: unknown; audit: string }> {
    await initAuditLog(config);
    const meta = makeTestMeta();
    const ctx = createMockCtx(meta, { selectReturn });
    ctx.toolCall = { name: "bash", arguments: { command: "sudo ls" } };
    const hook = createToolGuard(config);
    const result = await hook.handler(ctx as never);
    const auditFile = auditLogFileFor(join(TMP, ".pi", "audit"));
    const audit = await readFile(auditFile, "utf-8").catch(() => "");
    return { result, audit };
  }

  it("legacy ask:true → dialog; destructiveCommand:'deny' → hard block without dialog", async () => {
    const withDialog = makeTestConfig({ projectRoot: TMP, protect: { ask: true } });
    const dialog = await runBash(withDialog, ASK_FOLLOW_DEFAULT);
    expect((dialog.result as { block?: boolean }).block).toBe(true);
    expect((dialog.result as { reason?: string }).reason).toContain("Destructive command blocked");
    expect(dialog.audit).toContain("pipeline_command_ask");

    const tightened = makeTestConfig({ projectRoot: TMP, protect: { ask: true, destructiveCommand: "deny" } });
    const auditBefore = dialog.audit.length;
    const hard = await runBash(tightened);
    expect((hard.result as { block?: boolean }).block).toBe(true);
    // Deny = the HEAD fallback branch (no dialog path), distinct wording
    expect((hard.result as { reason?: string }).reason).toContain("Enable protect.ask for user confirmation");
    // Tail-only: the dialog event above shares one audit file in this test.
    expect(hard.audit.slice(auditBefore)).not.toContain("pipeline_command_ask");
  });

  it("unset legacy ask:false + destructiveCommand:'ask' → dialog appears (opt-in)", async () => {
    const relaxed = makeTestConfig({ projectRoot: TMP, protect: { ask: false, destructiveCommand: "ask" } });
    const { result, audit } = await runBash(relaxed, ASK_FOLLOW_DEFAULT);
    expect((result as { block?: boolean }).block).toBe(true);
    expect(audit).toContain("pipeline_command_ask");
  });
});
