/**
 * @module auto-pipeline/start-stage-dispatch
 * 224 Phase 1: dispatch the executor of a spec-jump auto-start stage.
 *
 * Facts:
 * - INV-2: this module never starts or advances a pipeline itself — it only
 *   decides/maps/describes an EXISTING dispatch.
 * - The decision/mapping/copy here are PURE: `pipeline-start.ts` keeps its
 *   existing spawn semantics (F1) and only reports the outcome.
 * - Every outcome maps on to the EXISTING `spawnStageSubagent` result shape;
 *   no new spawn semantics are invented.
 */

import type { PipelineConfig, PipelineStage } from "../../types";
import { resolveAgentMention, type StageDispatchOutcome } from "../../utils/subagent-rpc";

/** Input for the pure "should the auto runner dispatch the start stage?" decision. */
export interface StartStageDispatchInput {
  stage: PipelineStage;
  /** 223: the startup advance already dispatched the next stage's executor. */
  clarifyAdvanceHandled: boolean;
}

/** Pure decision: only a spec-jump start of a real stage is dispatched here. */
export function shouldDispatchStartStage(input: StartStageDispatchInput): boolean {
  if (input.clarifyAdvanceHandled) return false;
  return input.stage !== "clarify" && input.stage !== "completed" && input.stage !== "awaiting_human";
}

/**
 * F1, evidence-driven: only a PROVEN "nobody will execute" is fatal.
 * `fallback`/`deferred`/`unknown` are legal (the executor may still act);
 * `conflict_blocked`/`not_sent` prove the executor will NOT act.
 */
export type StartDispatchOutcome =
  | "spawned"        // RPC id returned
  | "fallback"       // followUp hand-off delivered (unknown outcome, non-fatal)
  | "deferred"       // live same-agent twin: queued, watcher armed
  | "queued"         // routed to the owner pending queue
  | "already_running"// ledger-live / duplicate guard: the executor already exists
  | "unknown"        // RPC timeout / ambiguous envelope: must NOT auto re-dispatch
  | "handled_elsewhere" // freeze / design-review chain already owns it
  | "not_applicable" // stage without a plugin dispatcher (clarify belongs to 223)
  | "conflict_blocked"
  | "not_sent";      // provably NOT dispatched (retryable)

/** TRUE only for outcomes that PROVE no executor will run the stage. */
export function isFatalStartDispatchOutcome(outcome: StartDispatchOutcome): boolean {
  return outcome === "conflict_blocked" || outcome === "not_sent";
}

/** Result of the pre-start dispatchability check (P-A). */
export type StartDispatchPrecheck =
  | { ok: true }
  | { ok: false; reason: "no_agent" | "no_channel" };

/** TRUE when the host exposes ANY usable dispatch channel (RPC or message). */
export function hasStartDispatchChannel(pi: unknown): boolean {
  if (!pi) return false;
  const p = pi as { sendUserMessage?: unknown; events?: { emit?: unknown } };
  return typeof p.sendUserMessage === "function" || typeof p.events?.emit === "function";
}

/**
 * P-A pre-check: agent mapping + a usable dispatch channel, evaluated BEFORE
 * the pipeline is created (a failure must never leave a half-started job).
 */
export function checkStartDispatchable(input: {
  config: PipelineConfig;
  stage: PipelineStage;
  pi: unknown;
}): StartDispatchPrecheck {
  if (!resolveAgentMention(input.config, input.stage)) return { ok: false, reason: "no_agent" };
  if (!hasStartDispatchChannel(input.pi)) return { ok: false, reason: "no_channel" };
  return { ok: true };
}

/** Minimal structural view of the visit-stamp facts the wiring defends with. */
export interface StartMetaStampView {
  spawnedStages?: Partial<Record<PipelineStage, number>>;
  stageStartTime?: number;
}

/**
 * Pure defensive re-check (review fix #2): a visit stamp for THIS stage/visit
 * time means the executor was already dispatched in this visit — count the
 * stage as already running instead of risking a twin. Unreachable right after
 * `buildStartMeta` resets the stamp; it only becomes true when THIS stage
 * genuinely spawned (or was stamped) during the CURRENT visit.
 */
export function isStartStageAlreadyDispatched(
  freshMeta: StartMetaStampView | undefined,
  stage: PipelineStage,
): boolean {
  if (!freshMeta?.stageStartTime) return false;
  return freshMeta.spawnedStages?.[stage] === freshMeta.stageStartTime;
}

/** Minimal structural view of the EXISTING `spawnStageSubagent` result. */
export interface SpawnResultLike {
  spawned: boolean;
  fallback: boolean;
  deferred?: boolean;
  queuedForOwner?: boolean;
  dispatchOutcome?: StageDispatchOutcome;
}

/**
 * Exhaustive mapping of the EXISTING spawn result — no new spawn semantics.
 * Order matters: the explicit `dispatchOutcome` wins over the boolean flags.
 */
export function mapSpawnResultToOutcome(result: SpawnResultLike): StartDispatchOutcome {
  const outcome = result.dispatchOutcome;
  if (outcome === "conflict_blocked") return "conflict_blocked";
  if (result.queuedForOwner || outcome === "queued_owner") return "queued";
  if (result.deferred || outcome === "deferred") return "deferred";
  if (outcome === "skipped_duplicate") return "already_running";
  if ((result.spawned && result.fallback) || outcome === "fallback_no_id") return "fallback";
  if (result.spawned) return "spawned";
  if (outcome === "unknown") return "unknown";
  if (outcome === "strict_blocked") return "handled_elsewhere";
  return "not_sent";
}

/**
 * Minimal structural view of the design-review coordinator result — the four
 * actions `dispatchAfterResume` must distinguish (`routed` / `pending` /
 * `frozen` / `verify_failed`), the generic "handled" case and the
 * "not-applicable" fallback.
 */
export type DesignReviewCoordinatorLike =
  | { status: "handled"; action: "routed" }
  | { status: "handled"; action: "pending" }
  | { status: "handled"; action: "frozen" }
  | { status: "handled"; action: "verify_failed" }
  | { status: "handled"; action: "advanced" }
  | { status: "handled"; action: string }
  | { status: "not-applicable" };

/**
 * Exhaustive mapping of the design-review coordinator result onto the SAME
 * dispatch-outcome vocabulary (224 Phase 1, review fix #2):
 * - `routed` → the review executor was dispatched;
 * - `pending` → a legal compensation state (queued work exists), NOT fatal;
 * - `frozen` / `verify_failed` / any other handled action → the existing
 *   decision chain owns the visit, so the auto runner must never fail the doc;
 * - `not-applicable` → the coordinator proved nothing about a dispatch, so the
 *   outcome is deliberately ambiguous ("verify before re-running").
 */
export function mapDesignReviewCoordinatorOutcome(
  result: DesignReviewCoordinatorLike,
): StartDispatchOutcome {
  if (result.status === "not-applicable") return "unknown";
  switch (result.action) {
    case "routed":
      return "spawned";
    case "pending":
      return "queued";
    default:
      return "handled_elsewhere";
  }
}

/** Outcome → ONE user-visible sentence (no internal enum leaks). */
export function describeStartDispatch(
  outcome: StartDispatchOutcome,
  ctx: { stage: PipelineStage; agentName: string },
): string {
  switch (outcome) {
    case "spawned":
    case "fallback":
      return `dispatched ${ctx.agentName} for stage ${ctx.stage}`;
    case "queued":
    case "deferred":
      return `queued behind a live ${ctx.agentName}; it starts automatically when the current run settles`;
    case "already_running":
      return `${ctx.agentName} is already running for stage ${ctx.stage}`;
    case "unknown":
      return `dispatch outcome unknown for stage ${ctx.stage}; verify before re-running`;
    case "handled_elsewhere":
      return `handed to the existing decision chain (no new dispatch)`;
    case "not_applicable":
      return `no plugin dispatch needed for stage ${ctx.stage}`;
    case "conflict_blocked":
      return `a configuration conflict blocks ${ctx.agentName} for stage ${ctx.stage}`;
    case "not_sent":
      return `${ctx.agentName} was NOT dispatched for stage ${ctx.stage}`;
  }
}
