/**
 * @module stage-executor/runtime-binding
 * 194 Phase 0 (C3): validation and local recording of closed-loop executor
 * RUN bindings from trusted runtime evidence.
 *
 * Trust model (all three must hold before a run exists):
 * 1. The `agentId` is the FULL id returned by the trusted RPC reply.
 * 2. `ownerSessionFile` is real runtime evidence of the owner session.
 * 3. Liveness / session-file identity comes from the manager registry probe
 *    (`subagents-introspect.probeAgentSessionEvidence`), never from a short
 *    id, a time window, prompt text, or a parent JOIN snapshot.
 *
 * A child session records its OWN binding into its session entries once
 * (custom type `pi-pipeline:executor-binding`). Later tool/settle calls read
 * that local entry and compare it against the OWNER's current run: a stale or
 * unknown closed-loop child is refused mutation, and a JOIN never refreshes a
 * child's own identity (the entry lives in the child's own history).
 */

import type { StageExecutorBinding, StageExecutorRun, StageExecutorStage } from "./contracts";
import { isStageExecutorStage } from "./contracts";
import { probeAgentSessionEvidence } from "../../utils/subagents-introspect";

/** Custom-entry type of the plugin's own executor binding record. */
export const EXECUTOR_BINDING_ENTRY_TYPE = "pi-pipeline:executor-binding";

/** Minimal local-append surface needed to record a binding (test-friendly). */
export interface BindingEntryWriter {
  appendEntry(customType: string, data: unknown): void;
}

/** Minimal entry shape needed to read a binding back (structural). */
export interface BindingEntryLike {
  type?: string;
  customType?: string;
  data?: unknown;
}

/** Result of narrowing an unknown persisted/candidate binding payload. */
export type BindingNarrowResult =
  | { ok: true; binding: StageExecutorBinding }
  | { ok: false; reason: string };

/** Non-empty string extraction (unknown-safe). */
function nonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * 194 C3: narrow an unknown payload into a trusted binding shape.
 *
 * Every component is REQUIRED: an incomplete identity is never partially
 * trusted (`executorSessionFile` alone is optional — absence blocks authority
 * at the call sites, it does not invalidate the binding record itself).
 */
export function narrowStageExecutorBinding(input: unknown): BindingNarrowResult {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, reason: "binding_not_object" };
  }
  const obj = input as Record<string, unknown>;

  const runId = nonEmptyString(obj.runId);
  if (runId === null) return { ok: false, reason: "binding_missing_run_id" };
  const pipelineId = nonEmptyString(obj.pipelineId);
  if (pipelineId === null) return { ok: false, reason: "binding_missing_pipeline_id" };
  const ownerSessionFile = nonEmptyString(obj.ownerSessionFile);
  if (ownerSessionFile === null) return { ok: false, reason: "binding_missing_owner_session_file" };
  if (!isStageExecutorStage(obj.stage)) return { ok: false, reason: "binding_stage_out_of_scope" };
  const stageVisitId = obj.stageVisitId;
  if (typeof stageVisitId !== "number" || !Number.isFinite(stageVisitId) || stageVisitId <= 0) {
    return { ok: false, reason: "binding_visit_id_invalid" };
  }
  const operationId = nonEmptyString(obj.operationId);
  if (operationId === null) return { ok: false, reason: "binding_missing_operation_id" };
  const agentId = nonEmptyString(obj.agentId);
  if (agentId === null) return { ok: false, reason: "binding_missing_agent_id" };

  const executorSessionFile =
    obj.executorSessionFile === undefined ? null : nonEmptyString(obj.executorSessionFile);
  if (obj.executorSessionFile !== undefined && executorSessionFile === null) {
    return { ok: false, reason: "binding_executor_session_file_malformed" };
  }

  return {
    ok: true,
    binding: {
      runId,
      pipelineId,
      ownerSessionFile,
      stage: obj.stage as StageExecutorStage,
      stageVisitId,
      operationId,
      agentId,
      ...(executorSessionFile !== null ? { executorSessionFile } : {}),
    },
  };
}

/** Registry-proven session file for the binding's FULL agent id (or null). */
export function resolveExecutorSessionFileEvidence(binding: StageExecutorBinding): string | null {
  const evidence = probeAgentSessionEvidence(binding.agentId);
  if (!evidence.found || evidence.ambiguous) return null;
  return evidence.sessionFile ?? null;
}

/**
 * 194 C3: enrich a binding with registry session-file evidence. Returns the
 * SAME binding (unchanged) when the registry cannot prove a unique session
 * file — the caller keeps the run but downstream authority stays fail-closed.
 */
export function withRuntimeSessionFileEvidence(binding: StageExecutorBinding): StageExecutorBinding {
  const sessionFile = resolveExecutorSessionFileEvidence(binding);
  if (sessionFile === null || sessionFile === binding.executorSessionFile) return binding;
  return { ...binding, executorSessionFile: sessionFile };
}

/**
 * Record the FIRST trusted child-side binding into the child's own session
 * entries. Idempotent by runId: a second call for the same run never appends
 * a second record (JOIN/re-activation must not refresh identity).
 */
export function recordExecutorBinding(
  writer: BindingEntryWriter,
  binding: StageExecutorBinding,
  existingEntries: readonly BindingEntryLike[],
): { recorded: boolean; reason?: string } {
  const already = readOwnExecutorBinding(existingEntries);
  if (already !== null) {
    if (already.runId === binding.runId) return { recorded: false, reason: "already_recorded" };
    return { recorded: false, reason: "identity_frozen_by_earlier_run" };
  }
  const narrowed = narrowStageExecutorBinding(binding);
  if (!narrowed.ok) return { recorded: false, reason: narrowed.reason };
  try {
    writer.appendEntry(EXECUTOR_BINDING_ENTRY_TYPE, narrowed.binding);
    return { recorded: true };
  } catch (err) {
    return { recorded: false, reason: `append_failed:${err instanceof Error ? err.message : String(err)}` };
  }
}

/**
 * Read THIS session's own executor binding from its local entries (latest
 * wins). A parent JOIN copies meta, not entries, so a child always answers
 * from its own recorded identity — never the parent's snapshot.
 */
export function readOwnExecutorBinding(
  entries: readonly BindingEntryLike[],
): StageExecutorBinding | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry?.type !== "custom" || entry.customType !== EXECUTOR_BINDING_ENTRY_TYPE) continue;
    const narrowed = narrowStageExecutorBinding(entry.data);
    if (narrowed.ok) return narrowed.binding;
    // A malformed binding entry is not identity: keep scanning older entries.
  }
  return null;
}

/** Caller roles resolvable from runtime evidence (C4/C5 gate input). */
export type ExecutorCallerRole =
  | "owner-current"
  | "child-current"
  | "child-stale"
  | "unknown";

/**
 * 194 C4/C5: resolve the caller role for a mutation/tool entry against the
 * owner's CURRENT run. Evidence-only; never a role fail-open:
 * - owner: proven owner session file and NOT a child session.
 * - child-current: the child's own recorded binding equals the current run.
 * - child-stale: the child recorded a binding for a DIFFERENT run.
 * - unknown: missing/contradictory evidence (closed-loop child with no record).
 */
export function resolveExecutorCallerRole(opts: {
  currentRun: StageExecutorRun | undefined;
  callerSessionFile: string | null;
  callerIsChild: boolean;
  ownBinding: StageExecutorBinding | null;
}): ExecutorCallerRole {
  const { currentRun, callerSessionFile, callerIsChild, ownBinding } = opts;
  if (!currentRun || !callerSessionFile) return "unknown";

  if (!callerIsChild) {
    return callerSessionFile === currentRun.binding.ownerSessionFile ? "owner-current" : "unknown";
  }

  if (ownBinding === null) {
    // A closed-loop child that never recorded a binding has NO identity here.
    return "unknown";
  }
  const sameRun =
    ownBinding.runId === currentRun.binding.runId
    && ownBinding.agentId === currentRun.binding.agentId
    && ownBinding.stage === currentRun.binding.stage
    && ownBinding.stageVisitId === currentRun.binding.stageVisitId
    && ownBinding.operationId === currentRun.binding.operationId
    && ownBinding.pipelineId === currentRun.binding.pipelineId;
  if (sameRun) {
    // The recorded session file must agree with the registry evidence when the
    // registry provided one; a contradiction is stale, never current.
    const registryFile = currentRun.binding.executorSessionFile;
    if (registryFile !== undefined && registryFile !== ownBinding.executorSessionFile && ownBinding.executorSessionFile !== undefined) {
      return "child-stale";
    }
    return "child-current";
  }
  return "child-stale";
}
