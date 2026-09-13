/**
 * Phase 5 / 175: Tests for skill-managed-block utility.
 *
 * Validates:
 * - renderContractBlock: generates correct block with markers
 * - mergeManagedBlock: idempotent in-place replacement and append
 * - CRLF and trailing newline handling
 */
import { describe, it, expect } from "bun:test";
import { renderContractBlock, mergeManagedBlock, MANAGED_BLOCK_BEGIN, MANAGED_BLOCK_END } from "../../utils/skill-managed-block";

describe("renderContractBlock", () => {
  it("generates block with correct markers and content", () => {
    const block = renderContractBlock("develop", "- **MUST** run build\n- **MUST** run tests");
    expect(block).toContain(MANAGED_BLOCK_BEGIN);
    expect(block).toContain(MANAGED_BLOCK_END);
    expect(block).toContain("**MUST** run build");
    expect(block).toContain("Plugin-Managed Contract (develop)");
  });
});

describe("mergeManagedBlock", () => {
  it("appends block when no existing block", () => {
    const content = "# My Skill\n\nSome content.\n";
    const block = renderContractBlock("develop", "- **MUST** run build");
    const result = mergeManagedBlock(content, block);
    expect(result).toContain("Some content.");
    expect(result).toContain(MANAGED_BLOCK_BEGIN);
    expect(result).toContain("**MUST** run build");
    expect(result).toContain(MANAGED_BLOCK_END);
  });

  it("replaces existing block in-place (idempotent update)", () => {
    const oldBlock = renderContractBlock("develop", "- **MUST** old content");
    const content = `# My Skill\n\nSome content.\n\n${oldBlock}\n\nMore content.\n`;
    const newBlock = renderContractBlock("develop", "- **MUST** new content");
    const result = mergeManagedBlock(content, newBlock);

    // User content preserved
    expect(result).toContain("Some content.");
    expect(result).toContain("More content.");
    // Old content replaced
    expect(result).not.toContain("old content");
    // New content present
    expect(result).toContain("new content");
    // Only one block (idempotent)
    const beginCount = result.split(MANAGED_BLOCK_BEGIN).length - 1;
    expect(beginCount).toBe(1);
  });

  it("handles missing trailing newline", () => {
    const content = "# My Skill\n\nSome content.";
    const block = renderContractBlock("plan", "- **MUST** plan stuff");
    const result = mergeManagedBlock(content, block);
    expect(result).toContain("Some content.");
    expect(result).toContain(MANAGED_BLOCK_BEGIN);
  });

  it("handles CRLF line endings", () => {
    const content = "# My Skill\r\n\r\nSome content.\r\n";
    const block = renderContractBlock("review", "- **MUST** review");
    const result = mergeManagedBlock(content, block);
    expect(result).toContain("Some content.");
    expect(result).toContain(MANAGED_BLOCK_BEGIN);
    // CRLF should be normalized to LF
    expect(result).not.toContain("\r\n");
  });

  it("second merge still produces single block (idempotent)", () => {
    const content = "# My Skill\n\nContent.\n";
    const block1 = renderContractBlock("develop", "- **MUST** first");
    const merged1 = mergeManagedBlock(content, block1);
    const block2 = renderContractBlock("develop", "- **MUST** second");
    const merged2 = mergeManagedBlock(merged1, block2);

    expect(merged2).not.toContain("first");
    expect(merged2).toContain("second");
    const beginCount = merged2.split(MANAGED_BLOCK_BEGIN).length - 1;
    expect(beginCount).toBe(1);
  });
});
