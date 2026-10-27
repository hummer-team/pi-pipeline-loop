/**
 * 213_Bug Phase 0 (D18): `hasInteractiveUI` — the ONE shared interactive-UI
 * predicate. Locks the truth table (declared true/false win, undeclared falls
 * back to the legacy `typeof ui.select` reverse-inference), the function-form
 * normalization (repo history disagrees on attribute vs method), and the
 * honest "malformed declaration = undeclared" boundaries.
 */

import { describe, expect, it } from "bun:test";
import { hasInteractiveUI, resolveDeclaredHasUI } from "../../core/ui-capability";

const selectFn = () => Promise.resolve("x");

describe("213 P0 D18: resolveDeclaredHasUI reads ONLY the host declaration", () => {
  it("boolean declarations pass through untouched", () => {
    expect(resolveDeclaredHasUI({ hasUI: true })).toBe(true);
    expect(resolveDeclaredHasUI({ hasUI: false })).toBe(false);
  });

  it("function declarations are normalized through .call(ctx)", () => {
    expect(resolveDeclaredHasUI({ hasUI: () => true })).toBe(true);
    expect(resolveDeclaredHasUI({ hasUI: () => false })).toBe(false);
    // A method reading its own host must see the source object as `this`.
    const runner = { flag: true, hasUI(this: { flag: boolean }) { return this.flag; } };
    expect(resolveDeclaredHasUI(runner)).toBe(true);
  });

  it("malformed declarations are HONESTLY treated as undeclared", () => {
    // Non-boolean return → not a declaration.
    expect(resolveDeclaredHasUI({ hasUI: () => "true" })).toBeUndefined();
    expect(resolveDeclaredHasUI({ hasUI: () => undefined })).toBeUndefined();
    // Throwing function → not a declaration.
    expect(resolveDeclaredHasUI({
      hasUI: () => {
        throw new Error("host capability probe failed");
      },
    })).toBeUndefined();
    // Non-boolean, non-function values are NOT declarations either.
    expect(resolveDeclaredHasUI({ hasUI: "true" as unknown as boolean })).toBeUndefined();
    expect(resolveDeclaredHasUI({ hasUI: null })).toBeUndefined();
    expect(resolveDeclaredHasUI({ hasUI: {} })).toBeUndefined();
  });

  it("absent sources answer undefined (nothing is declared)", () => {
    expect(resolveDeclaredHasUI(undefined)).toBeUndefined();
    expect(resolveDeclaredHasUI(null)).toBeUndefined();
    expect(resolveDeclaredHasUI({})).toBeUndefined();
    expect(resolveDeclaredHasUI("not-an-object")).toBeUndefined();
  });
});

describe("213 P0 D18: hasInteractiveUI truth table (declared wins, legacy fallback)", () => {
  it("declared true WINS even without any select control", () => {
    expect(hasInteractiveUI({ hasUI: true })).toBe(true);
    expect(hasInteractiveUI({ hasUI: true, ui: {} })).toBe(true);
    expect(hasInteractiveUI({ hasUI: () => true, ui: {} })).toBe(true);
  });

  it("declared false WINS even when a select control exists", () => {
    expect(hasInteractiveUI({ hasUI: false, ui: { select: selectFn } })).toBe(false);
    expect(hasInteractiveUI({ hasUI: () => false, ui: { select: selectFn } })).toBe(false);
  });

  it("undeclared falls back to the legacy `typeof ui.select` predicate (212 behaviour preserved)", () => {
    expect(hasInteractiveUI({ ui: { select: selectFn } })).toBe(true);
    expect(hasInteractiveUI({ ui: {} })).toBe(false);
    expect(hasInteractiveUI({})).toBe(false);
    expect(hasInteractiveUI(undefined)).toBe(false);
    // A non-function select control is NOT an interactive menu (legacy predicate).
    expect(hasInteractiveUI({ ui: { select: "not-a-function" } })).toBe(false);
    expect(hasInteractiveUI({ ui: { select: {} } })).toBe(false);
  });

  it("boundary: hasUI `\"true\"` / null / object are UNDECLARED ⇒ fallback applies", () => {
    // The plan locks this edge: a malformed declaration must never override
    // the legacy predicate in EITHER direction.
    const withSelect = { ui: { select: selectFn } };
    expect(hasInteractiveUI({ ...withSelect, hasUI: "true" as unknown as boolean })).toBe(true);
    expect(hasInteractiveUI({ ...withSelect, hasUI: null as unknown as boolean })).toBe(true);
    expect(hasInteractiveUI({ ...withSelect, hasUI: { enabled: true } as unknown as boolean })).toBe(true);
    const withoutSelect = { ui: {} };
    expect(hasInteractiveUI({ ...withoutSelect, hasUI: "false" as unknown as boolean })).toBe(false);
    // A function returning non-boolean is equally undeclared.
    expect(hasInteractiveUI({ ...withoutSelect, hasUI: () => 1 as unknown as boolean })).toBe(false);
  });
});
