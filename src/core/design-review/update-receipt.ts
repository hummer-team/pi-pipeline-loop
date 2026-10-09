/**
 * @module design-review/update-receipt
 * 194 Phase 1 (C2): the STANDALONE design-review update receipt contract.
 *
 * A closed-loop plan revision no longer writes its process receipt into the
 * plan body. It writes an independent receipt document (the exact path is
 * pinned by the C1 descriptor in `update-artifact.ts`) that carries:
 *
 *   - one `## Design Review Update` section,
 *   - the identity rows bound to the consumed review receipt
 *     (`**Pipeline**`, `**Plan**`, `**Review Operation**`, `**Report**`,
 *      `**Round**`, `**Operation**`, `**Baseline Hash**`),
 *   - `### Issue Dispositions` — one table row per consumed-report issue,
 *   - `### Changes Made` — where in the plan each fix actually landed.
 *
 * This module owns the fence-aware markdown mechanics (section spans,
 * `**Field**: value` rows, disposition table rows) so both the standalone
 * receipt and the legacy embedded section (192 behaviour) are parsed by the
 * SAME parser code. `verifiers/design-review-update-verifier.ts` imports from
 * here — never the reverse (no module cycle).
 *
 * All functions are pure: no file reads, no meta writes, no dispatch.
 */

/** Canonical (level-2) heading text of an update receipt section. */
export const UPDATE_RECEIPT_HEADING = "Design Review Update";

/** Level-3 sub-headings of the update receipt section. */
export const ISSUE_DISPOSITIONS_HEADING = "Issue Dispositions";
export const CHANGES_MADE_HEADING = "Changes Made";

/** A `## ` level-2 section span located outside fenced code blocks. */
export interface UpdateSectionSpan {
  startLine: number;
  /** Exclusive end (line index of the next level-2 heading, or the document end). */
  endLine: number;
  lines: string[];
}

/** Parsed disposition row from an update receipt / embedded update section. */
export interface DispositionRow {
  issueId: string;
  disposition: string;
  justification: string;
}

/**
 * Locate top-level `## Design Review Update` sections by exact markdown
 * section boundaries (heading at line start followed by blank/same-line
 * text, terminated by the next line-start `## ` heading or EOF).
 * Fenced code blocks (``` and ~~~) are respected: headings inside fences
 * are NOT section boundaries.
 *
 * 194 Phase 1: MOVED from the update verifier UNCHANGED so the standalone
 * receipt and the legacy embedded body use ONE fence-aware implementation.
 */
export function findUpdateSections(planLines: readonly string[]): UpdateSectionSpan[] {
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

  const headingRe = new RegExp(`^##\\s+${UPDATE_RECEIPT_HEADING}\\s*$`, "i");
  const anyH2Re = /^##\s/;
  const sections: UpdateSectionSpan[] = [];
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

/** True when a line is a fence delimiter (``` or ~~~) toggle. */
function isFenceDelimiter(line: string): boolean {
  return /^\s*(```|~~~)/.test(line);
}

/**
 * Extract a `**Field**: value` association field from section lines.
 * Lines inside fenced code blocks are skipped (``` and ~~~ toggles).
 * Takes the FIRST matching row — the lenient 192 behaviour kept for the
 * LEGACY embedded section only.
 */
export function extractField(lines: readonly string[], field: string): string | undefined {
  const first = extractFieldRows(lines, [field]);
  return first.rows.length > 0 ? first.rows[0]!.value : undefined;
}

/** Result of a strict (duplicate-aware) association-field scan. */
export interface FieldRowsScan {
  /** Every matching `**Field**: value` row value, document order. */
  rows: { value: string }[];
  /** True when the field is declared more than once (canonical or alias). */
  duplicate: boolean;
}

/**
 * 194 C2: scan ALL declarations of a logical field across its accepted label
 * spellings (canonical + aliases, case-insensitive). "重复字段" (duplicate
 * field) is an invalid receipt regardless of whether the values agree — a
 * receipt with two identity rows is ambiguous evidence.
 */
export function extractFieldRows(lines: readonly string[], labels: readonly string[]): FieldRowsScan {
  const patterns = labels.map(
    (label) => new RegExp(`^\\s*\\*\\*${label}\\*\\*\\s*:\\s*(.+?)\\s*$`, "i")
  );
  const rows: { value: string }[] = [];
  let inFence = false;
  for (const line of lines) {
    if (isFenceDelimiter(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    for (const re of patterns) {
      const m = line.match(re);
      if (m) {
        rows.push({ value: m[1]!.trim() });
        break;
      }
    }
  }
  return { rows, duplicate: rows.length > 1 };
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
 *
 * 194 Phase 1: MOVED from the update verifier UNCHANGED (shared by both the
 * legacy embedded section and the standalone receipt).
 */
export function parseDispositionRows(lines: readonly string[]): DispositionRow[] {
  const rows: DispositionRow[] = [];
  let inFence = false;
  const tableRow = /^\s*\|(.*?)\|\s*$/;
  const sepRow = /^\s*\|[\s:| -]+\|\s*$/;

  for (const line of lines) {
    if (isFenceDelimiter(line)) {
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

/**
 * Locate a level-3 sub-block (`### <heading>`) inside an update section span
 * and return its body lines (heading line excluded, terminated by the next
 * `### ` or `## ` heading outside fences). Fence interiors never terminate.
 * Returns undefined when the sub-heading is absent.
 */
export function findSubBlock(
  sectionLines: readonly string[],
  heading: string
): { lines: string[] } | undefined {
  const headingRe = new RegExp(`^###\\s+${heading}\\s*$`, "i");
  const nextHeadingRe = /^##[#\s]/;
  let inFence = false;
  let start = -1;
  for (let i = 0; i < sectionLines.length; i++) {
    const line = sectionLines[i]!;
    if (isFenceDelimiter(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    if (start === -1) {
      if (headingRe.test(line)) start = i + 1;
      continue;
    }
    if (nextHeadingRe.test(line)) {
      return { lines: sectionLines.slice(start, i) };
    }
  }
  return start === -1 ? undefined : { lines: sectionLines.slice(start) };
}

/** Non-empty content lines of a block (whitespace and fences excluded). */
export function contentLines(lines: readonly string[]): string[] {
  let inFence = false;
  const out: string[] = [];
  for (const line of lines) {
    if (isFenceDelimiter(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    if (line.trim() === "") continue;
    out.push(line);
  }
  return out;
}

/**
 * 194 C2: identity labels of a STANDALONE update receipt and their accepted
 * alias spellings. Comparison is case-insensitive via extractFieldRows.
 */
export const RECEIPT_IDENTITY_FIELDS = {
  pipeline: ["Pipeline", "pipelineId"],
  plan: ["Plan", "planDoc"],
  reviewOperation: ["Review Operation", "reviewOperationId"],
  report: ["Report", "reportDoc"],
  round: ["Round"],
  operation: ["Operation"],
  baselineHash: ["Baseline Hash", "baselinePlanHash"],
} as const;

/**
 * A plan-phase location marker inside a `### Changes Made` entry
 * (bilingual: "Phase 3" / "阶段3"). This is the MECHANICAL minimum behind
 * "fixed must state the actual Phase location modified" — semantic fix
 * QUALITY is judged by the next review round, never here.
 */
const PHASE_LOCATION_RE = /(phase\s*\d+|阶段\s*\d+)/i;

/** Any list/table entry mentioning a concrete plan Phase location. */
export function hasPhaseLocationMarker(lines: readonly string[]): boolean {
  return lines.some((line) => PHASE_LOCATION_RE.test(line));
}
