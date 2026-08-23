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
      expect(targets).toContainEqual({ kind: "file-arg", target: "src/file.ts" });
      expect(targets).toContainEqual({ kind: "file-arg", target: "dest/" });
    });

    it("extracts cp target", () => {
      const targets = extractBashFileTargets("cp src/file.ts backup/");
      expect(targets).toContainEqual({ kind: "file-arg", target: "src/file.ts" });
      expect(targets).toContainEqual({ kind: "file-arg", target: "backup/" });
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

    it("does not extract redirect from double-quoted argument (Problem 6 fix)", () => {
      // "a > b" is a quoted argument — the > is literal, not a redirect
      const targets = extractBashFileTargets('echo "a > b"');
      expect(targets).toEqual([]);
    });

    it("does not extract redirect from single-quoted argument (Problem 6 fix)", () => {
      const targets = extractBashFileTargets("echo 'a > b'");
      expect(targets).toEqual([]);
    });

    it("does not extract redirect targeting protected path inside quotes (Problem 6 fix)", () => {
      // Even if quoted content looks like a protected path, it should not be extracted
      const targets = extractBashFileTargets('echo "x > AGENTS.md"');
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

    it("extracts both source and destination for mv (Problem 8 fix)", () => {
      const targets = extractBashFileTargets("mv src/x AGENTS.md");
      expect(targets).toContainEqual({ kind: "file-arg", target: "src/x" });
      expect(targets).toContainEqual({ kind: "file-arg", target: "AGENTS.md" });
    });

    it("extracts both source and destination for cp (Problem 8 fix)", () => {
      const targets = extractBashFileTargets("cp src/x docs/y.md");
      expect(targets).toContainEqual({ kind: "file-arg", target: "src/x" });
      expect(targets).toContainEqual({ kind: "file-arg", target: "docs/y.md" });
    });

    it("extracts only source for rm (not destination-like)", () => {
      // rm only takes one target conceptually
      const targets = extractBashFileTargets("rm src/file.txt");
      expect(targets).toEqual([{ kind: "file-arg", target: "src/file.txt" }]);
    });
  });

  describe("Phase 2: fd redirect and /dev/* exclusion", () => {
    it("does NOT produce target for 2>&1 fd redirect", () => {
      const targets = extractBashFileTargets("echo hi 2>&1");
      expect(targets).toEqual([]);
    });

    it("does NOT produce target for 1>&2 fd redirect", () => {
      const targets = extractBashFileTargets("echo hi 1>&2");
      expect(targets).toEqual([]);
    });

    it("does NOT produce target for >&2 fd redirect", () => {
      const targets = extractBashFileTargets("echo hi >&2");
      expect(targets).toEqual([]);
    });

    it("does NOT produce target for > /dev/null redirect", () => {
      const targets = extractBashFileTargets("echo hi > /dev/null");
      expect(targets).toEqual([]);
    });

    it("does NOT produce target for > /dev/stderr redirect", () => {
      const targets = extractBashFileTargets("echo hi > /dev/stderr");
      expect(targets).toEqual([]);
    });

    it("does NOT produce target for >/dev/null (attached) redirect", () => {
      const targets = extractBashFileTargets("echo hi >/dev/null");
      expect(targets).toEqual([]);
    });

    it("still produces target for > /dev/./null (relative bypass)", () => {
      // /dev/./ is explicitly excluded from the /dev/* bypass to prevent bypass attacks
      const targets = extractBashFileTargets("echo hi > /dev/./null");
      expect(targets.length).toBe(1);
      expect(targets[0].kind).toBe("redirect");
    });

    it("still produces target for regular file redirect mixed with fd redirect", () => {
      const targets = extractBashFileTargets("echo hi > out.txt 2>&1");
      expect(targets).toEqual([{ kind: "redirect", target: "out.txt" }]);
    });
  });
});
