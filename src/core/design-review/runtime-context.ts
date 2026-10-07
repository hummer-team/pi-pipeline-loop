/**
 * @module design-review/runtime-context
 * 193 Phase 3 (task 1): THE single safe builder for the coordinator context at
 * every plugin entry (hook, tools, commands, startup).
 *
 * Why this module exists: each entry used to hand-assemble the
 * CoordinatorContext object literal. The assemblies drifted — tools omitted
 * the `actor` evidence (so decisions could not even be presented), the
 * startup/resume entries passed `ui.transition` as an UNBOUND function
 * reference (losing the original receiver), and the interaction provenance
 * (auto/tool/resume/startup) was nowhere recorded. Centralizing construction
 * keeps exactly ONE binding point for:
 *
 * - receiver-preserving (`this` intact) binding of the ORIGINAL UI controls:
 *   notify/select/transition are always invoked through the object that owns
 *   them — never a bare method reference;
 * - role evidence (`actor`) for menu eligibility, resolved from the raw
 *   runtime ctx (`_ctx.sessionManager`); detection absence degrades to NO
 *   actor — the coordinator then fails closed (a pending decision stays
 *   unpresented, children can never record a choice or advance);
 * - the `interactionSource` tag assigned HERE by plugin entries only — it is
 *   never exposed as a model tool argument, and only "resume" may
 *   re-present a pending decision menu.
 *
 * Children wait for the owner BEFORE consuming: the builder never strips
 * capabilities silently — it records honest evidence and lets the
 * coordinator/entry-result fail-closed logic defer child sessions (zero
 * budget, no menu, no choice persistence, no advance).
 */

import type { PipelineConfig } from "../../types";
import type { CoordinatorContext } from "./coordinator";
import { detectSessionRole } from "../session-role";
import type { DesignReviewInteractionSource } from "./decision-types";
import type { HumanDecisionSelectFn } from "./human-decision";

/**
 * Raw SDK UI surface as handed by the pi runtime. Every member is optional
 * because test mocks and degraded entries provide only parts of it; the
 * builder binds ONLY what is a real function, preserving the receiver.
 */
interface RawUiLike {
  notify?: (msg: string) => void;
  select?: (title: string, options: string[]) => Promise<string | undefined>;
  transition?: (ctxArg: unknown, from: string, to: string) => void;
  [key: string]: unknown;
}

/**
 * The gated PipelineUI (created by createPipelineUI/config) used by command
 * and startup entries: notify(ctx, msg) / transition(ctx, from, to). Both
 * take the ENTRY ctx as first argument — the builder closes over it.
 */
interface PipelineUiLike {
  notify?: (ctx: unknown, msg: string) => void;
  transition?: (ctx: unknown, from: string, to: string) => void;
}

export interface DesignReviewRuntimeInput {
  config: PipelineConfig;
  /** The session state adapter (strict-commit capable in production). */
  session: CoordinatorContext["session"];
  /**
   * The interaction provenance — assigned by the plugin entry, NEVER by a
   * model tool argument (task 1: not exposed on any tool schema).
   */
  interactionSource: DesignReviewInteractionSource;
  /** Raw entry ctx (RuntimeCtx or ExtensionContext-like) for role detection. */
  roleCtx?: unknown;
  /** Raw SDK UI object — select/notify/transition bound receiver-preserving. */
  rawUi?: unknown;
  /** Gated PipelineUI for command/startup entries (preferred notify channel). */
  pipelineUi?: PipelineUiLike | undefined;
  /** The ctx argument the PipelineUI methods expect. */
  pipelineUiCtx?: unknown;
  /** pi bridge (sendUserMessage) forwarded unchanged. */
  pi?: CoordinatorContext["pi"];
  /** Test/entry spawn override forwarded unchanged. */
  spawnOverride?: CoordinatorContext["spawnOverride"];
  /** Precomputed verification run (hook/tool entries) forwarded unchanged. */
  verificationResult?: CoordinatorContext["verificationResult"];
  /** Passthrough verification options forwarded unchanged. */
  verificationOptions?: CoordinatorContext["verificationOptions"];
}

/** True when the value is a callable function. */
function isFn(value: unknown): value is (...args: unknown[]) => unknown {
  return typeof value === "function";
}

/**
 * Build one CoordinatorContext from entry materials. Pure construction: no
 * I/O, no state mutation — every entry calls this instead of hand-assembling
 * object literals, so UI binding and role evidence stay uniform everywhere.
 */
export function createDesignReviewRuntimeContext(
  input: DesignReviewRuntimeInput,
): CoordinatorContext {
  const rawUi = input.rawUi as RawUiLike | undefined;

  // ── notify: prefer the GATED PipelineUI (commands/startup), else the raw
  //    SDK notify bound to its receiver. ──────────────────────────────────
  let notify: ((msg: string) => void) | undefined;
  if (input.pipelineUi && typeof input.pipelineUi.notify === "function") {
    const uiRef = input.pipelineUi;
    const uiCtx = input.pipelineUiCtx;
    notify = (msg: string) => {
      uiRef.notify?.(uiCtx, msg);
    };
  } else if (rawUi && isFn(rawUi.notify)) {
    const recv = rawUi;
    notify = (msg: string) => {
      recv.notify?.(msg);
    };
  }

  // ── select: ALWAYS the raw SDK select (PipelineUI never renders menus),
  //    invoked through the receiver so the original `this` survives. ──────
  let select: HumanDecisionSelectFn | undefined;
  if (rawUi && typeof rawUi.select === "function") {
    const recv = rawUi;
    const original = rawUi.select;
    const call: HumanDecisionSelectFn = (title, options) => original.call(recv, title, [...options]);
    select = call;
  }

  // ── transition: prefer the gated PipelineUI.transition closed over the
  //    entry ctx; else the raw transition bound to its receiver. (The old
  //    per-site assemblies leaked an unbound reference here — fixed.) ────
  let transition: ((ctxArg: unknown, from: string, to: string) => void) | undefined;
  if (input.pipelineUi && typeof input.pipelineUi.transition === "function") {
    const uiRef = input.pipelineUi;
    const uiCtx = input.pipelineUiCtx;
    transition = (_ctxArg: unknown, from: string, to: string) => {
      uiRef.transition?.(uiCtx ?? _ctxArg, from, to);
    };
  } else if (rawUi && isFn(rawUi.transition)) {
    const recv = rawUi;
    const original = rawUi.transition;
    transition = (ctxArg, from, to) => {
      original.call(recv, ctxArg, from, to);
    };
  }

  const hasUi = notify !== undefined || select !== undefined || transition !== undefined;

  // ── actor evidence: resolved from the raw entry ctx. Absent/unreadable
  //    role data is recorded as NO evidence — the coordinator resolves that
  //    to "unknown" and fails closed (pending stays pending; a child NEVER
  //    gets menu/choice/advance privileges either way). ───────────────────
  let actor: CoordinatorContext["actor"];
  if (input.roleCtx !== undefined && input.roleCtx !== null) {
    try {
      const role = detectSessionRole(input.roleCtx as Parameters<typeof detectSessionRole>[0]);
      actor = { isChild: role.isChild, sessionFile: role.sessionFile || undefined };
    } catch {
      // Detection failure: leave evidence ABSENT (fail closed).
      actor = undefined;
    }
  }

  const ctx: CoordinatorContext = {
    config: input.config,
    session: input.session,
    ...(hasUi ? { ui: { notify: notify ?? (() => {}), ...(select !== undefined ? { select } : {}), ...(transition !== undefined ? { transition } : {}) } } : {}),
    ...(actor !== undefined ? { actor } : {}),
    ...(input.pi !== undefined ? { pi: input.pi } : {}),
    ...(input.spawnOverride !== undefined ? { spawnOverride: input.spawnOverride } : {}),
    ...(input.verificationResult !== undefined ? { verificationResult: input.verificationResult } : {}),
    ...(input.verificationOptions !== undefined ? { verificationOptions: input.verificationOptions } : {}),
    interactionSource: input.interactionSource,
  };
  return ctx;
}
