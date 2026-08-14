import { describe, it, expect } from "bun:test";
import { extractBashFileTargets } from "../../utils/bash-parse";

describe("extractBashFileTargets", () => {
  describe("redirect targets", () => {
    it("extracts > target (separate token)", () => {
      const targets = extractBashFileTargets("echo hi > docs/x.md");
      expect(targets).toEqual([{ kind: "redirect", target: "docs/x.md" }]);
    });

    it("extracts >> target (append)", () => {
      const targets = extractBashFileTargets("echo hi >> logs/app.log");
      expect(targets).toEqual([{ kind: "redirect", target: "logs/app.log" }]);
    });

    it("extracts >| target (force)", () => {
      const targets = extractBashFileTargets("echo hi >| output.txt");
      expect(targets).toEqual([{ kind: "redirect", target: "output.txt" }]);
    });

    it("extracts >target (attached)", () => {
      const targets = extractBashFileTargets("echo hi >docs/x.md");
      expect(targets).toEqual([{ kind: "redirect", target: "docs/x.md" }]);
    });

    it("handles quoted targets", () => {
      const targets = extractBashFileTargets('echo hi > "docs/x.md"');
      expect(targets).toEqual([{ kind: "redirect", target: "docs/x.md" }]);
    });

    it("handles single-quoted targets", () => {
      const targets = extractBashFileTargets("echo hi > 'docs/x.md'");
      expect(targets).toEqual([{ kind: "redirect", target: "docs/x.md" }]);
    });
  });

  describe("file-argument commands", () => {
    it("extracts rm target", () => {
      const targets = extractBashFileTargets("rm docs/x.md");
      expect(targets).toEqual([{ kind: "file-arg", target: "docs/x.md" }]);
    });

    it("extracts rm target with flags", () => {
      const targets = extractBashFileTargets("rm -rf docs");
      expect(targets).toEqual([{ kind: "file-arg", target: "docs" }]);
    });

    it("extracts rm target after --", () => {
      const targets = extractBashFileTargets("rm -- docs/x.md");
      expect(targets).toEqual([{ kind: "file-arg", target: "docs/x.md" }]);
    });

    it("extracts mv target (first file arg)", () => {
      const targets = extractBashFileTargets("mv src/file.ts dest/");
      expect(targets).toEqual([{ kind: "file-arg", target: "src/file.ts" }]);
    });

    it("extracts cp target", () => {
      const targets = extractBashFileTargets("cp src/file.ts backup/");
      expect(targets).toEqual([{ kind: "file-arg", target: "src/file.ts" }]);
    });

    it("extracts touch target", () => {
      const targets = extractBashFileTargets("touch new-file.txt");
      expect(targets).toEqual([{ kind: "file-arg", target: "new-file.txt" }]);
    });

    it("extracts tee target", () => {
      const targets = extractBashFileTargets("tee output.log");
      expect(targets).toEqual([{ kind: "file-arg", target: "output.log" }]);
    });

    it("handles quoted file arguments", () => {
      const targets = extractBashFileTargets('rm "docs/x.md"');
      expect(targets).toEqual([{ kind: "file-arg", target: "docs/x.md" }]);
    });
  });

  describe("non-targets (should not extract)", () => {
    it("does not extract from ls command", () => {
      const targets = extractBashFileTargets("ls -la docs/");
      expect(targets).toEqual([]);
    });

    it("does not extract from grep in pipe", () => {
      const targets = extractBashFileTargets("ls | grep rm");
      expect(targets).toEqual([]);
    });

    it("does not extract rm inside string", () => {
      // The string "rm foo" is an argument to echo, not a command
      const targets = extractBashFileTargets('echo "rm foo" > note.md');
      // Should only extract the redirect target, not "rm foo"
      expect(targets).toEqual([{ kind: "redirect", target: "note.md" }]);
    });

    it("handles command with no file arguments", () => {
      const targets = extractBashFileTargets("npm test");
      expect(targets).toEqual([]);
    });

    it("handles cat (not in file-arg commands)", () => {
      const targets = extractBashFileTargets("cat file.txt");
      expect(targets).toEqual([]);
    });
  });

  describe("complex cases", () => {
    it("extracts multiple targets from redirect chain", () => {
      const targets = extractBashFileTargets("cat a.txt > b.txt >> c.txt");
      expect(targets).toContainEqual({ kind: "redirect", target: "b.txt" });
      expect(targets).toContainEqual({ kind: "redirect", target: "c.txt" });
    });

    it("extracts both redirect and file-arg", () => {
      const targets = extractBashFileTargets("rm old.txt > log.txt");
      expect(targets).toContainEqual({ kind: "file-arg", target: "old.txt" });
      expect(targets).toContainEqual({ kind: "redirect", target: "log.txt" });
    });

    it("handles rm with multiple flags before file", () => {
      const targets = extractBashFileTargets("rm -r -f -v docs/");
      expect(targets).toEqual([{ kind: "file-arg", target: "docs/" }]);
    });
  });
});
