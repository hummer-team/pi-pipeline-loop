/**
 * 194 Phase 2 (task 2, first slice): unit tests for the design-review report
 * template resource resolver.
 *
 * Guards the acceptance fact "a review agent without bash can read the exact
 * template": the dispatched prompt must carry an ABSOLUTE path built from
 * config only, and a not-deployed asset must resolve to `null` so the prompt
 * omits the line instead of sending the executor on a directory search.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { PipelineConfig } from "../../types";
import {
  DESIGN_REVIEW_REPORT_TEMPLATE_FILE,
  parseAgentDeclaredTools,
  preflightDesignReviewDispatchResources,
  resolveDesignReviewReportTemplate,
} from "../../core/design-review/resource-preflight";
import { CONFIG_DIR_NAME } from "../../constants";
import { makeTestConfig } from "../helpers";

const cleanups: string[] = [];

/** Temp project root, removed after the test run. */
async function makeRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-194-preflight-"));
  cleanups.push(root);
  return root;
}

function makeConfig(projectRoot: string, overrides?: Partial<PipelineConfig>): PipelineConfig {
  return { projectRoot, ...overrides } as PipelineConfig;
}

afterEach(async () => {
  while (cleanups.length > 0) {
    const dir = cleanups.pop()!;
    if (existsSync(dir)) {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

describe("194 Phase 2: resolveDesignReviewReportTemplate", () => {
  test("resolves the deployed template to an absolute path under the default work dir", async () => {
    const root = await makeRoot();
    const refDir = path.join(root, CONFIG_DIR_NAME, "references");
    await mkdir(refDir, { recursive: true });
    const templatePath = path.join(refDir, DESIGN_REVIEW_REPORT_TEMPLATE_FILE);
    await writeFile(templatePath, "# template\n", "utf8");

    const resolved = await resolveDesignReviewReportTemplate(makeConfig(root));
    expect(resolved).toBe(templatePath);
    expect(path.isAbsolute(resolved!)).toBe(true);
  });

  test("honours a custom piWorkDir", async () => {
    const root = await makeRoot();
    const refDir = path.join(root, "tools/pi/v1", "references");
    await mkdir(refDir, { recursive: true });
    const templatePath = path.join(refDir, DESIGN_REVIEW_REPORT_TEMPLATE_FILE);
    await writeFile(templatePath, "# template\n", "utf8");

    const resolved = await resolveDesignReviewReportTemplate(
      makeConfig(root, { piWorkDir: "tools/pi/v1" } as Partial<PipelineConfig>),
    );
    expect(resolved).toBe(templatePath);
  });

  test("returns null when the asset is not deployed (prompt then omits the line)", async () => {
    const root = await makeRoot();
    expect(await resolveDesignReviewReportTemplate(makeConfig(root))).toBeNull();
  });

  test("returns null when the template path is a directory, not a file", async () => {
    const root = await makeRoot();
    await mkdir(path.join(root, CONFIG_DIR_NAME, "references", DESIGN_REVIEW_REPORT_TEMPLATE_FILE), {
      recursive: true,
    });
    expect(await resolveDesignReviewReportTemplate(makeConfig(root))).toBeNull();
  });

  test("is config-derived: no filesystem search, stable across calls", async () => {
    const root = await makeRoot();
    const refDir = path.join(root, CONFIG_DIR_NAME, "references");
    await mkdir(refDir, { recursive: true });
    // A same-named file elsewhere in the tree must NOT be picked up: the
    // resolver builds its path from config only, never from a search.
    await mkdir(path.join(root, "docs"), { recursive: true });
    await writeFile(path.join(root, "docs", DESIGN_REVIEW_REPORT_TEMPLATE_FILE), "decoy\n", "utf8");
    const templatePath = path.join(refDir, DESIGN_REVIEW_REPORT_TEMPLATE_FILE);
    await writeFile(templatePath, "# t\n", "utf8");

    const first = await resolveDesignReviewReportTemplate(makeConfig(root));
    const second = await resolveDesignReviewReportTemplate(makeConfig(root));
    expect(first).toBe(templatePath);
    expect(second).toBe(templatePath);
  });
});

/** Write the deployed assets a real /pipeline-init project would have. */
async function deployAssets(root: string, agentToolsLine: string): Promise<void> {
  const agentsDir = path.join(root, "agents");
  const skillsDir = path.join(root, CONFIG_DIR_NAME, "skills", "test-skill");
  const refsDir = path.join(root, CONFIG_DIR_NAME, "references");
  await mkdir(agentsDir, { recursive: true });
  await mkdir(skillsDir, { recursive: true });
  await mkdir(refsDir, { recursive: true });
  await writeFile(path.join(agentsDir, "test-agent.md"), `---\nname: test-agent\n${agentToolsLine}\n---\nbody\n`, "utf8");
  await writeFile(path.join(skillsDir, "SKILL.md"), "# skill\n", "utf8");
  await writeFile(path.join(refsDir, DESIGN_REVIEW_REPORT_TEMPLATE_FILE), "# template\n", "utf8");
}

const REVIEW_DOCS = { writeDocs: ["docs/r1_report.md"], readOnlyDocs: ["docs/p_plan.md"] };

describe("194 Phase 2: preflightDesignReviewDispatchResources", () => {
  test("fully deployed review passes and reports absolute assets + declared tools", async () => {
    const root = await makeRoot();
    await deployAssets(root, "tools: read, grep, find, ls, write, edit");
    const result = await preflightDesignReviewDispatchResources({
      config: makeTestConfig({ projectRoot: root }),
      kind: "review",
      ...REVIEW_DOCS,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(path.isAbsolute(result.agentDoc)).toBe(true);
    expect(result.templateDoc).toBe(
      path.join(root, CONFIG_DIR_NAME, "references", DESIGN_REVIEW_REPORT_TEMPLATE_FILE),
    );
    expect(result.tools).toEqual(["read", "grep", "find", "ls", "write", "edit"]);
  });

  test("missing template blocks the REVIEW kind with a template issue", async () => {
    const root = await makeRoot();
    await deployAssets(root, "tools: read, write");
    await rm(path.join(root, CONFIG_DIR_NAME, "references", DESIGN_REVIEW_REPORT_TEMPLATE_FILE));
    const result = await preflightDesignReviewDispatchResources({
      config: makeTestConfig({ projectRoot: root }),
      kind: "review",
      ...REVIEW_DOCS,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.map((i) => i.resource)).toContain("template");
  });

  test("undeclared tools are NOT a mismatch (SDK default surface stays usable)", async () => {
    const root = await makeRoot();
    await deployAssets(root, "");
    const result = await preflightDesignReviewDispatchResources({
      config: makeTestConfig({ projectRoot: root }),
      kind: "review",
      ...REVIEW_DOCS,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.tools).toEqual([]);
  });

  test("agent declaring tools WITHOUT write is a blocking mismatch (task 3)", async () => {
    const root = await makeRoot();
    await deployAssets(root, "tools: read, grep, find, ls");
    const result = await preflightDesignReviewDispatchResources({
      config: makeTestConfig({ projectRoot: root }),
      kind: "review",
      ...REVIEW_DOCS,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const toolsIssue = result.issues.find((i) => i.resource === "tools");
    expect(toolsIssue).toBeDefined();
    expect(toolsIssue!.reason).toContain("write");
  });

  test("unconfigured agentPath is a config-level blocking issue", async () => {
    const root = await makeRoot();
    const config = makeTestConfig({ projectRoot: root });
    config.stages["design-review"] = { ...config.stages["design-review"]!, agentPath: "" };
    const result = await preflightDesignReviewDispatchResources({
      config,
      kind: "review",
      ...REVIEW_DOCS,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.some((i) => i.resource === "agent" && i.path === "")).toBe(true);
  });

  test("write target resolving onto a read-only input is a conflict issue", async () => {
    const root = await makeRoot();
    await deployAssets(root, "tools: read, write");
    const result = await preflightDesignReviewDispatchResources({
      config: makeTestConfig({ projectRoot: root }),
      kind: "review",
      writeDocs: ["docs/p_plan.md"],
      readOnlyDocs: ["docs/p_plan.md"],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.map((i) => i.resource)).toContain("conflict");
  });

  test("update kind needs plan agent/skill but NOT the review template", async () => {
    const root = await makeRoot();
    await deployAssets(root, "tools: read, write");
    await rm(path.join(root, CONFIG_DIR_NAME, "references", DESIGN_REVIEW_REPORT_TEMPLATE_FILE));
    const result = await preflightDesignReviewDispatchResources({
      config: makeTestConfig({ projectRoot: root }),
      kind: "update",
      writeDocs: ["docs/p_plan.md"],
      readOnlyDocs: ["docs/r1_report.md"],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.templateDoc).toBeNull();
  });
});

describe("194 Phase 2: parseAgentDeclaredTools", () => {
  test("extracts the frontmatter tools list (lower-cased, trimmed)", () => {
    expect(parseAgentDeclaredTools("---\ntools: Read, BASH , write\n---\nbody")).toEqual([
      "read",
      "bash",
      "write",
    ]);
  });

  test("no frontmatter or no tools line yields an empty list", () => {
    expect(parseAgentDeclaredTools("# plain markdown")).toEqual([]);
    expect(parseAgentDeclaredTools("---\nname: x\n---\nbody")).toEqual([]);
  });
});
