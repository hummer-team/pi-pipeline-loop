/**
 * 217 Phase 0 (T0.1): owner-delivery-registry unit tests.
 * Covers the plan's boundary matrix:
 * - resolution priority: `run_binding` hit > `non_child_fallback` > `none`;
 * - a bound target that is NOT registered → falls back to the most recent
 *   non-child registration;
 * - no non-child registration at all → `reason=no_owner_target`
 *   (or `owner_target_not_registered` when a binding target exists);
 * - re-registration refreshes recency (delete-then-set);
 * - child registrations never win the fallback.
 *
 * The registry is module-level shared state: `__resetOwnerDeliveryRegistry()`
 * isolates every test.
 */
import { describe, it, expect, beforeEach } from "bun:test";
import {
  registerOwnerDelivery,
  unregisterOwnerDelivery,
  resolveOwnerDelivery,
  __resetOwnerDeliveryRegistry,
  type OwnerDeliveryHandle,
} from "../../core/owner-delivery-registry";
import { makeTestMeta } from "../helpers";
import type { SessionMeta } from "../../types";

/** Minimal handle factory: only sessionFile/isChild shape matters here. */
function makeHandle(sessionFile: string, isChild: boolean): OwnerDeliveryHandle {
  return {
    sessionFile,
    isChild,
    getMeta: () => undefined,
    sendFollowUp: () => true,
    notify: () => {},
    audit: () => {},
  };
}

/** Shared meta with an owner run binding (194 C3). */
function boundMeta(ownerSessionFile: string, overrides?: Partial<SessionMeta>): SessionMeta {
  return makeTestMeta({
    ...overrides,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    stageExecutorRun: { binding: { ownerSessionFile } } as any,
  });
}

describe("owner-delivery-registry (217 Phase 0 / T0.1)", () => {
  beforeEach(() => {
    __resetOwnerDeliveryRegistry();
  });

  it("resolves the run-bound owner first (via=run_binding)", () => {
    const owner = makeHandle("/sessions/owner.jsonl", false);
    registerOwnerDelivery(owner);

    const resolution = resolveOwnerDelivery(boundMeta("/sessions/owner.jsonl"));
    expect(resolution.via).toBe("run_binding");
    expect(resolution.handle).toBe(owner);
    expect(resolution.targetSessionFile).toBe("/sessions/owner.jsonl");
  });

  it("falls back to the last non-child registration when the bound target is unregistered", () => {
    const child = makeHandle("/sessions/child.jsonl", true);
    const owner = makeHandle("/sessions/owner.jsonl", false);
    // Registration ORDER matters: child last → child is most recent.
    registerOwnerDelivery(owner);
    registerOwnerDelivery(child);

    const resolution = resolveOwnerDelivery(boundMeta("/sessions/gone.jsonl"));
    expect(resolution.via).toBe("non_child_fallback");
    expect(resolution.handle).toBe(owner); // child NEVER wins the fallback
    expect(resolution.targetSessionFile).toBe("/sessions/owner.jsonl");
  });

  it("falls back to a non-child when NO binding exists", () => {
    const owner = makeHandle("/sessions/owner.jsonl", false);
    registerOwnerDelivery(owner);

    const resolution = resolveOwnerDelivery(makeTestMeta());
    expect(resolution.via).toBe("non_child_fallback");
    expect(resolution.handle).toBe(owner);
  });

  it("reports no_owner_target when nothing is registered", () => {
    const resolution = resolveOwnerDelivery(makeTestMeta());
    expect(resolution.via).toBe("none");
    expect(resolution.handle).toBeUndefined();
    expect(resolution.reason).toBe("no_owner_target");
  });

  it("reports owner_target_not_registered when a unresolvable binding target exists", () => {
    const resolution = resolveOwnerDelivery(boundMeta("/sessions/gone.jsonl"));
    expect(resolution.via).toBe("none");
    expect(resolution.reason).toBe("owner_target_not_registered");
    expect(resolution.targetSessionFile).toBe("/sessions/gone.jsonl");
  });

  it("re-registration refreshes recency (map order moves to the end)", () => {
    const first = makeHandle("/sessions/owner-A.jsonl", false);
    const second = makeHandle("/sessions/owner-B.jsonl", false);
    registerOwnerDelivery(first);
    registerOwnerDelivery(second);

    // Forward iteration prefers the FIRST non-child in map order → A.
    expect(resolveOwnerDelivery(makeTestMeta()).targetSessionFile).toBe("/sessions/owner-A.jsonl");

    // Re-register A → delete-then-set moves A to the END of the map, so B
    // (the refreshed recency survivor) becomes the first non-child again.
    registerOwnerDelivery(first);
    expect(resolveOwnerDelivery(makeTestMeta()).targetSessionFile).toBe("/sessions/owner-B.jsonl");
  });

  it("child registrations never become the fallback target", () => {
    const child = makeHandle("/sessions/child.jsonl", true);
    registerOwnerDelivery(child);

    const resolution = resolveOwnerDelivery(makeTestMeta());
    expect(resolution.via).toBe("none");
    expect(resolution.reason).toBe("no_owner_target");
  });

  it("a bound CHILD handle IS a valid run_binding target (own channel)", () => {
    const child = makeHandle("/sessions/child.jsonl", true);
    registerOwnerDelivery(child);

    const resolution = resolveOwnerDelivery(boundMeta("/sessions/child.jsonl"));
    expect(resolution.via).toBe("run_binding");
    expect(resolution.handle).toBe(child);
  });

  it("empty sessionFile registration is ignored; unregister removes the handle", () => {
    registerOwnerDelivery(makeHandle("", false));
    expect(resolveOwnerDelivery(makeTestMeta()).via).toBe("none");

    const owner = makeHandle("/sessions/owner.jsonl", false);
    registerOwnerDelivery(owner);
    expect(resolveOwnerDelivery(makeTestMeta()).via).toBe("non_child_fallback");

    unregisterOwnerDelivery("/sessions/owner.jsonl");
    expect(resolveOwnerDelivery(makeTestMeta()).via).toBe("none");

    // Empty strings are no-ops (never throw).
    expect(unregisterOwnerDelivery("")).toBeUndefined();
  });
});
