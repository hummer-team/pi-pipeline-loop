/**
 * @module core/ui-capability
 * 213_Bug Phase 0 (D18): ONE predicate for "may this session open an
 * interactive menu", judged from the HOST-DECLARED capability first and only
 * then from the legacy `typeof ui.select` reverse-inference.
 *
 * Why: every menu entry used to guess interactivity from the presence of a
 * `select` control. Hosts that legitimately declare "no interactive UI"
 * (or declare one WITHOUT a select control) were misjudged, and copy written
 * under the wrong verdict promised paths that cannot work. The declared value
 * wins whenever it exists; the legacy predicate remains ONLY as the
 * undeclared fallback, so every existing host keeps its exact behaviour.
 *
 * History note (213 round-7): repo records disagree on the declared shape —
 * 212_Bug.md:154 documents a METHOD, history/111_Init.md:98 an ATTRIBUTE.
 * Both forms are normalized here; failing to normalize the function form
 * would silently route it into the fail-open fallback branch.
 *
 * Boundaries (D18, locked):
 * - This is a DISPLAY-capability judgment only — never an authority. Owner
 *   eligibility stays in `resolveDesignReviewActorEvidence` (193 single
 *   authority).
 * - Exactly TWO call sites migrate in 213 (the presenter capability gate and
 *   the /pipeline-resume menu gate). The remaining 14 predicates across the
 *   repo are untouched by design (213 plan "not-doing" list includes
 *   flow-state.ts:2270 and the settle-side `hasSelect` fact).
 */

/** Source whose UI capability is being judged (raw ctx or CoordinatorContext). */
export interface UiCapabilitySource {
  /** Host-declared capability: boolean on most hosts, method on runner-style hosts. */
  hasUI?: boolean | (() => boolean);
  ui?: { select?: unknown };
}

/**
 * Read ONLY the host-declared value from an arbitrary context object.
 * `undefined` means "this host does not declare it" — a malformed declaration
 * (non-boolean return, throwing getter) is honestly treated as undeclared so
 * the caller falls back to the legacy predicate.
 */
export function resolveDeclaredHasUI(ctx: unknown): boolean | undefined {
  const declared = (ctx as UiCapabilitySource | undefined)?.hasUI;
  if (typeof declared === "boolean") return declared;
  if (typeof declared === "function") {
    try {
      const value = (declared as () => unknown).call(ctx);
      return typeof value === "boolean" ? value : undefined;
    } catch {
      // Malformed declaration: treated as "not declared" → legacy fallback.
      return undefined;
    }
  }
  return undefined;
}

/**
 * Truth table: a declared true/false WINS; only an absent (or malformed)
 * declaration falls back to the legacy `typeof ui.select` predicate.
 */
export function hasInteractiveUI(ctx: UiCapabilitySource | undefined): boolean {
  const declared = resolveDeclaredHasUI(ctx);
  if (declared !== undefined) return declared;
  return typeof ctx?.ui?.select === "function";
}

/**
 * 218 review #5: "can a menu ACTUALLY be operated right now". Unlike
 * `hasInteractiveUI`, a declared `true` is NOT trusted on its own — it still
 * needs a real `select` control. Hosts that declare hasUI=true but hand over
 * no select would otherwise pass an interactive gate and then silently
 * degrade inside the ask (no menu, no notify, no breaker count). Declared
 * `false` still wins over a present control (217 review issue 2 boundary).
 *
 * Use this to gate CODE PATHS that must show a menu or visibly degrade
 * (whitelist-miss owner ask, approval menus); keep `hasInteractiveUI` for
 * DISPLAY decisions (presenters, resume hints).
 */
export function isMenuCapable(ctx: UiCapabilitySource | undefined): boolean {
  return resolveDeclaredHasUI(ctx) !== false && typeof ctx?.ui?.select === "function";
}
