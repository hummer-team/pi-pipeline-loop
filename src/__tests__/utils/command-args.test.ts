import { describe, it, expect } from "bun:test";
import { parseCommandArgs } from "../../utils/command-args";

/**
 * Parameterized contract tests for parseCommandArgs.
 *
 * The registered command names (hyphenated) MUST match the case labels inside
 * parseCommandArgs. This file guards against the 136_E2E_Bug regression where
 * "pipeline_start" / "pipeline_status" (underscore) drifted from the actual
 * registration names "pipeline-start" / "pipeline-status", causing the
 * doc_file argument to silently fall into the default branch.
 */

// Registered command names as declared in src/commands/*.ts (name field).
// If a new command is added, append it here so the drift-guard loop covers it.
const REGISTERED_COMMAND_NAMES: string[] = [
  "pipeline-init",
  "pipeline-start",
  "pipeline-status",
  "pipeline-quit",
];

// Underscore variants that MUST fall through to default (proves hyphen is required).
const UNDERSCORE_VARIANTS: string[] = ["pipeline_start", "pipeline_status"];

describe("parseCommandArgs", () => {
  // ─── Core regression: the 136 bug ────────────────────────────────────────
  it("returns { file, forwardArgs, raw } for pipeline-start with a doc path (136_E2E_Bug regression)", () => {
    const result = parseCommandArgs("pipeline-start", "docs/design/76_E2E_Feat.md");
    expect(result).toEqual({ file: "docs/design/76_E2E_Feat.md", forwardArgs: "", raw: "docs/design/76_E2E_Feat.md" });
    // Critical: file MUST NOT be undefined — that was the bug.
    expect(result.file).toBeDefined();
    expect(typeof result.file).toBe("string");
  });

  it("returns { file: '', forwardArgs: '' } for pipeline-start with empty args", () => {
    expect(parseCommandArgs("pipeline-start", "")).toEqual({ file: "", forwardArgs: "", raw: "" });
  });

  it("trims whitespace around file argument", () => {
    expect(parseCommandArgs("pipeline-start", "  docs/req.md  ")).toEqual({
      file: "docs/req.md",
      forwardArgs: "",
      raw: "  docs/req.md  ",
    });
  });

  // ─── Phase 3 (171): pipeline-start tail parameter split ──

  it("Phase 3 (171): pipeline-start splits file from forwardArgs (simple)", () => {
    expect(parseCommandArgs("pipeline-start", "docs/design/82_Feat.md 1")).toEqual({
      file: "docs/design/82_Feat.md",
      forwardArgs: "1",
      raw: "docs/design/82_Feat.md 1",
    });
  });

  it("Phase 3 (171): pipeline-start splits file from forwardArgs (full-und?)", () => {
    expect(parseCommandArgs("pipeline-start", "docs/design/82_Feat.md full-und?")).toEqual({
      file: "docs/design/82_Feat.md",
      forwardArgs: "full-und?",
      raw: "docs/design/82_Feat.md full-und?",
    });
  });

  it("Phase 3 (171): pipeline-start splits file from forwardArgs (1 答)", () => {
    expect(parseCommandArgs("pipeline-start", "docs/design/82_Feat.md 1 答")).toEqual({
      file: "docs/design/82_Feat.md",
      forwardArgs: "1 答",
      raw: "docs/design/82_Feat.md 1 答",
    });
  });

  it("Phase 3 (171): pipeline-start with multiple spaces preserves forwardArgs", () => {
    expect(parseCommandArgs("pipeline-start", "docs/spec.md   full-und?  ")).toEqual({
      file: "docs/spec.md",
      forwardArgs: "full-und?",
      raw: "docs/spec.md   full-und?  ",
    });
  });

  // ─── pipeline-init ────────────────────────────────────────────────────────
  it("returns { sub } for pipeline-init with a subcommand", () => {
    expect(parseCommandArgs("pipeline-init", "1")).toEqual({ sub: "1" });
  });

  it("returns { sub: '' } for pipeline-init with empty args", () => {
    expect(parseCommandArgs("pipeline-init", "")).toEqual({ sub: "" });
  });

  // ─── pipeline-status / pipeline-quit (no-arg commands) ───────────────────
  it("returns {} for pipeline-status regardless of args", () => {
    expect(parseCommandArgs("pipeline-status", "")).toEqual({});
    expect(parseCommandArgs("pipeline-status", "ignored")).toEqual({});
  });

  it("returns {} for pipeline-quit regardless of args", () => {
    expect(parseCommandArgs("pipeline-quit", "")).toEqual({});
    expect(parseCommandArgs("pipeline-quit", "ignored")).toEqual({});
  });

  // ─── Default branch (unknown commands) ───────────────────────────────────
  it("returns { raw } for unknown command names (default branch)", () => {
    expect(parseCommandArgs("unknown-cmd", "x")).toEqual({ raw: "x" });
    expect(parseCommandArgs("pipeline_start", "y")).toEqual({ raw: "y" });
    expect(parseCommandArgs("pipeline_status", "z")).toEqual({ raw: "z" });
  });

  // ─── Drift guard: every registered command must have an explicit case ────
  // If this loop ever fails, it means the parseCommandArgs switch is out of
  // sync with command registration — exactly the 136 bug pattern.
  for (const cmdName of REGISTERED_COMMAND_NAMES) {
    it(`drift guard: '${cmdName}' has an explicit case (not default branch)`, () => {
      const result = parseCommandArgs(cmdName, "sentinel-value");
      // pipeline-start has a "raw" field but all other explicit cases don't.
      // The key property is that the command has an explicit case (produces `file`
      // or `sub`) rather than falling to default (only produces `raw`).
      if (cmdName === "pipeline-start") {
        expect(result.file).toBeDefined();
      } else if (cmdName === "pipeline-init") {
        expect(result.sub).toBeDefined();
      } else {
        // pipeline-status / pipeline-quit: explicit case returns {}, default returns {raw}
        expect(result.raw).toBeUndefined();
      }
    });
  }

  // Underscore variants (the bug pattern) MUST fall through to default.
  for (const underscoreName of UNDERSCORE_VARIANTS) {
    it(`underscore variant '${underscoreName}' falls through to default (proves hyphen is required)`, () => {
      const result = parseCommandArgs(underscoreName, "data");
      expect(result).toEqual({ raw: "data" });
      expect(result.file).toBeUndefined();
      expect(result.sub).toBeUndefined();
    });
  }
});
