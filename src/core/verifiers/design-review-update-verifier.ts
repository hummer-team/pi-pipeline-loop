/**
 * @module verifiers/design-review-update-verifier
 * 192 Phase 2 (K08, F03): structural validation of an authorized plan update.
 *
 * Pure read-only evaluator over provided snapshots (plan content + consumed
 * report attribution). It NEVER advances stages, writes meta, or dispatches;
 * the domain coordinator consumes the verdict.
 *
 * Contract enforced (all structural failures ⇒ invalid, K08):
 * - The CURRENT `## Design Review Update` section is identified by its
 *   association fields: Report path (the consumed review report), Round,
 *   Operation (= the CURRENT UPDATE operationId), Baseline Hash
 *   (= the baseline plan hash). Old-round sections (different Operation)
 *   are ignored; a second section claiming the CURRENT operation is a
 *   duplicate → invalid.
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
 */

import { createHash } from "node:crypto";
import * as path from "node:path";

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
}

export type DesignReviewUpdateVerdict =
  | {
      status: "ready";
      newPlanHash: string;
      /** Dispositions found (for audit) */
      disposedIssueIds: string[];
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

/**
 * Locate top-level `## Design Review Update` sections by exact markdown
 * section boundaries (heading at line start followed by blank/same-line
 * text, terminated by the next line-start `## ` heading or EOF).
 * Fenced code blocks (``` and ~~~) are respected: headings inside fences
 * are NOT section boundaries.
 */
interface SectionSpan {
  startLine: number;
  endLine: number; // exclusive
  lines: string[];
}

function findUpdateSections(planLines: readonly string[]): SectionSpan[] {
  // Pre-compute fence membership: fenceAt[i] === true means line i is INSIDE
  // a fenced block (``` or ~~~). Fence markers themselves are not "inside".
  const fenceAt: boolean[] = [];
  let inFence = false;
  let fenceMarker: string | null = null;
  for (const line of planLines) {
    const m = line.match(/^\s*(```|~~~)/);
    if (m) {
      if (!inFence) {
        inFence = true;
        fenceMarker = m[1]!;
        fenceAt.push(false);
      } else if (m[1] === fenceMarker) {
        inFence = false;
        fenceMarker = null;
        fenceAt.push(false);
      } else {
        // Different fence marker inside a fence: content, keep inside
        fenceAt.push(true);
      }
      continue;
    }
    fenceAt.push(inFence);
  }

  const headingRe = /^##\s+Design Review Update\s*$/i;
  const anyH2Re = /^##\s/;
  const sections: SectionSpan[] = [];
  for (let i = 0; i < planLines.length; i++) {
    if (fenceAt[i]) continue;
    if (!headingRe.test(planLines[i]!)) continue;
    // Section runs until the NEXT top-level `## ` heading (any h2, including
    // a repeated update heading) or EOF. Fence interiors never terminate.
    let j = i + 1;
    for (; j < planLines.length; j++) {
      if (!fenceAt[j] && anyH2Re.test(planLines[j]!)) break;
    }
    sections.push({ startLine: i, endLine: j, lines: planLines.slice(i, j) });
    i = j - 1;
  }
  return sections;
}

/**
 * Extract a `**Field**: value` association field from section lines.
 * Lines inside fenced code blocks are skipped (``` and ~~~ toggles).
 */
function extractField(lines: readonly string[], field: string): string | undefined {
  const re = new RegExp(`^\\s*\\*\\*${field}\\*\\*\\s*:\\s*(.+?)\\s*$`, "i");
  let inFence = false;
  for (const line of lines) {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const m = line.match(re);
    if (m) return m[1]!.trim();
  }
  return undefined;
}

/**
 * Parsed disposition row from the current update section.
 */
interface DispositionRow {
  issueId: string;
  disposition: string;
  justification: string;
}

/**
 * Parse disposition rows from the section. The ONLY accepted shape is the
 * markdown table row documented by the update template:
 *   `| <issueId> | <issue summary> | <disposition> | <justification> |`
 * Header and separator rows are skipped. Lines inside fenced code blocks
 * (the template's own format example) are ignored. No other "nearby text"
 * heuristic is applied — a row that cannot be parsed contributes NOTHING,
 * so its issue then fails the "exactly one disposition" gate (F03 root
 * cause: reason-prefix leniency removed).
 */
function parseDispositionRows(lines: readonly string[]): DispositionRow[] {
  const rows: DispositionRow[] = [];
  let inFence = false;
  const tableRow = /^\s*\|(.*?)\|\s*$/;
  const sepRow = /^\s*\|[\s:| -]+\|\s*$/;

  for (const line of lines) {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;

    const m = line.match(tableRow);
    if (!m || sepRow.test(line)) continue;
    const cells = m[1]!.split("|").map((c) => c.trim());
    if (cells.length < 4) continue;
    const first = cells[0]!.toLowerCase();
    // Header rows: "#" / "id" / "issue" label
    if (first === "#" || first === "id" || first === "issue") continue;
    rows.push({
      issueId: cells[0]!,
      disposition: cells[2]!.toLowerCase(),
      justification: cells[3]!,
    });
  }
  return rows;
}

function samePath(a: string, b: string): boolean {
  try {
    return path.resolve(a) === path.resolve(b);
  } catch {
    return false;
  }
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

  const lines = input.planContent.split("\n");
  const sections = findUpdateSections(lines);
  if (sections.length === 0) {
    return {
      status: "invalid",
      failures: ["missing `## Design Review Update` section (exact heading required)"],
    };
  }

  // Identify CURRENT sections by their Operation association field.
  const current: SectionSpan[] = [];
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
  if (input.reportContent !== undefined) {
    if (input.reportHash !== "") {
      const snapshotHash = computePlanHash(input.reportContent);
      if (snapshotHash !== input.reportHash) {
        failures.push(
          "consumed report snapshot no longer matches the receipt reportHash (report was replaced after consumption)",
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
          `consumed report snapshot does not declare its review operation (expected "${input.reviewOperationId}")`,
        );
      } else if (declared !== input.reviewOperationId) {
        failures.push(
          `consumed report belongs to review operation "${declared}", not the consumed review operation "${input.reviewOperationId}"`,
        );
      }
    } else if (input.reviewOperationId === "") {
      // Empty review operation id cannot match anything: fail closed.
      failures.push("consumed review operation id is empty — report ownership cannot be established");
    }
  }

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

  // ── Dispositions ──────────────────────────────────────────────────────────
  const rows = parseDispositionRows(section.lines);
  if (rows.length === 0) {
    failures.push("no disposition rows found in the current update section");
  }

  const expected = new Set(input.issueIds);
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
