/**
 * @module stage-executor/commit-guard
 * 194 Phase 0 (C3): strict-commit comparison rules for the latest
 * `SessionMeta.stageExecutorRun`.
 *
 * Two guarantees this module provides to `session-state.ts`:
 *
 * 1. `matchStageExecutorExpectation` — a strict commit may proceed only when
 *    the CURRENT persisted run matches every requested identity component
 *    (stage / visit / runId / terminalConsumed / declarationRevision /
 *    resultKey). `null` expectations assert ABSENCE.
 * 2. `stageExecutorRunPatchViolation` — a PLAIN (expectation-less) whole-meta
 *    write (e.g. a stale subagent JOIN echo) may never erase or replace a
 *    live run record. Equal payloads are allowed (idempotent echoes); any
 *    change requires a strict commit with expectations.
 *
 * Both comparisons are synchronous single-writer semantics — no cross-process
 * CAS claim is made anywhere.
 */

import type { SessionMeta } from "../../types";
import type {
  StageExecutorExpectation,
  StageExecutorRun,
} from "./contracts";

/**
 * Canonical JSON (sorted keys) — insertion order never masks a real change.
 *
 * 194 Phase 3 (C5): members whose value is `undefined` are dropped, exactly
 * like JSON.stringify does. Both this guard and the strict-commit read-back in
 * `session-state.ts` must canonicalize the SAME way, or a write that clears an
 * optional field (e.g. `pendingWakeId: undefined`) would compare differently
 * in-memory than on disk.
 */
function canonicalJson(value: unknown): string {
  if (value === undefined) return "undefined";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(",")}}`;
}

/**
 * Compare the CURRENT run against executor expectations. Returns a conflict
 * reason, or null when the commit may proceed.
 *
 * A run-less expectation set (ordinary non-closed-loop commit) passes through
 * untouched: only the fields the caller explicitly pins are compared.
 */
export function matchStageExecutorExpectation(
  current: SessionMeta,
  expected: StageExecutorExpectation,
): string | null {
  const run = current.stageExecutorRun;
  const hasExpectation =
    expected.executorStage !== undefined
    || expected.executorStageVisitId !== undefined
    || expected.executorRunId !== undefined
    || expected.executorTerminalConsumed !== undefined
    || expected.executorDeclarationRevision !== undefined
    || expected.executorResultKey !== undefined
    || expected.executorPipelineId !== undefined
    || expected.executorOperationId !== undefined;
  if (!hasExpectation) return null;

  // `null` asserts there is NO current run; nothing else is compared then.
  if (expected.executorRunId === null) {
    return run === undefined ? null : "executor_run_expected_absent";
  }
  if (run === undefined) return "executor_run_missing";

  if (expected.executorRunId !== undefined && run.binding.runId !== expected.executorRunId) {
    return "executor_run_mismatch";
  }
  if (expected.executorPipelineId !== undefined && run.binding.pipelineId !== expected.executorPipelineId) {
    return "executor_pipeline_mismatch";
  }
  if (expected.executorStage !== undefined && run.binding.stage !== expected.executorStage) {
    return "executor_stage_mismatch";
  }
  if (
    expected.executorStageVisitId !== undefined
    && run.binding.stageVisitId !== expected.executorStageVisitId
  ) {
    return "executor_visit_mismatch";
  }
  if (
    expected.executorOperationId !== undefined
    && run.binding.operationId !== expected.executorOperationId
  ) {
    return "executor_operation_mismatch";
  }
  if (
    expected.executorTerminalConsumed !== undefined
    && run.terminalConsumed !== expected.executorTerminalConsumed
  ) {
    return "executor_terminal_mismatch";
  }
  if (expected.executorDeclarationRevision !== undefined) {
    const rev = run.declaration?.revision;
    if (expected.executorDeclarationRevision === null) {
      if (rev !== undefined) return "executor_declaration_expected_absent";
    } else if (rev !== expected.executorDeclarationRevision) {
      return "executor_declaration_mismatch";
    }
  }
  if (expected.executorResultKey !== undefined) {
    const key = run.consumption?.resultKey;
    if (expected.executorResultKey === null) {
      if (key !== undefined) return "executor_result_key_expected_absent";
    } else if (key !== expected.executorResultKey) {
      return "executor_result_key_mismatch";
    }
  }
  return null;
}

/**
 * 194 C3: violation reason when a PLAIN patch would erase or replace the
 * CURRENT run with a different payload, or null when harmless.
 *
 * The rule is INDEPENDENT of the design-review barrier: after `finished` the
 * develop run is still the authority for permission release, so a stale
 * whole-meta write must not clear it even when the domain loop is closed.
 */
export function stageExecutorRunPatchViolation(
  patch: Partial<SessionMeta>,
  authoritative: SessionMeta,
): string | null {
  if (!("stageExecutorRun" in patch)) return null;
  const want = patch.stageExecutorRun;
  const got = authoritative.stageExecutorRun;
  if (canonicalJson(want) === canonicalJson(got)) return null;
  if (want === undefined) return "executor_run_clear_requires_strict";
  return "executor_run_overwrite_requires_strict";
}

/** Expectation anchor built from the CURRENT run (strict "unchanged since read"). */
export function executorExpectationFromCurrent(meta: SessionMeta): StageExecutorExpectation {
  const run = meta.stageExecutorRun;
  if (!run) return { executorRunId: null };
  return {
    executorPipelineId: run.binding.pipelineId,
    executorStage: run.binding.stage,
    executorStageVisitId: run.binding.stageVisitId,
    executorRunId: run.binding.runId,
    executorTerminalConsumed: run.terminalConsumed,
    executorDeclarationRevision: run.declaration?.revision ?? null,
    executorResultKey: run.consumption?.resultKey ?? null,
  };
}

/** True when the CURRENT meta has a live (running/unknown) executor run. */
export function hasLiveExecutorRun(meta: SessionMeta | undefined): boolean {
  const run: StageExecutorRun | undefined = meta?.stageExecutorRun;
  if (!run) return false;
  return run.status === "running" || run.status === "unknown";
}
