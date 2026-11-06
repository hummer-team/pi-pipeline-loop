/**
 * 225 code-review fix (issue 5): static layering guard against runtime
 * dependency cycles around the verify pipeline.
 *
 * History: `commit-contract.ts` imported `parseVerifyFile` from
 * `auto-verifier.ts` at runtime, while `auto-verifier.ts` imports
 * `hasCommitRequirement` from `commit-contract.ts` — a RUNTIME cycle that
 * only worked because the parse call was lazily executed in a function body.
 * The parser was sunk to the `verify-file-parser.ts` LEAF; this guard pins
 * the restored one-directional dependency so no future wiring re-closes it
 * (same idiom as `subagent-rpc.test.ts` "no runtime imports from ../core/").
 */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = join(process.cwd(), "src", "core");

/** Matches a runtime (non type-only) import edge. */
function runtimeImportEdges(sourcePath: string): string[] {
  const lines = readFileSync(sourcePath, "utf-8").split("\n");
  const edges: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!/from\s+["']\.\/|from\s+["']\.\.\//.test(line)) continue;
    // `import type` and inline `type` specifiers are erased at compile time.
    if (/^\s*import\s+type\s+/.test(line)) continue;
    edges.push(`Line ${i + 1}: ${line.trim()}`);
  }
  return edges;
}

describe("static guard: verify pipeline stays acyclic (issue 5)", () => {
  it("commit-contract.ts has NO runtime import from auto-verifier", () => {
    const edges = runtimeImportEdges(join(SRC, "commit-contract.ts")).filter((edge) =>
      edge.includes('"./auto-verifier"'),
    );
    expect(edges).toEqual([]);
  });

  it("git-invariants.ts has NO runtime import from auto-verifier", () => {
    const edges = runtimeImportEdges(join(SRC, "git-invariants.ts")).filter((edge) =>
      edge.includes('"./auto-verifier"'),
    );
    expect(edges).toEqual([]);
  });

  it("verify-file-parser.ts is a leaf: no runtime import of core siblings", () => {
    const edges = runtimeImportEdges(join(SRC, "verify-file-parser.ts")).filter(
      (edge) =>
        edge.includes('"./auto-verifier"') ||
        edge.includes('"./commit-contract"') ||
        edge.includes('"./commit-proof"'),
    );
    expect(edges).toEqual([]);
  });

  it("auto-verifier re-exports parseVerifyFile from the leaf (one direction only)", () => {
    const content = readFileSync(join(SRC, "auto-verifier.ts"), "utf-8");
    expect(content).toContain('from "./verify-file-parser"');
  });
});
