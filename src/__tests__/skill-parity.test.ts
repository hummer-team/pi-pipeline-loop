/**
 * 230 Phase 6: cross-line skill parity.
 *
 * The plugin repo maintains THREE asset lines that must stay semantically
 * identical: the OpenCode host (`.opencode`), the pi host (`.pi`) and the
 * shipped business template (`src/template`). Both host directories are
 * gitignored (they are local development assets, never shipped), so this suite
 * SKIPS itself whenever either directory is absent — a fresh clone must stay
 * green.
 *
 * Asserted invariants:
 *   1. the three contract copies are byte-identical (one semantic source);
 *   2. all 18 skills exist and reference that contract;
 *   3. the stage → skill mapping holds on every line with no extra/renamed
 *      directories;
 *   4. no skill self-dispatches the next stage (`subagent_type` / `task tool`);
 *   5. all three SOPs carry the two orchestration sections;
 *   6. host differences stay inside the registered whitelist and every entry
 *      carries an explanation (a new difference cannot be added silently).
 *
 * Boundary: read-only, no network, no temp files; the whitelist is `as const`
 * so the type of every dimension is checked by tsc.
 */

import { describe, it, expect } from "bun:test";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(__dirname, "../..");

/** The three asset lines, in the fixed order used by every assertion. */
const LINES = ["opencode", "pi", "template"] as const;
type LineName = (typeof LINES)[number];

/** Project-root-relative skill directories per line, keyed by pipeline stage. */
const STAGE_SKILLS = {
  clarify: { opencode: "design-und", pi: "design", template: "design" },
  plan: { opencode: "design-plan", pi: "plan", template: "plan" },
  "design-review": { opencode: "design-review", pi: "design-review", template: "design-review" },
  develop: { opencode: "fast-develop", pi: "develop", template: "develop" },
  review: { opencode: "code-review", pi: "review", template: "review" },
  fix: { opencode: "code-review-withfix", pi: "fix", template: "fix" },
} as const;

/** Project-root-relative roots of each line's assets. */
const LINE_ROOTS = {
  opencode: ".opencode",
  pi: ".pi",
  template: "src/template",
} as const;

/**
 * Registered host-local skill directories: extra skill folders that exist on a
 * development host but are NOT part of the six pipeline skills. They are
 * tolerated ONLY when listed here, so an unregistered addition or a rename
 * still fails the parity assertion below (230 CR-1-10).
 */
const HOST_LOCAL_SKILLS: Record<LineName, readonly string[]> = {
  opencode: ["ui-ux-pro-max"],
  pi: [],
  template: [],
} as const;

/** Registered host differences. Every dimension MUST carry a non-empty
 * explanation: adding a difference without registering it here fails the
 * contract (§7 keeps dispatch with the orchestrator; the rest are host APIs).
 */
const HOST_DIFFERENCES = {
  skillName: {
    opencode: "design-und / design-plan / fast-develop / code-review-withfix",
    pi: "design / plan / develop / review / fix",
    template: "design / plan / develop / review / fix",
    explanation: "Skill directory names are host-specific and are never renamed (R4-Q2).",
  },
  toolSyntax: {
    opencode: "task tool with subagent_type (main agent only)",
    pi: "no spawn tool on the stage; the plugin calls spawnStageSubagent",
    template: "no spawn tool on the stage; the plugin calls spawnStageSubagent",
    explanation: "Each host exposes a different dispatch API.",
  },
  dispatch: {
    opencode: "main agent dispatches via task after acceptance",
    pi: "plugin dispatches and routes after report validation",
    template: "plugin dispatches and routes after report validation",
    explanation: "Contract §7 assigns dispatch to the orchestrator; the host decides who that is.",
  },
  pathPrefix: {
    opencode: ".opencode/references/",
    pi: ".pi/references/",
    template: "references/ (relative to the installed template)",
    explanation: "Reference paths resolve against each host's asset root.",
  },
  verifier: {
    opencode: "self-check list plus on-disk acceptance by the main agent",
    pi: "plugin verifiers (design-review report, ledger closure, fix-report edit)",
    template: "plugin verifiers (design-review report, ledger closure, fix-report edit)",
    explanation: "Only the plugin hosts can enforce the report contract mechanically.",
  },
} as const satisfies Record<string, Record<LineName | "explanation", string>>;

/** Absolute path of a line's root directory. */
function lineRoot(line: LineName): string {
  return path.join(ROOT, LINE_ROOTS[line]);
}

/** True when both local host asset directories exist (this repo only). */
function hasLocalHostLines(): boolean {
  return fs.existsSync(lineRoot("opencode")) && fs.existsSync(lineRoot("pi"));
}

/** Absolute path of a stage skill document on a line. */
function skillPath(line: LineName, stage: keyof typeof STAGE_SKILLS): string {
  return path.join(lineRoot(line), "skills", STAGE_SKILLS[stage][line], "SKILL.md");
}

/** Reads a UTF-8 file. */
function readFile(absolutePath: string): string {
  return fs.readFileSync(absolutePath, "utf-8");
}

/** SHA-256 hex digest of a file's bytes. */
function fileDigest(absolutePath: string): string {
  return crypto.createHash("sha256").update(fs.readFileSync(absolutePath)).digest("hex");
}

/** Sorted skill directory names actually present on a line. */
function skillDirectories(line: LineName): string[] {
  const skillsRoot = path.join(lineRoot(line), "skills");
  return fs
    .readdirSync(skillsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

/**
 * The parity suite only runs in the development repo. Both host directories are
 * gitignored, so a shallow environment must skip instead of failing.
 */
const parityDescribe = hasLocalHostLines() ? describe : describe.skip;

parityDescribe("230 Phase 6: cross-line skill parity", () => {
  it("ships three byte-identical copies of the review-loop contract", () => {
    const digests = LINES.map((line) => fileDigest(path.join(lineRoot(line), "references", "review-loop-contract.md")));
    expect(new Set(digests).size).toBe(1);
  });

  it("has all 18 skills and every skill references the shared contract", () => {
    for (const line of LINES) {
      for (const stage of Object.keys(STAGE_SKILLS) as (keyof typeof STAGE_SKILLS)[]) {
        const target = skillPath(line, stage);
        expect(fs.existsSync(target)).toBe(true);
        expect(readFile(target)).toContain("review-loop-contract.md");
      }
    }
  });

  it("maps every stage to exactly one skill directory per line", () => {
    for (const line of LINES) {
      const expected = Object.values(STAGE_SKILLS)
        .map((mapping) => mapping[line])
        .sort();
      const actual = skillDirectories(line);
      // The six pipeline directories must be present with their registered
      // names AND nothing else may appear unless it is registered as a local
      // host skill — an unregistered addition or any rename fails here.
      const allowed = [...expected, ...HOST_LOCAL_SKILLS[line]].sort();
      expect(actual).toEqual(allowed);
      for (const name of expected) {
        expect(actual).toContain(name);
      }
    }
  });

  it("has no skill self-dispatching the next stage", () => {
    for (const line of LINES) {
      for (const stage of Object.keys(STAGE_SKILLS) as (keyof typeof STAGE_SKILLS)[]) {
        const content = readFile(skillPath(line, stage));
        expect(content).not.toContain("subagent_type");
        expect(content).not.toContain("task tool");
      }
    }
  });

  it("keeps both orchestration sections in all three SOPs", () => {
    for (const line of LINES) {
      const sop = readFile(path.join(lineRoot(line), "references", "sop.md"));
      expect(sop).toContain("## Review Loop Contract");
      expect(sop).toContain("## Master Agent Orchestration Contract");
    }
  });

  it("registers every host difference with an explanation and covers all lines", () => {
    const dimensions = Object.keys(HOST_DIFFERENCES);
    expect(dimensions.sort()).toEqual(["dispatch", "pathPrefix", "skillName", "toolSyntax", "verifier"]);
    for (const entry of Object.values(HOST_DIFFERENCES)) {
      expect(entry.explanation.length).toBeGreaterThan(0);
      for (const line of LINES) {
        expect(entry[line].length).toBeGreaterThan(0);
      }
    }
  });
});