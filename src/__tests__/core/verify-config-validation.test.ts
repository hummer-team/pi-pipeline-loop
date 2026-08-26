import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { diagnoseVerifyConfig } from "../../core/auto-verifier";

let TMP: string;

beforeEach(async () => {
  TMP = path.join(tmpdir(), "pi-verify-config-" + Date.now());
  await fs.mkdir(TMP, { recursive: true });
});

afterEach(async () => {
  await fs.rm(TMP, { recursive: true, force: true });
});

describe("diagnoseVerifyConfig", () => {
  it("returns file_missing when verify.md does not exist", async () => {
    const result = await diagnoseVerifyConfig(path.join(TMP, "nonexistent.md"));
    expect(result.ok).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].code).toBe("file_missing");
    expect(result.errors[0].detail).toContain("not found");
  });

  it("returns frontmatter_missing when file has no --- delimiters", async () => {
    const fp = path.join(TMP, "verify.md");
    await fs.writeFile(fp, "Just some text without frontmatter\n", "utf-8");

    const result = await diagnoseVerifyConfig(fp);
    expect(result.ok).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].code).toBe("frontmatter_missing");
    expect(result.errors[0].detail).toContain("---");
  });

  it("returns yaml_parse_error when frontmatter is empty", async () => {
    const fp = path.join(TMP, "verify.md");
    await fs.writeFile(fp, "---\n---\nBody\n", "utf-8");

    const result = await diagnoseVerifyConfig(fp);
    expect(result.ok).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].code).toBe("yaml_parse_error");
  });

  it("returns no_rules when frontmatter has rules: but no actual rules", async () => {
    const fp = path.join(TMP, "verify.md");
    await fs.writeFile(fp, "---\nrules:\n---\nBody\n", "utf-8");

    const result = await diagnoseVerifyConfig(fp);
    expect(result.ok).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].code).toBe("no_rules");
  });

  it("returns unknown_top_level_key for unrecognized keys", async () => {
    const fp = path.join(TMP, "verify.md");
    await fs.writeFile(
      fp,
      "---\nrules:\n  requiredFiles:\n    - test.md\nunknownKey: value\n---\nBody\n",
      "utf-8",
    );

    const result = await diagnoseVerifyConfig(fp);
    expect(result.ok).toBe(false);
    const unknownKeyError = result.errors.find(e => e.code === "unknown_top_level_key");
    expect(unknownKeyError).toBeDefined();
    expect(unknownKeyError!.detail).toContain("unknownKey");
  });

  it("returns invalid_mode for mode: xor", async () => {
    const fp = path.join(TMP, "verify.md");
    await fs.writeFile(
      fp,
      '---\nrules:\n  keywords:\n    - "test"\n  mode: xor\n---\nBody\n',
      "utf-8",
    );

    const result = await diagnoseVerifyConfig(fp);
    expect(result.ok).toBe(false);
    const modeError = result.errors.find(e => e.code === "invalid_mode");
    expect(modeError).toBeDefined();
    expect(modeError!.detail).toContain("xor");
  });

  it("returns empty_rule_item for empty pattern", async () => {
    const fp = path.join(TMP, "verify.md");
    await fs.writeFile(
      fp,
      '---\nrules:\n  fileContentPattern:\n    - path: "test.md"\n      pattern: ""\n---\nBody\n',
      "utf-8",
    );

    const result = await diagnoseVerifyConfig(fp);
    expect(result.ok).toBe(false);
    const emptyError = result.errors.find(e => e.code === "empty_rule_item");
    expect(emptyError).toBeDefined();
    expect(emptyError!.detail).toContain("pattern");
  });

  it("returns ok:true for valid template verify.md (develop)", async () => {
    const templatePath = path.resolve(
      __dirname,
      "..",
      "..",
      "template",
      "references",
      "develop_spec",
      "verify.md",
    );
    const result = await diagnoseVerifyConfig(templatePath);
    expect(result.ok).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("returns ok:true for valid template verify.md (clarify)", async () => {
    const templatePath = path.resolve(
      __dirname,
      "..",
      "..",
      "template",
      "references",
      "clarify_spec",
      "verify.md",
    );
    const result = await diagnoseVerifyConfig(templatePath);
    expect(result.ok).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("returns ok:true for valid template verify.md (plan)", async () => {
    const templatePath = path.resolve(
      __dirname,
      "..",
      "..",
      "template",
      "references",
      "plan_spec",
      "verify.md",
    );
    const result = await diagnoseVerifyConfig(templatePath);
    expect(result.ok).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("returns ok:true for valid template verify.md (review)", async () => {
    const templatePath = path.resolve(
      __dirname,
      "..",
      "..",
      "template",
      "references",
      "review_spec",
      "verify.md",
    );
    const result = await diagnoseVerifyConfig(templatePath);
    expect(result.ok).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("returns ok:true for valid template verify.md (fix)", async () => {
    const templatePath = path.resolve(
      __dirname,
      "..",
      "..",
      "template",
      "references",
      "fix_spec",
      "verify.md",
    );
    const result = await diagnoseVerifyConfig(templatePath);
    expect(result.ok).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("returns ok:true for valid custom verify.md", async () => {
    const fp = path.join(TMP, "verify.md");
    await fs.writeFile(
      fp,
      '---\nrules:\n  requiredFiles:\n    - "test.md"\n  keywords:\n    - "done"\n  mode: and\n---\nBody\n',
      "utf-8",
    );

    const result = await diagnoseVerifyConfig(fp);
    expect(result.ok).toBe(true);
    expect(result.errors).toHaveLength(0);
  });
});
