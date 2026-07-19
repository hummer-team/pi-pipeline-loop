import { describe, it, expect, beforeAll } from "bun:test";
import { getFileHash } from "../../utils/hash";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const TEST_DIR = join(tmpdir(), "pi-pipeline-hash-test-" + Date.now());

beforeAll(async () => {
  await mkdir(TEST_DIR, { recursive: true });
});

describe("getFileHash", () => {
  it("returns sha256 hex hash for readable file", async () => {
    const filePath = join(TEST_DIR, "test-file.ts");
    await writeFile(filePath, "file content");

    const result = await getFileHash(filePath);
    // SHA-256 of "file content" = 9e05e21a7fa375f5e282da78f4b5e0b7cdeae2c53b68a13d2b1c2b78954c1f66
    expect(result).toHaveLength(64);
    expect(typeof result).toBe("string");
    expect(result).toMatch(/^[a-f0-9]{64}$/);
  });

  it('returns "file-not-exists" when file cannot be read', async () => {
    const result = await getFileHash(join(TEST_DIR, "nonexistent.ts"));
    expect(result).toBe("file-not-exists");
  });

  it("computes different hashes for different content", async () => {
    const fileA = join(TEST_DIR, "file-a.ts");
    const fileB = join(TEST_DIR, "file-b.ts");
    await writeFile(fileA, "content A");
    await writeFile(fileB, "content B");

    const hashA = await getFileHash(fileA);
    const hashB = await getFileHash(fileB);

    expect(hashA).not.toBe(hashB);
    expect(hashA).toMatch(/^[a-f0-9]{64}$/);
    expect(hashB).toMatch(/^[a-f0-9]{64}$/);
  });

  it("produces consistent hashes for same content", async () => {
    const filePath = join(TEST_DIR, "consistent.ts");
    await writeFile(filePath, "same content");

    const hash1 = await getFileHash(filePath);
    const hash2 = await getFileHash(filePath);

    expect(hash1).toBe(hash2);
  });
});
