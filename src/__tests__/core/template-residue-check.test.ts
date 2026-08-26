import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { tmpdir } from "node:os";
import {
  checkTemplateResidues,
  computeResidueFingerprint,
  readResidueGateStatus,
  writeResidueGateStatus,
  clearResidueGateStatus,
} from "../../core/template-residue-check";

let TMP: string;

beforeEach(async () => {
  TMP = path.join(tmpdir(), "pi-residue-check-" + Date.now() + "-" + Math.random().toString(36).slice(2));
  await fs.mkdir(TMP, { recursive: true });
});

afterEach(async () => {
  await fs.rm(TMP, { recursive: true, force: true });
});

/** Helper: scaffold a minimal .pi/ tree with the given SKILL / agent contents. */
async function scaffoldPiTree(opts: {
  skills?: Record<string, string>; // stage name → SKILL.md body
  agents?: Record<string, string>; // filename (no dir) → body
}): Promise<void> {
  if (opts.skills) {
    for (const [stage, body] of Object.entries(opts.skills)) {
      const dir = path.join(TMP, ".pi", "skills", stage);
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, "SKILL.md"), body, "utf-8");
    }
  }
  if (opts.agents) {
    const agentsDir = path.join(TMP, ".pi", "agents");
    await fs.mkdir(agentsDir, { recursive: true });
    for (const [filename, body] of Object.entries(opts.agents)) {
      await fs.writeFile(path.join(agentsDir, filename), body, "utf-8");
    }
  }
}

describe("template-residue-check", () => {
  // ─── checkTemplateResidues ──────────────────────────────────────────────────

  describe("checkTemplateResidues", () => {
    it("returns clean=true when no .pi/ directory exists (fail-open)", () => {
      const result = checkTemplateResidues(TMP);
      expect(result.scanned).toBe(0);
      expect(result.hits).toEqual([]);
      expect(result.clean).toBe(true);
    });

    it("returns clean=true when .pi/ exists but scan targets are empty", async () => {
      await fs.mkdir(path.join(TMP, ".pi"), { recursive: true });
      const result = checkTemplateResidues(TMP);
      expect(result.scanned).toBe(0);
      expect(result.clean).toBe(true);
    });

    it("detects Template-TODO hits in skills and agents", async () => {
      await scaffoldPiTree({
        skills: {
          develop: "## Deliverables\n<!-- Template-TODO: 补充业务交付项 -->\n- **Template-TODO**: 补充项目特有业务交付项\n",
          review: "## Review\n<!-- Template-TODO: 替换为项目审查规范 -->\n",
        },
        agents: {
          "develop-agent.md": "## 角色\n- **Template-TODO**: 替换为你的项目角色与技术栈描述\n",
        },
      });
      const result = checkTemplateResidues(TMP);
      expect(result.scanned).toBe(3);
      expect(result.hits.length).toBe(4);
      expect(result.clean).toBe(false);
      // Each hit has file/line/marker
      for (const hit of result.hits) {
        expect(hit.file).toMatch(/^\.pi\/(skills|agents)\//);
        expect(hit.line).toBeGreaterThan(0);
        expect(hit.marker).toContain("Template-TODO");
      }
    });

    it("returns clean=true when no Template-TODO markers are present", async () => {
      await scaffoldPiTree({
        skills: {
          develop: "## Deliverables\n- **必须** run build\n",
          review: "## Review\n- **必须** 代码审查\n",
        },
        agents: {
          "develop-agent.md": "## 角色\n- 资深工程师\n",
        },
      });
      const result = checkTemplateResidues(TMP);
      expect(result.scanned).toBe(3);
      expect(result.hits).toEqual([]);
      expect(result.clean).toBe(true);
    });

    it("does not scan .pi/references/sop.md or pipeline_loop.json", async () => {
      await scaffoldPiTree({
        skills: { develop: "## Deliverables\n- **必须** run build\n" },
      });
      // Place a Template-TODO in sop.md — it should NOT be detected
      const refsDir = path.join(TMP, ".pi", "references");
      await fs.mkdir(refsDir, { recursive: true });
      await fs.writeFile(path.join(refsDir, "sop.md"), "## Template-TODO should be ignored\n", "utf-8");
      // Place a Template-TODO in pipeline_loop.json — also ignored
      await fs.writeFile(path.join(TMP, "pipeline_loop.json"), "{ \"Template-TODO\": true }", "utf-8");

      const result = checkTemplateResidues(TMP);
      expect(result.scanned).toBe(1); // only develop/SKILL.md
      expect(result.clean).toBe(true);
    });
  });

  // ─── computeResidueFingerprint ──────────────────────────────────────────────

  describe("computeResidueFingerprint", () => {
    it("returns stable fingerprint for same content", async () => {
      await scaffoldPiTree({
        skills: { develop: "## Deliverables\n- **必须** run build\n" },
      });
      const fp1 = computeResidueFingerprint(TMP);
      const fp2 = computeResidueFingerprint(TMP);
      expect(fp1).toBe(fp2);
      expect(typeof fp1).toBe("string");
      expect(fp1.length).toBeGreaterThan(0);
    });

    it("returns a fixed fingerprint when scan set is empty", () => {
      const fp1 = computeResidueFingerprint(TMP);
      const fp2 = computeResidueFingerprint(TMP);
      expect(fp1).toBe(fp2);
    });

    it("fingerprint changes when file content changes", async () => {
      await scaffoldPiTree({
        skills: { develop: "## Deliverables\n- **必须** run build\n" },
      });
      const fp1 = computeResidueFingerprint(TMP);

      // Modify the file
      const skillPath = path.join(TMP, ".pi", "skills", "develop", "SKILL.md");
      await fs.writeFile(skillPath, "## Deliverables\n- **必须** run test\n", "utf-8");
      const fp2 = computeResidueFingerprint(TMP);

      expect(fp1).not.toBe(fp2);
    });

    it("fingerprint changes when a new file is added to the scan set", async () => {
      await scaffoldPiTree({
        skills: { develop: "## Deliverables\n- **必须** run build\n" },
      });
      const fp1 = computeResidueFingerprint(TMP);

      // Add review SKILL
      const reviewDir = path.join(TMP, ".pi", "skills", "review");
      await fs.mkdir(reviewDir, { recursive: true });
      await fs.writeFile(path.join(reviewDir, "SKILL.md"), "## Review\n", "utf-8");
      const fp2 = computeResidueFingerprint(TMP);

      expect(fp1).not.toBe(fp2);
    });

    it("empty-set fingerprint differs from any real-content fingerprint", async () => {
      const fpEmpty = computeResidueFingerprint(TMP);
      await scaffoldPiTree({
        skills: { develop: "x" },
      });
      const fpReal = computeResidueFingerprint(TMP);
      expect(fpEmpty).not.toBe(fpReal);
    });
  });

  // ─── Gate status file R/W ──────────────────────────────────────────────────

  describe("gate status file", () => {
    it("readResidueGateStatus returns undefined when no status file exists", () => {
      expect(readResidueGateStatus(TMP)).toBeUndefined();
    });

    it("writeResidueGateStatus creates the file; readResidueGateStatus parses it", async () => {
      const status = {
        passed: true,
        checkedAt: "2026-01-01T00:00:00.000Z",
        fingerprint: "abc123",
      };
      writeResidueGateStatus(TMP, status);
      const read = readResidueGateStatus(TMP);
      expect(read).toEqual(status);
    });

    it("writeResidueGateStatus uses custom auditDir when provided", async () => {
      const status = {
        passed: true,
        checkedAt: "2026-01-01T00:00:00.000Z",
        fingerprint: "abc123",
      };
      const customAudit = path.join(TMP, "custom-audit");
      writeResidueGateStatus(TMP, status, customAudit);
      const read = readResidueGateStatus(TMP, customAudit);
      expect(read).toEqual(status);
    });

    it("readResidueGateStatus returns undefined for malformed JSON (fail-open)", async () => {
      const auditDir = path.join(TMP, ".pi", "audit");
      await fs.mkdir(auditDir, { recursive: true });
      await fs.writeFile(path.join(auditDir, "template-residue-check.json"), "not-json", "utf-8");
      expect(readResidueGateStatus(TMP)).toBeUndefined();
    });

    it("readResidueGateStatus returns undefined when shape is wrong (fail-open)", async () => {
      const auditDir = path.join(TMP, ".pi", "audit");
      await fs.mkdir(auditDir, { recursive: true });
      await fs.writeFile(path.join(auditDir, "template-residue-check.json"), JSON.stringify({ foo: "bar" }), "utf-8");
      expect(readResidueGateStatus(TMP)).toBeUndefined();
    });

    it("clearResidueGateStatus removes the file; read returns undefined", async () => {
      const status = {
        passed: true,
        checkedAt: "2026-01-01T00:00:00.000Z",
        fingerprint: "abc123",
      };
      writeResidueGateStatus(TMP, status);
      expect(readResidueGateStatus(TMP)).toEqual(status);
      clearResidueGateStatus(TMP);
      expect(readResidueGateStatus(TMP)).toBeUndefined();
    });

    it("clearResidueGateStatus is idempotent when file does not exist", () => {
      // Should not throw
      expect(() => clearResidueGateStatus(TMP)).not.toThrow();
    });
  });
});
