/**
 * @module verifiers/design-review-update-verifier
 * 192 Phase 2 (K08, F03) + 194 Phase 1 (C1/C2): structural validation of an
 * authorized plan update.
 *
 * Pure read-only evaluator over provided snapshots (plan content, consumed
 * report attribution and — 194 — the STANDALONE receipt document bytes). It
 * NEVER advances stages, writes meta, or dispatches; the domain coordinator
 * consumes the verdict.
 *
 * Contract enforced (all structural failures ⇒ invalid, K08):
 * - 194 C1/C2 — the update's OUTPUT binding decides where the receipt lives:
 *   * `standalone`: the receipt document carries the `## Design Review Update`
 *     section, its identity rows, `### Issue Dispositions` and
 *     `### Changes Made`. The plan body must NOT gain or update a protocol
 *     section (fence-aware digest vs the pinned `baselineSectionsHash`), and
 *     a missing/unreadable receipt is NEVER back-filled from the plan body.
 *   * `legacy`: the 192 behaviour — the CURRENT `## Design Review Update`
 *     section inside the plan body. This path is only ever reached for
 *     operations that pre-date 194 (absent descriptor), never for new ones.
 * - The CURRENT section is identified by its association fields: Report path
 *   (the consumed review report), Round, Operation (= the CURRENT UPDATE
 *   operationId), Baseline Hash (= the baseline plan hash). Old-round sections
 *   (different Operation) are ignored; a second section claiming the CURRENT
 *   operation is a duplicate → invalid.
 * - Report ATTRIBUTION to the consumed review identity (plan Phase 2 task 6)
 *   is enforced HERE whenever the caller hands over the read-only report
 *   snapshot (`reportContent`, the exact bytes the caller already bound
 *   inputs to — never a second file read): the snapshot must still hash to
 *   the consumed `reportHash`, and its declared `**operation**` row must
 *   equal the consumed `reviewOperationId`. Without a snapshot the verdict
 *   stays structural; the authoritative coordinator consumption additionally
 *   fail-closes on an unreadable/drifted consumed report.
 * - Every valid issue id of the consumed report appears EXACTLY ONCE with a
 *   disposition of fixed/deferred/rejected and a non-empty justification.
 *   Missing, duplicate, or unknown ids, or association mismatches are
 *   invalid — no "reason prefix" leniency (F03 root cause).
 * - Sentinel dispositions `new-decision` / `unfixable` PAUSE for the owner
 *   (they are not format failures).
 * - An unchanged plan hash ⇒ paused(no-change). A changed hash with a
 *   structurally complete section ⇒ ready. `fixed` does NOT prove semantic
 *   correctness — fix QUALITY is judged by the NEXT review round; a hash
 *   check is explicitly not a quality review.
 *
 * 194 Phase 1: the fence-aware markdown mechanics moved to
 * `../design-review/update-receipt.ts` and are SHARED by both output modes.
 */

import { createHash } from "node:crypto";
import * as path from "node:path";
import {
  CHANGES_MADE_HEADING,
  extractField,
  extractFieldRows,
  findSubBlock,
  findUpdateSections,
  hasPhaseLocationMarker,
  contentLines,
  parseDispositionRows,
  RECEIPT_IDENTITY_FIELDS,
  type UpdateSectionSpan,
} from "../design-review/update-receipt";
import { computeBaselineSectionsHash, extractLegacyUpdateSections } from "../design-review/update-artifact";

/**
 * 194 C1/C2: the narrowed OUTPUT binding of the CURRENT update operation.
 * Produced by the caller from the PERSISTED operation descriptor
 * (`narrowUpdateArtifact`) — never from tool args or override paths.
 */
export type DesignReviewUpdateOutput =
  /** Pre-194 operation: receipt is the embedded plan-body section (192). */
  | { kind: "legacy" }
  /** 194 operation: receipt is the standalone document pinned by C1. */
  | {
      kind: "standalone";
      /** Absolute receipt path from the descriptor (evidence in messages). */
      receiptDoc: string;
      /** Exact bytes captured ONCE by the snapshot layer. */
      receiptContent?: string;
      /** Read failure recorded at capture time (invalid, never retried). */
      receiptReadError?: string;
      /** C1 baseline digest of the plan body's legacy protocol sections. */
      baselineSectionsHash: string;
    };

/** Inputs bound to the CURRENT update operation + consumed report receipt. */
export interface DesignReviewUpdateValidationInput {
  /** Current plan document content (fresh read by the caller) */
  planContent: string;
  /** Baseline hash recorded when the update was dispatched */
  baselinePlanHash: string;
  /** Canonical path of the consumed review report */
  reportDoc: string;
  /** Hash of the consumed report. Enforced against `reportContent` when a
   *  snapshot is supplied; carried as receipt attribution otherwise. */
  reportHash: string;
  /** Review round the consumed report belongs to */
  round: number;
  /** Operation id of the CONSUMED review. Enforced against the consumed
   *  report's declared `**operation**` row when `reportContent` is supplied
   *  (a snapshot whose ownership row names a different review is invalid).
   *  The sentinel "unknown" (191-legacy meta without a receipt) skips the
   *  ownership comparison — there is no consumed identity to compare to. */
  reviewOperationId: string;
  /** Optional read-only snapshot of the consumed report — the exact bytes the
   *  caller already bound inputs to. When present, report attribution
   *  (snapshot hash vs `reportHash`, declared operation vs
   *  `reviewOperationId`) is verified inside this evaluator. */
  reportContent?: string;
  /** Operation id of the CURRENT update operation (the section must match THIS) */
  updateOperationId: string;
  /** Valid issue ids of the consumed report (1-based ordinals as strings) */
  issueIds: readonly string[];
  /**
   * 194 C1/C2: where this update's receipt must be. ABSENT means the caller
   * could not prove the output contract — treated as `legacy` ONLY by callers
   * that hold an explicitly identified pre-194 operation; the production
   * domain path always supplies it.
   */
  output?: DesignReviewUpdateOutput;
  /** 194 C2: pipeline identity row a standalone receipt must carry. */
  pipelineId?: string;
  /** 194 C2: plan document path a standalone receipt must name. */
  planDoc?: string;
}

export type DesignReviewUpdateVerdict =
  | {
      status: "ready";
      newPlanHash: string;
      /** Dispositions found (for audit) */
      disposedIssueIds: string[];
      /**
       * 194 C2: SHA-256 of the standalone receipt bytes the verdict consumed.
       * Present only for the standalone output mode — the plan hash alone no
       * longer describes the update's full output.
       */
      receiptHash?: string;
    }
  | { status: "invalid"; failures: string[] }
  | { status: "paused"; reason: "no-change" | "new-decision"; detail?: string };

/** Dispositions that advance the loop */
const ADVANCE_DISPOSITIONS = new Set(["fixed", "deferred", "rejected"]);
/** Sentinel dispositions that pause for the owner */
const PAUSE_DISPOSITIONS = new Set(["new-decision", "unfixable"]);

/**
 * Compute the SHA-256 hash of plan content (same algorithm as domain state).
 */
export function computePlanHash(content: string): string {
  return createHash("sha256").update(content, "utf-8").digest("hex");
}

function samePath(a: string, b: string): boolean {
  try {
    return path.resolve(a) === path.resolve(b);
  } catch {
    return false;
  }
}

/**
 * Shared disposition gate (both output modes): unknown ids, bad dispositions,
 * empty justifications, missing/duplicate entries fail the contract; the
 * surviving per-issue entries are returned for the sentinel check.
 */
function collectDispositions(
  lines: readonly string[],
  issueIds: readonly string[],
  failures: string[]
): Map<string, { count: number; disposition: string; justification: string }> {
  const rows = parseDispositionRows(lines);
  if (rows.length === 0) {
    failures.push("no disposition rows found in the current update section");
  }

  const expected = new Set(issueIds);
  const seen = new Map<string, { count: number; disposition: string; justification: string }>();
  for (const row of rows) {
    if (!expected.has(row.issueId)) {
      failures.push(`unknown issue id "${row.issueId}" (not part of the consumed report)`);
      continue;
    }
    if (!ADVANCE_DISPOSITIONS.has(row.disposition) && !PAUSE_DISPOSITIONS.has(row.disposition)) {
      failures.push(`issue "${row.issueId}": unknown disposition "${row.disposition}"`);
      continue;
    }
    if (row.justification.trim() === "") {
      failures.push(`issue "${row.issueId}": empty justification`);
      continue;
    }
    const prev = seen.get(row.issueId);
    if (prev) prev.count += 1;
    else seen.set(row.issueId, { count: 1, disposition: row.disposition, justification: row.justification });
  }

  for (const id of expected) {
    const entry = seen.get(id);
    if (!entry) {
      failures.push(`issue id "${id}" lacks exactly one disposition entry`);
    } else if (entry.count > 1) {
      failures.push(`issue id "${id}" has ${entry.count} disposition entries (must be exactly one)`);
    }
  }
  return seen;
}

/**
 * Shared consumed-report attribution (192 issue 8 / Phase 2 task 6): the
 * snapshot the caller bound inputs to must still hash to the consumed
 * `reportHash` and declare the consumed `reviewOperationId`.
 */
function validateReportAttribution(
  input: DesignReviewUpdateValidationInput,
  failures: string[]
): void {
  if (input.reportContent === undefined) return;
  if (input.reportHash !== "") {
    const snapshotHash = computePlanHash(input.reportContent);
    if (snapshotHash !== input.reportHash) {
      failures.push(
        "consumed report snapshot no longer matches the receipt reportHash (report was replaced after consumption)"
      );
    }
  }
  if (input.reviewOperationId !== "" && input.reviewOperationId !== "unknown") {
    // Same label parity as the report verifier (design-review-verifier.ts
    // "operation" + shipped-template alias "operationId", 192 Phase 5).
    const reportLines = input.reportContent.split("\n");
    const declared = extractField(reportLines, "operation") ?? extractField(reportLines, "operationId");
    if (declared === undefined) {
      failures.push(
        `consumed report snapshot does not declare its review operation (expected "${input.reviewOperationId}")`
      );
    } else if (declared !== input.reviewOperationId) {
      failures.push(
        `consumed report belongs to review operation "${declared}", not the consumed review operation "${input.reviewOperationId}"`
      );
    }
  } else if (input.reviewOperationId === "") {
    // Empty review operation id cannot match anything: fail closed.
    failures.push("consumed review operation id is empty — report ownership cannot be established");
  }
}

/**
 * 194 C2: validate the STANDALONE receipt document bytes against the pinned
 * update identity, then apply the shared disposition/attribution gates plus
 * the plan-body protocol-section freeze (C1 `baselineSectionsHash`).
 */
function validateStandaloneReceipt(
  input: DesignReviewUpdateValidationInput,
  output: Extract<DesignReviewUpdateOutput, { kind: "standalone" }>,
  newPlanHash: string
): DesignReviewUpdateVerdict {
  const failures: string[] = [];

  // Storage evidence first: a receipt the snapshot layer could not read is a
  // hard invalid — "缺文件/读取错误" never falls back to the plan body.
  if (output.receiptReadError !== undefined) {
    return {
      status: "invalid",
      failures: [`standalone update receipt unreadable: ${output.receiptDoc} (${output.receiptReadError})`],
    };
  }
  const receiptContent = output.receiptContent;
  if (receiptContent === undefined) {
    return {
      status: "invalid",
      failures: [`standalone update receipt snapshot was never captured: ${output.receiptDoc}`],
    };
  }
  if (receiptContent.trim() === "") {
    return {
      status: "invalid",
      failures: [`standalone update receipt is empty: ${output.receiptDoc}`],
    };
  }

  // The receipt document carries EXACTLY ONE `## Design Review Update`
  // section. A retry overwrites the file; a second section (same or foreign
  // Operation) is ambiguous evidence — invalid, never "the latest one wins".
  const sections = findUpdateSections(receiptContent.split("\n"));
  if (sections.length === 0) {
    return {
      status: "invalid",
      failures: [
        `standalone update receipt is missing the \`## Design Review Update\` section (exact heading required): ${output.receiptDoc}`,
      ],
    };
  }
  if (sections.length > 1) {
    return {
      status: "invalid",
      failures: [
        `standalone update receipt carries ${sections.length} \`## Design Review Update\` sections (must be exactly one): ${output.receiptDoc}`,
      ],
    };
  }
  const section = sections[0]!;

  // ── Identity rows (duplicate-aware, all required) ─────────────────────────
  validateIdentityRows(section, input, failures);

  // ── Consumed-report attribution (shared gate) ─────────────────────────────
  validateReportAttribution(input, failures);

  // ── Dispositions (shared gate) ────────────────────────────────────────────
  const seen = collectDispositions(section.lines, input.issueIds, failures);

  // ── Changes Made: required, and `fixed` must cite a Phase location ────────
  const changesBlock = findSubBlock(section.lines, CHANGES_MADE_HEADING);
  const changeEntries = changesBlock ? contentLines(changesBlock.lines) : [];
  if (changeEntries.length === 0) {
    failures.push("standalone update receipt has no `### Changes Made` entries");
  } else {
    const anyFixed = [...seen.values()].some((e) => e.disposition === "fixed");
    if (anyFixed && !hasPhaseLocationMarker(changeEntries)) {
      failures.push(
        "a `fixed` disposition requires the actual plan Phase location in `### Changes Made` (e.g. \"Phase 3\")"
      );
    }
  }

  // ── Plan body must NOT gain/update a protocol section (C1 baseline) ───────
  // The SAME digest the preparation time pinned (`computeBaselineSectionsHash`)
  // is recomputed here: unchanged historical sections are tolerated, any new
  // or edited protocol section mismatches.
  const bodyHashNow = computeBaselineSectionsHash(extractLegacyUpdateSections(input.planContent));
  if (bodyHashNow !== output.baselineSectionsHash) {
    failures.push(
      "plan body gained or updated a `## Design Review Update` protocol section; the receipt must live in the standalone document (frozen baseline sections hash mismatch)"
    );
  }

  if (failures.length > 0) {
    return { status: "invalid", failures };
  }

  // Sentinel pause takes precedence over ready (owner decision required).
  for (const [, entry] of seen) {
    if (PAUSE_DISPOSITIONS.has(entry.disposition)) {
      return {
        status: "paused",
        reason: "new-decision",
        detail: `sentinel disposition "${entry.disposition}" requires owner review`,
      };
    }
  }

  return {
    status: "ready",
    newPlanHash,
    disposedIssueIds: [...seen.keys()],
    receiptHash: computePlanHash(receiptContent),
  };
}

/**
 * 194 C2: the standalone receipt's seven identity rows are all REQUIRED,
 * declared at most once each (duplicates are ambiguous evidence → invalid),
 * and must equal the pinned update identity. Path rows compare canonically.
 */
function validateIdentityRows(
  section: UpdateSectionSpan,
  input: DesignReviewUpdateValidationInput,
  failures: string[]
): void {
  const expect = (
    labels: readonly string[],
    expected: string | undefined,
    label: string,
    compare: (got: string, want: string) => boolean = (a, b) => a === b
  ): void => {
    const scan = extractFieldRows(section.lines, labels);
    if (scan.rows.length === 0) {
      failures.push(`standalone update receipt is missing the \`${label}\` identity row`);
      return;
    }
    if (scan.duplicate) {
      failures.push(`standalone update receipt declares \`${label}\` more than once (ambiguous identity)`);
      return;
    }
    const got = scan.rows[0]!.value;
    const want = expected ?? "";
    if (want === "") {
      failures.push(`\`${label}\` cannot be verified: the pinned identity value is empty`);
      return;
    }
    if (!compare(got, want)) {
      failures.push(`\`${label}\` "${got}" does not match the pinned identity "${want}"`);
    }
  };

  expect(RECEIPT_IDENTITY_FIELDS.pipeline, input.pipelineId, "Pipeline");
  expect(RECEIPT_IDENTITY_FIELDS.plan, input.planDoc, "Plan", samePath);
  expect(RECEIPT_IDENTITY_FIELDS.reviewOperation, input.reviewOperationId, "Review Operation");
  expect(RECEIPT_IDENTITY_FIELDS.report, input.reportDoc, "Report", samePath);
  expect(RECEIPT_IDENTITY_FIELDS.round, String(input.round), "Round");
  expect(RECEIPT_IDENTITY_FIELDS.operation, input.updateOperationId, "Operation");
  expect(RECEIPT_IDENTITY_FIELDS.baselineHash, input.baselinePlanHash, "Baseline Hash");
}



/**
 * Validate the authorized plan update against the CURRENT update identity
 * and the consumed report receipt. See module docs for the full contract.
 *
 * Any structural failure ⇒ invalid (valid=false semantics). Only the two
 * explicit pause classes (unchanged hash, sentinel dispositions) return
 * paused; nothing else guesses readiness.
 */
export function validateDesignReviewUpdate(
  input: DesignReviewUpdateValidationInput,
): DesignReviewUpdateVerdict {
  const failures: string[] = [];

  const newPlanHash = computePlanHash(input.planContent);
  if (newPlanHash === input.baselinePlanHash) {
    return { status: "paused", reason: "no-change", detail: "plan content hash identical to baseline" };
  }

  // 194 Phase 1 (C1/C2): the output binding selects the contract. A missing
  // binding is the EXPLICIT legacy call shape (192 callers stay compatible).
  const output = input.output;
  if (output && output.kind === "standalone") {
    return validateStandaloneReceipt(input, output, newPlanHash);
  }

  const lines = input.planContent.split("\n");
  const sections = findUpdateSections(lines);
  if (sections.length === 0) {
    return {
      status: "invalid",
      failures: ["missing `## Design Review Update` section (exact heading required)"],
    };
  }

  // Identify CURRENT sections by their Operation association field.
  const current: UpdateSectionSpan[] = [];
  let sawOtherOperation = false;
  for (const s of sections) {
    const op = extractField(s.lines, "Operation");
    if (op === input.updateOperationId) current.push(s);
    else sawOtherOperation = true;
  }

  if (current.length === 0) {
    return {
      status: "invalid",
      failures: [
        `no current ` +
          (sawOtherOperation
            ? "`## Design Review Update` section for this update operation (only stale/foreign sections found — old sections never count)"
            : "`## Design Review Update` section carries the current Operation id"),
      ],
    };
  }
  if (current.length > 1) {
    return { status: "invalid", failures: ["duplicate `## Design Review Update` sections for the same Operation id"] };
  }

  const section = current[0]!;

  // ── Report attribution to the consumed review identity (Phase 2 task 6) ──
  // Only verified when the caller supplies the read-only report snapshot it
  // already bound inputs to (no second file read here). A snapshot that no
  // longer matches the consumed hash, or whose ownership row names a
  // different review operation, proves the section is NOT attributed to the
  // review this update answers → invalid.
  validateReportAttribution(input, failures);

  // ── Association fields ────────────────────────────────────────────────────
  const report = extractField(section.lines, "Report");
  if (report === undefined) {
    failures.push("missing **Report** association field");
  } else if (!samePath(report, input.reportDoc)) {
    failures.push(`**Report** path "${report}" does not match the consumed report "${input.reportDoc}"`);
  }

  const roundField = extractField(section.lines, "Round");
  if (roundField === undefined) {
    failures.push("missing **Round** association field");
  } else if (roundField !== String(input.round)) {
    failures.push(`**Round** "${roundField}" does not match current round ${input.round}`);
  }

  const baseline = extractField(section.lines, "Baseline Hash");
  if (baseline === undefined) {
    failures.push("missing **Baseline Hash** association field");
  } else if (baseline !== input.baselinePlanHash) {
    failures.push("**Baseline Hash** does not match the dispatched baseline");
  }

  // ── Dispositions (shared gate) ────────────────────────────────────────────
  const seen = collectDispositions(section.lines, input.issueIds, failures);

  if (failures.length > 0) {
    return { status: "invalid", failures };
  }

  // ── Sentinel pause takes precedence over ready (owner decision required) ──
  for (const [, entry] of seen) {
    if (PAUSE_DISPOSITIONS.has(entry.disposition)) {
      return {
        status: "paused",
        reason: "new-decision",
        detail: `sentinel disposition "${entry.disposition}" requires owner review`,
      };
    }
  }

  // Structural gate satisfied. Semantics/quality of fixes is explicitly NOT
  // judged here — the next review round decides (K08).
  return {
    status: "ready",
    newPlanHash,
    disposedIssueIds: [...seen.keys()],
  };
}
