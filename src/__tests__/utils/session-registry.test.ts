import { describe, it, expect, beforeEach } from "bun:test";
import { registerSession, lookupParentPipeline, resolveRegistryPath } from "../../utils/session-registry";
import { makeTestConfig } from "../helpers";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("session-registry", () => {
  let TMP: string;

  beforeEach(async () => {
    TMP = join(tmpdir(), "pi-sr-" + Date.now() + "-" + Math.random().toString(36).slice(2));
    await mkdir(join(TMP, ".pi", "audit"), { recursive: true });
  });

  it("resolveRegistryPath returns expected path", () => {
    const config = makeTestConfig({ projectRoot: TMP, auditDir: ".pi/audit" });
    const result = resolveRegistryPath(config);
    expect(result).toBe(join(TMP, ".pi", "audit", "session-registry.json"));
  });

  it("register + lookup O(1) hit", async () => {
    const config = makeTestConfig({ projectRoot: TMP });
    await registerSession(config, "session-abc", "pipe-001");

    const result = await lookupParentPipeline(config, "session-abc");
    expect(result).toBe("pipe-001");
  });

  it("lookup returns null for unregistered session", async () => {
    const config = makeTestConfig({ projectRoot: TMP });
    const result = await lookupParentPipeline(config, "nonexistent-session");
    expect(result).toBeNull();
  });

  it("lookup returns null for corrupt JSON (fail-open)", async () => {
    const config = makeTestConfig({ projectRoot: TMP });
    // Write corrupt JSON to registry path
    const registryPath = resolveRegistryPath(config);
    await writeFile(registryPath, "NOT VALID JSON{{{", "utf-8");

    const result = await lookupParentPipeline(config, "session-abc");
    expect(result).toBeNull();
  });

  it("lookup returns null for missing registry file (fail-open)", async () => {
    const config = makeTestConfig({ projectRoot: TMP });
    // No registry file exists
    const result = await lookupParentPipeline(config, "session-abc");
    expect(result).toBeNull();
  });

  it("upsert overwrites old pipelineId", async () => {
    const config = makeTestConfig({ projectRoot: TMP });
    await registerSession(config, "session-abc", "pipe-001");
    await registerSession(config, "session-abc", "pipe-002");

    const result = await lookupParentPipeline(config, "session-abc");
    expect(result).toBe("pipe-002");
  });

  it("register with empty sessionFile is a no-op", async () => {
    const config = makeTestConfig({ projectRoot: TMP });
    await registerSession(config, "", "pipe-001");

    // Registry file should not exist (no write happened)
    const result = await lookupParentPipeline(config, "");
    expect(result).toBeNull();
  });

  it("lookup with empty parentSessionFile returns null", async () => {
    const config = makeTestConfig({ projectRoot: TMP });
    const result = await lookupParentPipeline(config, "");
    expect(result).toBeNull();
  });

  it("multiple sessions registered independently", async () => {
    const config = makeTestConfig({ projectRoot: TMP });
    await registerSession(config, "session-1", "pipe-A");
    await registerSession(config, "session-2", "pipe-B");

    expect(await lookupParentPipeline(config, "session-1")).toBe("pipe-A");
    expect(await lookupParentPipeline(config, "session-2")).toBe("pipe-B");
  });
});
