/**
 * @module design-review/verification-snapshot
 * 194 Phase 1 (C1/C2): ONE capture per consumed deliverable, shared by the
 * trusted domain validator and the groups/flat rule engine.
 *
 * Why this module exists:
 * - 192 captured a single deliverable (report for review, plan for update).
 * - 194 makes the update's output TWO documents (plan + standalone receipt),
 *   and the consumed review report is a third input. Each must be read at most
 *   ONCE per verification pass, and a read failure must be recorded as EVIDENCE
 *   (`readError`) rather than silently omitted, so "missing receipt" can never
 *   degrade into "read the plan body instead".
 * - The OUTPUT binding (`ctx.output`, narrowed from the persisted operation
 *   descriptor) selects what is captured. A not-ok binding captures NOTHING
 *   and fails closed — an unprovable contract must not even touch the disk.
 *
 * This module performs reads only. It never advances stages, writes meta, or
 * dispatches; the shared engine (`runVerification`) and the coordinator consume
 * its results.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import type { TrustedDomainVerificationContext } from "./verification-context";
import type {
  DesignReviewUpdateValidationInput,
  DesignReviewUpdateOutput,
} from "../verifiers/design-review-update-verifier";

/** Update context slice (the only shape the evaluators below accept). */
type UpdateContext = Extract<TrustedDomainVerificationContext, { kind: "update" }>;

/**
 * One captured deliverable: bytes OR the read error that prevented capture.
 * `content === undefined` always pairs with a `readError`.
 */
export interface DeliverableSnapshot {
  /** Canonical absolute path that was read */
  readonly absPath: string;
  /** Exact bytes at capture time (undefined when unreadable) */
  readonly content?: string;
  /** Read failure evidence, recorded once and reused (never retried) */
  readonly readError?: string;
}

/**
 * A set of captured deliverables plus the exact-path lookup the rule engine
 * shares, so a rule and the domain verdict never observe different bytes.
 */
export interface DesignReviewSnapshotSet {
  /** Captured deliverables in capture order (may be empty) */
  readonly entries: readonly DeliverableSnapshot[];
  /** Exact-path lookup: returns captured bytes only for a SUCCESSFUL capture */
  readonly lookup: (absPath: string) => string | undefined;
}

/** Reads one file exactly once; never throws. */
async function captureOne(absPath: string): Promise<DeliverableSnapshot> {
  const canonical = path.resolve(absPath);
  try {
    const content = await fs.readFile(canonical, "utf-8");
    return { absPath: canonical, content };
  } catch (err) {
    return { absPath: canonical, readError: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Absolute paths this context must capture, in order.
 *
 * - review → the current report snapshot.
 * - update (output provable) → plan, consumed report, and — standalone only —
 *   the pinned receipt document.
 * - update (output NOT provable) → NOTHING: an unprovable output contract is
 *   decided without touching the filesystem, so no code path can "discover" a
 *   receipt from a neighbouring file or the plan body.
 */
function deliverablePaths(ctx: TrustedDomainVerificationContext): string[] {
  if (ctx.kind === "review") return [ctx.reportPath];
  if (!ctx.output.ok) return [];
  const receipt = ctx.output.kind === "standalone" ? [ctx.output.receiptDoc] : [];
  return [ctx.planDoc, ctx.reportDoc, ...receipt];
}

/**
 * Capture every deliverable of the current context exactly once and build the
 * shared exact-path lookup (successful captures only, so a failed capture lets
 * a rule fall back to its own read instead of receiving `undefined` bytes).
 */
export async function captureDesignReviewSnapshots(
  ctx: TrustedDomainVerificationContext,
): Promise<DesignReviewSnapshotSet> {
  const targets = deliverablePaths(ctx);
  const entries: DeliverableSnapshot[] = [];
  for (const target of targets) {
    // Sequential on purpose: the same path may appear twice (a report bound
    // both as input and as an exact target); capturing once keeps the
    // "one read per deliverable" promise observable in audits.
    const canonical = path.resolve(target);
    if (entries.some((e) => e.absPath === canonical)) continue;
    entries.push(await captureOne(canonical));
  }
  return {
    entries,
    lookup: (absPath: string): string | undefined => {
      const canonical = path.resolve(absPath);
      const hit = entries.find((e) => e.absPath === canonical && e.content !== undefined);
      return hit?.content;
    },
  };
}

/** Finds the capture for a path, regardless of success. */
function findEntry(set: DesignReviewSnapshotSet, absPath: string): DeliverableSnapshot | undefined {
  const canonical = path.resolve(absPath);
  return set.entries.find((e) => e.absPath === canonical);
}

/**
 * Result of turning captured snapshots into a validator input.
 *
 * `ok:false` carries the fail-closed invalid reasons — including the case where
 * the OUTPUT binding itself is unprovable, which is decided before any read.
 */
export type UpdateSnapshotEvaluation =
  | { ok: true; input: DesignReviewUpdateValidationInput }
  | { ok: false; failures: readonly string[] };

/**
 * Build the `validateDesignReviewUpdate` input from ONE snapshot set.
 *
 * Contract highlights (194 C1/C2):
 * - unprovable output → invalid, and NO body back-fill is ever attempted;
 * - unreadable plan → invalid (the update deliverable must be provable);
 * - unreadable consumed report → the attribution inputs are simply not supplied
 *   as bytes (192 parity): the authoritative coordinator consumption still
 *   fail-closes on it, and the structural verdict must not depend on a report
 *   read that the receipt already binds by hash;
 * - standalone receipt → bytes OR `receiptReadError` are handed to the verifier;
 *   "missing file" is an INVALID verdict, never a legacy downgrade.
 */
export function evaluateUpdateSnapshots(
  ctx: UpdateContext,
  set: DesignReviewSnapshotSet,
): UpdateSnapshotEvaluation {
  if (!ctx.output.ok) {
    return {
      ok: false,
      failures: [
        `update output binding is not provable (${ctx.output.reason}); no snapshot was captured and the plan body is never used as a receipt substitute`,
      ],
    };
  }

  const plan = findEntry(set, ctx.planDoc);
  if (plan === undefined || plan.content === undefined) {
    return {
      ok: false,
      failures: [`plan snapshot unreadable: ${path.resolve(ctx.planDoc)} (${plan?.readError ?? "never captured"})`],
    };
  }

  const report = findEntry(set, ctx.reportDoc);
  const reportContent = report?.content;

  let output: DesignReviewUpdateOutput | undefined;
  if (ctx.output.kind === "standalone") {
    const receipt = findEntry(set, ctx.output.receiptDoc);
    output = {
      kind: "standalone",
      receiptDoc: ctx.output.receiptDoc,
      ...(receipt?.content !== undefined ? { receiptContent: receipt.content } : {}),
      ...(receipt?.readError !== undefined ? { receiptReadError: receipt.readError } : {}),
      baselineSectionsHash: ctx.output.baselineSectionsHash,
    };
  }
  // `legacy` deliberately leaves `output` undefined: pre-194 operations are
  // validated against the embedded section exactly as 192 did.

  return {
    ok: true,
    input: {
      planContent: plan.content,
      baselinePlanHash: ctx.baselinePlanHash,
      reportDoc: ctx.reportDoc,
      reportHash: ctx.reportHash,
      round: ctx.round,
      reviewOperationId: ctx.reviewOperationId,
      ...(reportContent !== undefined ? { reportContent } : {}),
      updateOperationId: ctx.updateOperationId,
      issueIds: ctx.issueIds,
      ...(output !== undefined ? { output } : {}),
      pipelineId: ctx.pipelineId,
      planDoc: ctx.planDoc,
    },
  };
}

/**
 * Machine-readable drift classes the coordinator maps onto lifecycle actions.
 * `*_unreadable` on the consumed report keeps the 192 pause semantics (a
 * storage race is not a model contract violation and must not burn budget),
 * while an unreadable PLAN stays a hard invalid.
 */
export type UpdateDriftReason =
  | "output_binding_unprovable"
  | "plan_unreadable"
  | "plan_hash_drift"
  | "report_unreadable"
  | "report_hash_drift"
  | "receipt_unreadable"
  | "receipt_hash_drift"
  | "unexpected_receipt_hash_for_legacy_output";

/**
 * Pre-advance drift check: recompute the deliverable hashes the READY verdict
 * consumed and compare them with the recorded outcome hashes.
 *
 * Returns the fresh hashes when nothing drifted; a mismatch or an unreadable
 * deliverable is reported so the coordinator can pause instead of advancing on
 * bytes it no longer owns.
 */
export type UpdateDriftResult =
  | { ok: true; planHash: string; receiptHash?: string }
  | { ok: false; reason: UpdateDriftReason; detail?: string };

/**
 * Hashes the update's deliverables from a FRESH single capture each.
 *
 * @param ctx update context (output binding decides whether a receipt exists)
 * @param expectedPlanHash plan hash the READY verdict consumed (drift baseline)
 * @param expectedReceiptHash receipt hash the READY verdict consumed (standalone)
 */
export async function checkUpdateDeliverableDrift(
  ctx: UpdateContext,
  expectedPlanHash: string,
  expectedReceiptHash?: string,
): Promise<UpdateDriftResult> {
  if (!ctx.output.ok) {
    return { ok: false, reason: "output_binding_unprovable", detail: ctx.output.reason };
  }

  const digest = (bytes: string): string =>
    createHash("sha256").update(bytes, "utf-8").digest("hex");

  const set = await captureDesignReviewSnapshots(ctx);

  const plan = findEntry(set, ctx.planDoc);
  if (plan?.content === undefined) {
    return { ok: false, reason: "plan_unreadable", detail: plan?.readError ?? "not captured" };
  }
  const planHash = digest(plan.content);
  if (planHash !== expectedPlanHash) {
    return { ok: false, reason: "plan_hash_drift" };
  }

  // The consumed report must still be the exact snapshot the inputs were bound
  // to: a replaced or vanished report after consumption is drift, never a
  // validation pass (192 issue 8 semantics, now shared by both output modes).
  const report = findEntry(set, ctx.reportDoc);
  if (report?.content === undefined) {
    return { ok: false, reason: "report_unreadable", detail: report?.readError ?? "not captured" };
  }
  if (ctx.reportHash !== "" && digest(report.content) !== ctx.reportHash) {
    return { ok: false, reason: "report_hash_drift" };
  }

  if (ctx.output.kind === "legacy") {
    // No receipt document exists; the plan hash is the whole output evidence.
    if (expectedReceiptHash !== undefined) {
      return { ok: false, reason: "unexpected_receipt_hash_for_legacy_output" };
    }
    return { ok: true, planHash };
  }

  const receipt = findEntry(set, ctx.output.receiptDoc);
  if (receipt?.content === undefined) {
    return { ok: false, reason: "receipt_unreadable", detail: receipt?.readError ?? "not captured" };
  }
  const receiptHash = digest(receipt.content);
  if (expectedReceiptHash !== undefined && receiptHash !== expectedReceiptHash) {
    return { ok: false, reason: "receipt_hash_drift" };
  }
  return { ok: true, planHash, receiptHash };
}
