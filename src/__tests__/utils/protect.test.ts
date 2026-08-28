import { describe, it, expect } from "bun:test";
import {
  resolveProtectConfig,
  normalizeAllow,
  isPathAllowed,
  isPathAllowedWrite,
  isHardcodedProtected,
  isPathProtectedForModify,
  isPathProtectedForGit,
  toProjectRelative,
  type ProtectState,
} from "../../utils/protect";
import { ALLOWED_WRITE_ALL } from "../../constants";
import { makeTestConfig } from "../helpers";

describe("resolveProtectConfig", () => {
  it("uses defaults when protect is undefined", () => {
    const config = makeTestConfig();
    delete (config as any).protect;
    const state = resolveProtectConfig(config, null);
    expect(state.hardcoded).toContain(".pi/");
    expect(state.hardcoded).not.toContain("AGENTS.md");
    expect(state.hardcoded).toContain(".git/");
    expect(state.allow).toEqual([]);
    expect(state.gitignore).toBeNull();
  });

  it("AGENTS.md is NOT protected by default but can be added via protect.paths", () => {
    const configDefault = makeTestConfig();
    delete (configDefault as any).protect;
    const stateDefault = resolveProtectConfig(configDefault, null);
    expect(stateDefault.hardcoded).not.toContain("AGENTS.md");

    const configWithAgents = makeTestConfig({
      protect: { paths: ["AGENTS.md"] },
    });
    const stateWithAgents = resolveProtectConfig(configWithAgents, null);
    expect(stateWithAgents.hardcoded).toContain("AGENTS.md");
  });

  it("merges user paths with hardcoded", () => {
    const config = makeTestConfig({
      protect: { paths: ["dist/", "build/"] },
    });
    const state = resolveProtectConfig(config, null);
    expect(state.hardcoded).toContain(".pi/");
    expect(state.hardcoded).toContain("dist/");
    expect(state.hardcoded).toContain("build/");
  });

  it("normalizes allow entries", () => {
    const config = makeTestConfig({
      protect: { allow: ["docs", "src/template/", "README.md"] },
    });
    const state = resolveProtectConfig(config, null);
    expect(state.allow).toContain("docs/");
    expect(state.allow).toContain("src/template/");
    expect(state.allow).toContain("README.md");
  });
});

describe("normalizeAllow", () => {
  it("adds trailing / to directory entries", () => {
    expect(normalizeAllow(["docs"])).toEqual(["docs/"]);
    expect(normalizeAllow(["src/template"])).toEqual(["src/template/"]);
  });

  it("keeps trailing / if already present", () => {
    expect(normalizeAllow(["docs/"])).toEqual(["docs/"]);
  });

  it("keeps file entries as-is", () => {
    expect(normalizeAllow(["README.md"])).toEqual(["README.md"]);
    expect(normalizeAllow(["package.json"])).toEqual(["package.json"]);
  });

  it("treats dotted directory paths as directories (Problem 5 fix)", () => {
    // "docs/design.v2" contains "/" so it's a directory path, not a file
    expect(normalizeAllow(["docs/design.v2"])).toEqual(["docs/design.v2/"]);
    expect(normalizeAllow(["src/template.v2"])).toEqual(["src/template.v2/"]);
  });

  it("treats root-level dotted entries as files", () => {
    // Root-level "v1.0" has no "/" and has extension → treated as file
    expect(normalizeAllow(["v1.0"])).toEqual(["v1.0"]);
  });
});

describe("isPathAllowed", () => {
  it("matches directory prefix exactly", () => {
    const allow = ["docs/", "src/template/"];
    expect(isPathAllowed("docs/file.md", allow)).toBe(true);
    expect(isPathAllowed("docs/sub/file.md", allow)).toBe(true);
    expect(isPathAllowed("src/template/index.md", allow)).toBe(true);
  });

  it("does not match similar prefix (boundary check)", () => {
    const allow = ["src/template/"];
    expect(isPathAllowed("src/template-old/file.md", allow)).toBe(false);
    expect(isPathAllowed("src/templates/file.md", allow)).toBe(false);
  });

  it("matches file entries exactly", () => {
    const allow = ["README.md"];
    expect(isPathAllowed("README.md", allow)).toBe(true);
    expect(isPathAllowed("docs/README.md", allow)).toBe(false);
  });

  it("does not match unmatched paths", () => {
    const allow = ["docs/"];
    expect(isPathAllowed("src/index.ts", allow)).toBe(false);
  });
});

describe("isPathAllowedWrite", () => {
  it("returns true when allowedWritePaths contains '**'", () => {
    expect(isPathAllowedWrite("src/index.ts", [ALLOWED_WRITE_ALL])).toBe(true);
    expect(isPathAllowedWrite("docs/file.md", [ALLOWED_WRITE_ALL])).toBe(true);
    expect(isPathAllowedWrite(".pi/config.json", [ALLOWED_WRITE_ALL])).toBe(true);
  });

  it("returns false when allowedWritePaths is empty array", () => {
    expect(isPathAllowedWrite("docs/file.md", [])).toBe(false);
    expect(isPathAllowedWrite("src/index.ts", [])).toBe(false);
  });

  it("returns true when allowedWritePaths is undefined (backward compatible)", () => {
    expect(isPathAllowedWrite("any/path.ts", undefined)).toBe(true);
  });

  it("matches directory prefix for multi-candidate whitelist", () => {
    const paths = ["docs/", "doc/", "documentation/"];
    expect(isPathAllowedWrite("docs/file.md", paths)).toBe(true);
    expect(isPathAllowedWrite("docs/sub/file.md", paths)).toBe(true);
    expect(isPathAllowedWrite("doc/readme.md", paths)).toBe(true);
    expect(isPathAllowedWrite("documentation/guide.md", paths)).toBe(true);
  });

  it("does not match paths outside whitelist", () => {
    const paths = ["docs/", "doc/", "documentation/"];
    expect(isPathAllowedWrite("src/index.ts", paths)).toBe(false);
    expect(isPathAllowedWrite("lib/utils.ts", paths)).toBe(false);
  });

  it("does not match similar prefix (boundary check)", () => {
    const paths = ["docs/"];
    expect(isPathAllowedWrite("docs-old/file.md", paths)).toBe(false);
    expect(isPathAllowedWrite("docsx/file.md", paths)).toBe(false);
  });

  it("normalizes entries without trailing slash", () => {
    expect(isPathAllowedWrite("docs/file.md", ["docs"])).toBe(true);
  });
});

describe("isHardcodedProtected", () => {
  it("matches .pi/ directory", () => {
    const hardcoded = [".pi/", ".git/"];
    expect(isHardcodedProtected(".pi/agents/clarify.md", hardcoded)).toBe(true);
    expect(isHardcodedProtected(".pi", hardcoded)).toBe(true);
  });

  it("matches AGENTS.md only when explicitly in hardcoded list", () => {
    const withAgents = [".pi/", "AGENTS.md", ".git/"];
    expect(isHardcodedProtected("AGENTS.md", withAgents)).toBe(true);
    expect(isHardcodedProtected("src/AGENTS.md", withAgents)).toBe(false);

    const withoutAgents = [".pi/", ".git/"];
    expect(isHardcodedProtected("AGENTS.md", withoutAgents)).toBe(false);
  });

  it("matches .git/ directory", () => {
    const hardcoded = [".pi/", ".git/"];
    expect(isHardcodedProtected(".git/config", hardcoded)).toBe(true);
    expect(isHardcodedProtected(".git", hardcoded)).toBe(true);
  });

  it("matches user-configured paths", () => {
    const hardcoded = [".pi/", "dist/", "build/"];
    expect(isHardcodedProtected("dist/bundle.js", hardcoded)).toBe(true);
    expect(isHardcodedProtected("build/output.exe", hardcoded)).toBe(true);
  });
});

describe("isPathProtectedForModify", () => {
  it("blocks hardcoded paths (allow cannot exempt)", () => {
    const state: ProtectState = {
      hardcoded: [".pi/", ".git/"],
      allow: [".pi/", ".git/"], // Try to exempt
      gitignore: null,
    };
    expect(isPathProtectedForModify(".pi/test.md", state)).toBe(true);
    expect(isPathProtectedForModify(".git/config", state)).toBe(true);
  });

  it("allows paths in allow list (exempts from gitignore)", () => {
    const state: ProtectState = {
      hardcoded: [".pi/"],
      allow: ["docs/"],
      gitignore: null, // No gitignore
    };
    expect(isPathProtectedForModify("docs/file.md", state)).toBe(false);
  });

  it("blocks paths not in allow list when gitignore matches", () => {
    const mockGitignore = {
      matcher: { ignores: (p: string) => p.startsWith("logs/") },
      patterns: ["logs/"],
    };
    const state: ProtectState = {
      hardcoded: [".pi/"],
      allow: ["docs/"], // Only docs is allowed
      gitignore: mockGitignore as any,
    };
    expect(isPathProtectedForModify("logs/app.log", state)).toBe(true);
    expect(isPathProtectedForModify("docs/file.md", state)).toBe(false);
  });
});

describe("isPathProtectedForGit", () => {
  it("blocks hardcoded paths", () => {
    const state: ProtectState = {
      hardcoded: [".pi/", ".git/"],
      allow: [],
      gitignore: null,
    };
    expect(isPathProtectedForGit(".pi/test.md", state)).toBe(true);
    expect(isPathProtectedForGit(".git/config", state)).toBe(true);
  });

  it("blocks gitignore-matched paths even if in allow list", () => {
    const mockGitignore = {
      matcher: { ignores: (p: string) => p.startsWith("docs/") },
      patterns: ["docs/"],
    };
    const state: ProtectState = {
      hardcoded: [".pi/"],
      allow: ["docs/"], // Allow edit but not git
      gitignore: mockGitignore as any,
    };
    expect(isPathProtectedForGit("docs/file.md", state)).toBe(true);
  });

  it("allows non-protected paths", () => {
    const mockGitignore = {
      matcher: { ignores: (p: string) => p.startsWith("logs/") },
      patterns: ["logs/"],
    };
    const state: ProtectState = {
      hardcoded: [".pi/"],
      allow: [],
      gitignore: mockGitignore as any,
    };
    expect(isPathProtectedForGit("src/index.ts", state)).toBe(false);
  });
});

describe("toProjectRelative", () => {
  it("converts absolute path to relative", () => {
    const result = toProjectRelative("/project", "/project/src/index.ts");
    expect(result).toBe("src/index.ts");
  });

  it("returns null for paths outside project", () => {
    const result = toProjectRelative("/project", "/other/file.ts");
    expect(result).toBeNull();
  });

  it("handles path normalization", () => {
    const result = toProjectRelative("/project", "/project/src/../src/index.ts");
    expect(result).toBe("src/index.ts");
  });

  it("does not misidentify ..foo as outside project (Problem 10 fix)", () => {
    // A path named "..foo" inside the project should NOT be treated as outside
    const result = toProjectRelative("/project", "/project/..foo");
    expect(result).toBe("..foo");
  });

  it("returns null for parent directory reference", () => {
    const result = toProjectRelative("/project", "/project/../other");
    expect(result).toBeNull();
  });
});
