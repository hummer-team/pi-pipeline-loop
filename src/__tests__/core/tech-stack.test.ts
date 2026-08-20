import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { detectTechStack } from "../../core/tech-stack";

let TMP: string;

beforeEach(async () => {
  TMP = path.join(tmpdir(), "pi-techstack-" + Date.now() + "-" + Math.random().toString(36).slice(2));
  await fs.mkdir(TMP, { recursive: true });
});

afterEach(async () => {
  await fs.rm(TMP, { recursive: true, force: true });
});

describe("detectTechStack", () => {
  it("returns maven when pom.xml is present", async () => {
    await fs.writeFile(path.join(TMP, "pom.xml"), "<project/>", "utf-8");
    const result = await detectTechStack(TMP);
    expect(result).not.toBeNull();
    expect(result!.toolchain).toBe("maven");
    expect(result!.hints).toContain("./mvnw");
    expect(result!.hints).toContain("compile");
    expect(result!.hints).toContain("test");
  });

  it("returns maven when mvnw wrapper is present (no pom.xml)", async () => {
    await fs.writeFile(path.join(TMP, "mvnw"), "#!/bin/sh\n", "utf-8");
    const result = await detectTechStack(TMP);
    expect(result).not.toBeNull();
    expect(result!.toolchain).toBe("maven");
  });

  it("returns gradle when build.gradle is present", async () => {
    await fs.writeFile(path.join(TMP, "build.gradle"), "", "utf-8");
    const result = await detectTechStack(TMP);
    expect(result).not.toBeNull();
    expect(result!.toolchain).toBe("gradle");
    expect(result!.hints).toContain("./gradlew");
    expect(result!.hints).toContain("build");
  });

  it("returns gradle when build.gradle.kts is present", async () => {
    await fs.writeFile(path.join(TMP, "build.gradle.kts"), "", "utf-8");
    const result = await detectTechStack(TMP);
    expect(result!.toolchain).toBe("gradle");
  });

  it("returns gradle when gradlew wrapper is present", async () => {
    await fs.writeFile(path.join(TMP, "gradlew"), "#!/bin/sh\n", "utf-8");
    const result = await detectTechStack(TMP);
    expect(result!.toolchain).toBe("gradle");
  });

  it("returns npm by default for package.json projects", async () => {
    await fs.writeFile(path.join(TMP, "package.json"), "{}", "utf-8");
    const result = await detectTechStack(TMP);
    expect(result).not.toBeNull();
    expect(result!.toolchain).toBe("npm");
    expect(result!.hints).toContain("npm");
  });

  it("returns bun when bun.lockb is present", async () => {
    await fs.writeFile(path.join(TMP, "package.json"), "{}", "utf-8");
    await fs.writeFile(path.join(TMP, "bun.lockb"), "", "utf-8");
    const result = await detectTechStack(TMP);
    expect(result!.toolchain).toBe("bun");
    expect(result!.hints).toContain("bun");
  });

  it("returns pnpm when pnpm-lock.yaml is present", async () => {
    await fs.writeFile(path.join(TMP, "package.json"), "{}", "utf-8");
    await fs.writeFile(path.join(TMP, "pnpm-lock.yaml"), "", "utf-8");
    const result = await detectTechStack(TMP);
    expect(result!.toolchain).toBe("pnpm");
  });

  it("returns yarn when yarn.lock is present", async () => {
    await fs.writeFile(path.join(TMP, "package.json"), "{}", "utf-8");
    await fs.writeFile(path.join(TMP, "yarn.lock"), "", "utf-8");
    const result = await detectTechStack(TMP);
    expect(result!.toolchain).toBe("yarn");
  });

  it("returns cargo when Cargo.toml is present", async () => {
    await fs.writeFile(path.join(TMP, "Cargo.toml"), "[package]\n", "utf-8");
    const result = await detectTechStack(TMP);
    expect(result!.toolchain).toBe("cargo");
    expect(result!.hints).toContain("cargo");
  });

  it("returns python when pyproject.toml is present", async () => {
    await fs.writeFile(path.join(TMP, "pyproject.toml"), "[project]\n", "utf-8");
    const result = await detectTechStack(TMP);
    expect(result!.toolchain).toBe("python");
  });

  it("returns null when no characteristic file is found", async () => {
    const result = await detectTechStack(TMP);
    expect(result).toBeNull();
  });

  it("maven has higher priority than package.json when both present", async () => {
    await fs.writeFile(path.join(TMP, "pom.xml"), "<project/>", "utf-8");
    await fs.writeFile(path.join(TMP, "package.json"), "{}", "utf-8");
    const result = await detectTechStack(TMP);
    expect(result!.toolchain).toBe("maven");
  });
});
