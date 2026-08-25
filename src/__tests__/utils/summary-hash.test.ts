import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";
import crypto from "node:crypto";
import { verifySummaryHash, findFirstMismatch } from "../../utils/summary-hash";

let HASH_TMP: string;

/** Helper: write a file and return its SHA-256 hash */
async function writeAndHash(filePath: string, content: string): Promise<string> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, "utf-8");
  return crypto.createHash("sha256").update(content).digest("hex");
}

describe("summary-hash", () => {
  beforeEach(async () => {
    HASH_TMP = path.join(tmpdir(), `pi-hash-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await fs.mkdir(HASH_TMP, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(HASH_TMP, { recursive: true, force: true });
  });

  describe("verifySummaryHash", () => {
    it("returns ok when hash matches file content", async () => {
      const summaryPath = path.join(HASH_TMP, "plan.md");
      const content = "# Plan Summary\nContent";
      const hash = await writeAndHash(summaryPath, content);

      const meta = {
        summaries: { plan: { path: summaryPath, hash, status: "valid" } },
      };
      const results = verifySummaryHash(meta);

      expect(results).toHaveLength(1);
      expect(results[0].stage).toBe("plan");
      expect(results[0].match).toBe(true);
      expect(results[0].status).toBe("ok");
    });

    it("returns mismatch when file content differs from recorded hash", async () => {
      const summaryPath = path.join(HASH_TMP, "develop.md");
      const originalContent = "# Original";
      const originalHash = await writeAndHash(summaryPath, originalContent);

      // Modify file content (simulate manual edit)
      await fs.writeFile(summaryPath, "# Modified by human", "utf-8");

      const meta = {
        summaries: { develop: { path: summaryPath, hash: originalHash, status: "valid" } },
      };
      const results = verifySummaryHash(meta);

      expect(results).toHaveLength(1);
      expect(results[0].stage).toBe("develop");
      expect(results[0].match).toBe(false);
      expect(results[0].status).toBe("mismatch");
    });

    it("returns missing when file does not exist", () => {
      const summaryPath = path.join(HASH_TMP, "nonexistent.md");
      const meta = {
        summaries: { review: { path: summaryPath, hash: "abc123", status: "valid" } },
      };
      const results = verifySummaryHash(meta);

      expect(results).toHaveLength(1);
      expect(results[0].stage).toBe("review");
      expect(results[0].match).toBe(false);
      expect(results[0].status).toBe("missing");
    });

    it("handles empty summaries gracefully", () => {
      const meta = { summaries: {} };
      const results = verifySummaryHash(meta);
      expect(results).toHaveLength(0);
    });

    it("skips entries without path or hash", async () => {
      const summaryPath = path.join(HASH_TMP, "fix.md");
      await writeAndHash(summaryPath, "content");

      const meta = {
        summaries: {
          plan: { path: "", hash: "abc", status: "valid" },
          develop: { path: summaryPath, hash: "", status: "pending" },
          fix: { path: summaryPath, hash: "def", status: "valid" },
        },
      };
      const results = verifySummaryHash(meta);

      // Only "fix" has both non-empty path and hash
      expect(results).toHaveLength(1);
      expect(results[0].stage).toBe("fix");
    });

    it("handles multiple stages with mixed results", async () => {
      const planPath = path.join(HASH_TMP, "plan.md");
      const planHash = await writeAndHash(planPath, "plan content");

      const devPath = path.join(HASH_TMP, "develop.md");
      const devHash = await writeAndHash(devPath, "develop content");
      // Modify develop file
      await fs.writeFile(devPath, "modified!", "utf-8");

      const meta = {
        summaries: {
          plan: { path: planPath, hash: planHash, status: "valid" },
          develop: { path: devPath, hash: devHash, status: "valid" },
          review: { path: path.join(HASH_TMP, "missing.md"), hash: "xyz", status: "valid" },
        },
      };
      const results = verifySummaryHash(meta);

      expect(results).toHaveLength(3);
      const planResult = results.find(r => r.stage === "plan");
      const devResult = results.find(r => r.stage === "develop");
      const reviewResult = results.find(r => r.stage === "review");

      expect(planResult?.status).toBe("ok");
      expect(devResult?.status).toBe("mismatch");
      expect(reviewResult?.status).toBe("missing");
    });
  });

  describe("findFirstMismatch", () => {
    it("returns undefined when all hashes match", async () => {
      const summaryPath = path.join(HASH_TMP, "plan.md");
      const hash = await writeAndHash(summaryPath, "content");

      const meta = {
        summaries: { plan: { path: summaryPath, hash, status: "valid" } },
      };

      expect(findFirstMismatch(meta)).toBeUndefined();
    });

    it("returns stage name when mismatch found", async () => {
      const summaryPath = path.join(HASH_TMP, "develop.md");
      const originalHash = await writeAndHash(summaryPath, "original");
      await fs.writeFile(summaryPath, "modified", "utf-8");

      const meta = {
        summaries: { develop: { path: summaryPath, hash: originalHash, status: "valid" } },
      };

      expect(findFirstMismatch(meta)).toBe("develop");
    });

    it("returns first mismatched stage when multiple exist", async () => {
      const planPath = path.join(HASH_TMP, "plan.md");
      const planHash = await writeAndHash(planPath, "plan");
      await fs.writeFile(planPath, "plan modified", "utf-8");

      const devPath = path.join(HASH_TMP, "develop.md");
      const devHash = await writeAndHash(devPath, "dev");
      await fs.writeFile(devPath, "dev modified", "utf-8");

      const meta = {
        summaries: {
          plan: { path: planPath, hash: planHash, status: "valid" },
          develop: { path: devPath, hash: devHash, status: "valid" },
        },
      };

      // Should return the first one encountered
      const mismatch = findFirstMismatch(meta);
      expect(mismatch).toBeDefined();
      expect(["plan", "develop"]).toContain(mismatch as string);
    });
  });
});
