/**
 * @module usage-recorder
 * 210 Phase 7 (requirement 5.9, R2 record-only): per-stage model / token /
 * cost accounting from `message_end` events.
 *
 * How it answers "which stage used which model and cost how much":
 * - the `message_end` hook aggregates every assistant message carrying a
 *   `usage` block INTO AN IN-PROCESS STORE keyed `pipelineId → stage`
 *   (owner and child sessions share the process and the same pipelineId, so
 *   per-message meta writes — the shared-store race — are avoided entirely);
 * - `flushUsageToMeta` drains the store into `meta.usageByStage` at controlled
 *   points only (agent settle, stage exit, terminal, session shutdown);
 *   flush is IDEMPOTENT (an empty delta writes nothing);
 * - `takeStageUsageAuditFields` renders the exiting stage's cumulative
 *   snapshot as flat `Record<string, string>` extras for the `stage_usage`
 *   audit event (written by the exit sites next to the Phase 4 evidence).
 *
 * Attribution guard: a message whose timestamp predates the current stage
 * entry by more than 60s is still counted (never dropped) but flags the
 * stage's `attributionSuspect` ledger — visible in the `stage_usage` audit.
 *
 * Design constraints honored:
 * - factory takes NO config (no stage/threshold dependency — plan task 1);
 * - messages without `usage` (or non-assistant roles) produce ZERO writes;
 *   dormant sessions return immediately;
 * - no new dependencies, no new switches: the recorder is always-on but its
 *   only observable deltas are `meta.usageByStage` and `stage_usage` audits.
 */

import type { Hook, PipelineStage, SessionMeta, StageUsageSnapshot } from "../types";
import type { SessionState } from "./session-state";
import { isDormant } from "./dormancy";

/** Sessions may be flush-capable subsets of the full adapter (plan: `Pick`). */
type FlushSession = Pick<SessionState, "getMeta" | "updateMeta">;

/** Suspect window: messages older than stage entry + this margin are flagged. */
export const USAGE_ATTRIBUTION_MARGIN_MS = 60_000;

// ─── In-process accumulator ───────────────────────────────────────────────────

/** Pending (unflushed) per-stage usage delta plus the suspect flag ledger. */
interface StageUsageDelta {
  provider: string;
  model: string;
  messages: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  costUsd: number;
  updatedAt: number;
}

/**
 * `pipelineId → stage → pending delta` (never written to disk directly).
 * Owner and child sessions in one process share the entry for the same
 * pipelineId — the single flush point per control event keeps meta writes
 * serialized.
 */
const usageStore = new Map<string, Map<string, StageUsageDelta>>();

/**
 * `pipelineId → touched` — true once at least one usage-bearing assistant
 * message was aggregated for the pipeline. Gates the `stage_usage` exit audit:
 * synthetic contexts that never produced a message produce no audit line.
 */
const touchedPipelines = new Set<string>();

/**
 * `pipelineId → stage → flagged` suspect ledger. Survives flushes (the delta
 * it rode in is drained); consumed by `takeStageUsageAuditFields` at the stage
 * exit so "exactly one stage_usage per exit" reports the suspects of THAT exit.
 */
const suspectLedger = new Map<string, Set<string>>();

/** Numeric field of a possibly-loose usage record (`inputTokens` aliases). */
function num(...candidates: unknown[]): number {
  for (const c of candidates) {
    if (typeof c === "number" && Number.isFinite(c)) return c;
  }
  return 0;
}

/** String field with "unknown" fallback (model/provider ids). */
function str(v: unknown): string {
  return typeof v === "string" && v.length > 0 ? v : "unknown";
}

/** Normalize a possibly-ISO / possibly-missing message timestamp to epoch ms. */
function msgTime(v: unknown): number {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const parsed = Date.parse(v);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return Date.now();
}

/**
 * Extracts the aggregation inputs from a raw `message_end` event message.
 * Returns null for anything that must NOT be written (non-assistant role,
 * missing/empty usage block) — acceptance: "messages without usage produce no
 * writes".
 */
export function parseUsageMessage(raw: unknown): {
  model: string;
  provider: string;
  timestamp: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  costUsd: number;
} | null {
  if (typeof raw !== "object" || raw === null) return null;
  const msg = raw as Record<string, unknown>;
  if (msg.role !== "assistant") return null;

  const usage = msg.usage as Record<string, unknown> | undefined | null;
  if (typeof usage !== "object" || usage === null) return null;

  const input = num(usage.input, usage.inputTokens);
  const output = num(usage.output, usage.outputTokens);
  const cacheRead = num(usage.cacheRead, usage.cacheReadTokens);
  const cacheWrite = num(usage.cacheWrite, usage.cacheWriteTokens);
  const totalTokens = num(usage.totalTokens, input + output + cacheRead + cacheWrite);

  // `cost` may be a flat number or a `{ usd }` block (pi-ai shape tolerance).
  const costObj = usage.cost as Record<string, unknown> | number | undefined;
  const costUsd = num(usage.costUsd, typeof costObj === "object" && costObj !== null ? costObj.usd : costObj);

  if (input === 0 && output === 0 && cacheRead === 0 && cacheWrite === 0 && costUsd === 0) {
    // An all-zero usage block carries no information — no write, no touch.
    return null;
  }

  const model = str(msg.model ?? usage.model);
  let provider = str(msg.provider ?? usage.provider);
  if (provider === "unknown" && model.includes("/")) {
    // "provider/model-id" convention fallback.
    provider = model.split("/")[0] ?? "unknown";
  }

  return { model, provider, timestamp: msgTime(msg.timestamp), input, output, cacheRead, cacheWrite, totalTokens, costUsd };
}

/** Aggregates one parsed usage sample under `pipelineId → currentStage`. */
function recordSample(meta: SessionMeta, sample: NonNullable<ReturnType<typeof parseUsageMessage>>): void {
  const pipelineId = meta.pipelineId;
  const stage = meta.currentStage;

  let stages = usageStore.get(pipelineId);
  if (!stages) {
    stages = new Map<string, StageUsageDelta>();
    usageStore.set(pipelineId, stages);
  }
  const delta = stages.get(stage);
  if (delta) {
    delta.messages += 1;
    delta.input += sample.input;
    delta.output += sample.output;
    delta.cacheRead += sample.cacheRead;
    delta.cacheWrite += sample.cacheWrite;
    delta.totalTokens += sample.totalTokens;
    delta.costUsd += sample.costUsd;
    delta.updatedAt = sample.timestamp;
    // Last non-unknown identity wins (a stage may switch models mid-run).
    if (sample.model !== "unknown") delta.model = sample.model;
    if (sample.provider !== "unknown") delta.provider = sample.provider;
  } else {
    stages.set(stage, {
      provider: sample.provider,
      model: sample.model,
      messages: 1,
      input: sample.input,
      output: sample.output,
      cacheRead: sample.cacheRead,
      cacheWrite: sample.cacheWrite,
      totalTokens: sample.totalTokens,
      costUsd: sample.costUsd,
      updatedAt: sample.timestamp,
    });
  }

  touchedPipelines.add(pipelineId);

  // Attribution suspect: the sample predates the stage entry by > 60s (a late
  // tail message from the PREVIOUS stage visit). Kept (never dropped), flagged.
  const stageStart = meta.stageStartTime ?? 0;
  if (stageStart > 0 && sample.timestamp < stageStart - USAGE_ATTRIBUTION_MARGIN_MS) {
    let flagged = suspectLedger.get(pipelineId);
    if (!flagged) {
      flagged = new Set<string>();
      suspectLedger.set(pipelineId, flagged);
    }
    flagged.add(stage);
  }
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

/**
 * Creates the `message_end` usage recorder hook. No config parameter by
 * design (plan task 1: no stage/threshold dependency — avoids unused-arg
 * noise). The factory never throws: aggregation is best-effort.
 */
export function createUsageRecorder(): Hook<"message_end"> {
  return {
    event: "message_end",
    handler: async (ctx): Promise<void> => {
      try {
        const meta = ctx.session.getMeta() as SessionMeta | undefined;
        if (!meta?.pipelineId) return;
        // Dormant (aborted / completed / no pipeline): nothing may be recorded.
        if (isDormant(meta)) return;

        const event = ctx.event as { message?: unknown } | undefined;
        const sample = parseUsageMessage(event?.message);
        if (!sample) return;

        recordSample(meta, sample);
      } catch {
        // Fail-open: usage accounting must never disturb the message flow.
      }
    },
  };
}

// ─── Flush / reset / audit API ────────────────────────────────────────────────

/**
 * Drains the in-process delta for `pipelineId` into `meta.usageByStage`
 * (additive merge; identities take the delta's latest value). An empty delta
 * performs NO meta write — flush is idempotent and usage-less messages leave
 * the meta untouched.
 */
export function flushUsageToMeta(session: FlushSession, pipelineId: string): void {
  const stages = usageStore.get(pipelineId);
  if (!stages || stages.size === 0) return;

  const meta = session.getMeta() as SessionMeta | undefined;
  if (!meta) return;

  const usageByStage: Partial<Record<PipelineStage, StageUsageSnapshot>> = { ...meta.usageByStage };
  for (const [stage, d] of stages) {
    const key = stage as PipelineStage;
    const prev = usageByStage[key];
    usageByStage[key] = {
      provider: d.provider,
      model: d.model,
      messages: (prev?.messages ?? 0) + d.messages,
      input: (prev?.input ?? 0) + d.input,
      output: (prev?.output ?? 0) + d.output,
      cacheRead: (prev?.cacheRead ?? 0) + d.cacheRead,
      cacheWrite: (prev?.cacheWrite ?? 0) + d.cacheWrite,
      totalTokens: (prev?.totalTokens ?? 0) + d.totalTokens,
      costUsd: (prev?.costUsd ?? 0) + d.costUsd,
      updatedAt: d.updatedAt,
    };
  }

  session.updateMeta({ usageByStage });
  // Drain AFTER the write so a throwing adapter leaves the delta retryable.
  stages.clear();
}

/**
 * Drops every in-process state for a pipeline (restart / new period with a
 * superseded pipelineId) — no cross-period usage residue.
 */
export function resetUsage(pipelineId: string): void {
  usageStore.delete(pipelineId);
  touchedPipelines.delete(pipelineId);
  suspectLedger.delete(pipelineId);
}

/**
 * Flushes the delta and renders the EXITING stage's cumulative snapshot as
 * flat audit extras for the `stage_usage` event (requirement 5.9 keys:
 * model, provider, messages, inputTokens, outputTokens, cacheRead, cacheWrite,
 * totalTokens, costUsd — plus the consumed attributionSuspect flag).
 *
 * Returns null when the pipeline never recorded any usage (synthetic /
 * usage-less runs stay silent); otherwise a zero-filled snapshot is emitted
 * for a stage that was entered but consumed no model output.
 */
export function takeStageUsageAuditFields(
  session: FlushSession,
  pipelineId: string,
  stage: PipelineStage,
): Record<string, string> | null {
  if (!touchedPipelines.has(pipelineId)) return null;

  flushUsageToMeta(session, pipelineId);

  const meta = session.getMeta() as SessionMeta | undefined;
  const snap = meta?.usageByStage?.[stage];

  const flagged = suspectLedger.get(pipelineId);
  const suspect = flagged?.has(stage) === true;
  if (flagged) flagged.delete(stage);

  return {
    stage,
    model: snap?.model ?? "unknown",
    provider: snap?.provider ?? "unknown",
    messages: String(snap?.messages ?? 0),
    inputTokens: String(snap?.input ?? 0),
    outputTokens: String(snap?.output ?? 0),
    cacheRead: String(snap?.cacheRead ?? 0),
    cacheWrite: String(snap?.cacheWrite ?? 0),
    totalTokens: String(snap?.totalTokens ?? 0),
    costUsd: String(snap?.costUsd ?? 0),
    attributionSuspect: suspect ? "true" : "false",
  };
}

/**
 * Test/diagnostic view: the current pending (unflushed) snapshots for a
 * pipeline. Empty object when nothing accumulated.
 */
export function __usageSnapshot(pipelineId: string): Record<string, StageUsageSnapshot> {
  const out: Record<string, StageUsageSnapshot> = {};
  const stages = usageStore.get(pipelineId);
  if (stages) {
    for (const [stage, d] of stages) {
      out[stage] = { ...d };
    }
  }
  return out;
}
