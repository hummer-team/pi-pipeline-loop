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
  resolveDesignReviewReportTemplate,
} from "../../core/design-review/resource-preflight";
import { CONFIG_DIR_NAME } from "../../constants";

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
