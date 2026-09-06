import { describe, it, expect, afterEach } from "bun:test";
import {
  formatDecisionMenuHint,
  clearAllDecisionTimers,
} from "../../core/flow-state";
import { makeTestConfig } from "../helpers";
import { DEFAULT_DECISION_SHORTCUT } from "../../constants";

describe("Phase 6 (172): formatDecisionMenuHint", () => {
  afterEach(() => {
    clearAllDecisionTimers();
  });

  it("uses default shortcut when config has no decisionShortcutKey", () => {
    const config = makeTestConfig();
    const hint = formatDecisionMenuHint(config);
    expect(hint).toContain(DEFAULT_DECISION_SHORTCUT);
    expect(hint).toContain("Open the decision menu");
  });

  it("uses configured shortcut key", () => {
    const config = makeTestConfig({ decisionShortcutKey: "ctrl+g" });
    const hint = formatDecisionMenuHint(config);
    expect(hint).toContain("ctrl+g");
    expect(hint).not.toContain(DEFAULT_DECISION_SHORTCUT);
  });

  it("hint format is consistent", () => {
    const config = makeTestConfig({ decisionShortcutKey: "alt+f1" });
    const hint = formatDecisionMenuHint(config);
    expect(hint).toBe("Open the decision menu (press alt+f1) to proceed.");
  });
});

describe("Phase 6 (172): clearAllDecisionTimers", () => {
  it("does not throw when no timers exist", () => {
    expect(() => clearAllDecisionTimers()).not.toThrow();
  });
});
