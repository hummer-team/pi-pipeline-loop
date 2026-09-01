import { describe, it, expect, beforeEach } from "bun:test";
import { shouldNotifyAndStamp, shouldEmitWithinWindow, __resetMemoryThrottle } from "../../utils/audit-throttle";
import { makeTestMeta } from "../helpers";

describe("shouldNotifyAndStamp (meta-based throttle)", () => {
  it("returns true when field is undefined (first invocation)", () => {
    const meta = makeTestMeta({});
    expect(shouldNotifyAndStamp(meta, "lastUnboundNotifiedAt", 60_000)).toBe(true);
  });

  it("returns false when called again within the window", () => {
    const meta = makeTestMeta({ lastUnboundNotifiedAt: Date.now() });
    // Within 60s window — should be suppressed
    expect(shouldNotifyAndStamp(meta, "lastUnboundNotifiedAt", 60_000)).toBe(false);
  });

  it("returns true when window has elapsed", () => {
    const meta = makeTestMeta({ lastUnboundNotifiedAt: Date.now() - 120_000 });
    // 120s ago — window of 60s has elapsed
    expect(shouldNotifyAndStamp(meta, "lastUnboundNotifiedAt", 60_000)).toBe(true);
  });

  it("returns true when stored value is not a number (fail-open)", () => {
    const meta = makeTestMeta({ lastUnboundNotifiedAt: "invalid" as unknown as number });
    expect(shouldNotifyAndStamp(meta, "lastUnboundNotifiedAt", 60_000)).toBe(true);
  });
});

describe("shouldEmitWithinWindow (in-memory throttle)", () => {
  beforeEach(() => {
    __resetMemoryThrottle();
  });

  it("returns true on first invocation for a given key", () => {
    expect(shouldEmitWithinWindow("test-key-1", 60_000)).toBe(true);
  });

  it("returns false on second invocation within the window", () => {
    expect(shouldEmitWithinWindow("test-key-2", 60_000)).toBe(true);
    expect(shouldEmitWithinWindow("test-key-2", 60_000)).toBe(false);
  });

  it("returns true again after window has elapsed", () => {
    // Use a very small window to simulate elapsed time
    // First call records Date.now()
    expect(shouldEmitWithinWindow("test-key-3", 0)).toBe(true);
    // With windowMs=0, any subsequent call should also return true
    // (Date.now() - lastFired >= 0 is always true for same-millisecond calls)
    expect(shouldEmitWithinWindow("test-key-3", 0)).toBe(true);
  });

  it("isolates different keys independently", () => {
    expect(shouldEmitWithinWindow("key-a", 60_000)).toBe(true);
    expect(shouldEmitWithinWindow("key-b", 60_000)).toBe(true);
    // Both keys consumed — second calls should be suppressed
    expect(shouldEmitWithinWindow("key-a", 60_000)).toBe(false);
    expect(shouldEmitWithinWindow("key-b", 60_000)).toBe(false);
  });

  it("__resetMemoryThrottle clears all entries", () => {
    expect(shouldEmitWithinWindow("key-reset", 60_000)).toBe(true);
    expect(shouldEmitWithinWindow("key-reset", 60_000)).toBe(false);
    __resetMemoryThrottle();
    expect(shouldEmitWithinWindow("key-reset", 60_000)).toBe(true);
  });
});
