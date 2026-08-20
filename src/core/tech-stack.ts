/**
 * @module tech-stack
 * Detects the project's technology stack by probing for characteristic files
 * (pom.xml, build.gradle, package.json, Cargo.toml, pyproject.toml).
 * Used by verify-generator to inject tech-stack context into the LLM extraction
 * prompt so it emits project-appropriate build/test commands rather than
 * defaulting to a specific ecosystem (e.g. Node/Bun).
 */

import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Result of tech stack detection.
 * - toolchain: canonical identifier for the detected toolchain
 * - hints: recommended build + test commands for this project
 */
export interface TechStackInfo {
  toolchain: string;
  hints: string;
}

/**
 * Detects the project's primary tech stack by probing characteristic files.
 *
 * Detection priority (first match wins):
 * 1. pom.xml / mvnw → Maven (./mvnw clean compile + ./mvnw clean test)
 * 2. build.gradle / build.gradle.kts / gradlew → Gradle (./gradlew build + ./gradlew test)
 * 3. package.json → npm/yarn/pnpm/bun (npm run build + npm test)
 * 4. Cargo.toml → cargo (cargo build + cargo test)
 * 5. pyproject.toml → python (python -m build + python -m pytest)
 *
 * @param projectRoot - Absolute path to the project root directory
 * @returns TechStackInfo with toolchain identifier and command hints, or null if no stack detected
 */
export async function detectTechStack(projectRoot: string): Promise<TechStackInfo | null> {
  try {
    // Maven
    if (
      fileExists(projectRoot, "pom.xml") ||
      fileExists(projectRoot, "mvnw") ||
      fileExists(projectRoot, ".mvn")
    ) {
      return {
        toolchain: "maven",
        hints: "./mvnw clean compile, ./mvnw clean test",
      };
    }

    // Gradle
    if (
      fileExists(projectRoot, "build.gradle") ||
      fileExists(projectRoot, "build.gradle.kts") ||
      fileExists(projectRoot, "gradlew")
    ) {
      return {
        toolchain: "gradle",
        hints: "./gradlew build, ./gradlew test",
      };
    }

    // Node.js ecosystem (npm/yarn/pnpm/bun)
    if (fileExists(projectRoot, "package.json")) {
      // Detect which package manager is in use
      let toolchain = "npm";
      let hints = "npm run build, npm test";
      if (fileExists(projectRoot, "bun.lockb") || fileExists(projectRoot, "bun.lock")) {
        toolchain = "bun";
        hints = "bun run build, bun test";
      } else if (fileExists(projectRoot, "pnpm-lock.yaml")) {
        toolchain = "pnpm";
        hints = "pnpm run build, pnpm test";
      } else if (fileExists(projectRoot, "yarn.lock")) {
        toolchain = "yarn";
        hints = "yarn build, yarn test";
      }
      return { toolchain, hints };
    }

    // Rust / Cargo
    if (fileExists(projectRoot, "Cargo.toml")) {
      return {
        toolchain: "cargo",
        hints: "cargo build, cargo test",
      };
    }

    // Python
    if (fileExists(projectRoot, "pyproject.toml") || fileExists(projectRoot, "setup.py")) {
      return {
        toolchain: "python",
        hints: "python -m build, python -m pytest",
      };
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * Synchronous helper to check if a file/directory exists at the given path
 * relative to projectRoot.
 */
function fileExists(projectRoot: string, relativePath: string): boolean {
  try {
    return fs.existsSync(path.join(projectRoot, relativePath));
  } catch {
    return false;
  }
}
