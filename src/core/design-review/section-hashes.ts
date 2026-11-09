/**
 * @module design-review/section-hashes
 * PURE section-hash baseline + diff for the mechanical
 * declared-scope check.
 *
 * Coverage (B15): EVERY top-level `## ` section is hashed with the SAME
 * policy — Phase sections are keyed `phase:<n>` (any heading whose text
 * matches `phase <digits>` / the localized spelling), every other section is keyed
 * `section:<title>` (duplicates get `#2`, `#3`… preserving first-seen order).
 * Non-Phase sections (acceptance, risks, user confirmation, …) are FIRST-CLASS:
 * out-of-scope edits cannot hide in them.
 *
 * Pure over strings: no I/O, no meta, no clock.
 */

import { createHash } from "node:crypto";

/** sha256 hex of the trimmed section body (title line excluded). */
function bodyHash(body: string): string {
  return createHash("sha256").update(body.trim(), "utf-8").digest("hex");
}

/** True when a top-level heading names a plan PHASE (kind/duration fixes). */
function phaseNumberFromHeading(text: string): number | null {
  const m = /^\s*(?:phase|阶段)\s*[:：\-—]?\s*(\d+)\b/i.exec(text);
  return m && m[1] !== undefined ? Number(m[1]) : null;
}

/**
 * Hash EVERY top-level `## <heading>` section of the plan. Output order
 * follows the document's first-seen order; repeated headings keep stable
 * `{key}#k` suffixes. Level-1 (`#`) and level-3 (`###`) headings belong to
 * their enclosing `##` section.
 */
export function computeSectionHashes(planContent: string): Record<string, string> {
  const sections: Record<string, string> = {};
  const counts: Record<string, number> = {};
  const lines = planContent.split("\n");
  let key: string | null = null;
  let body: string[] = [];
  const flush = (): void => {
    if (key !== null) {
      sections[key] = bodyHash(body.join("\n"));
      if (body.length > 0 && body[body.length - 1] === "") body.pop();
    }
  };
  for (const line of lines) {
    const heading = /^##(?:\s|$)(.*)$/.exec(line);
    if (heading && heading[1] !== undefined) {
      flush();
      const title = heading[1].trim();
      const phase = phaseNumberFromHeading(title);
      const base = phase !== null ? `phase:${String(phase)}` : `section:${title}`;
      const used = (counts[base] ?? 0) + 1;
      counts[base] = used;
      key = used === 1 ? base : `${base}#${String(used)}`;
      body = [];
    } else if (key !== null) {
      body.push(line);
    }
  }
  flush();
  return sections;
}

/** Result of comparing the CURRENT sections against the BASELINE. */
export interface SectionHashDiff {
  /** Baseline sections whose body hash changed (baseline order). */
  changed: string[];
  /** Sections added since the baseline (current order). */
  added: string[];
  /** Baseline sections removed since the baseline (baseline order). */
  removed: string[];
}

/**
 * Mechanical diff `baseline → current`. Hash equality means "no meaningful
 * byte change"; both added and removed sections count as scope events.
 */
export function diffSectionHashes(
  baseline: Record<string, string>,
  current: Record<string, string>,
): SectionHashDiff {
  const changed: string[] = [];
  const added: string[] = [];
  const removed: string[] = [];
  for (const key of Object.keys(baseline)) {
    if (!(key in current)) {
      removed.push(key);
    } else if (current[key] !== baseline[key]) {
      changed.push(key);
    }
  }
  for (const key of Object.keys(current)) {
    if (!(key in baseline)) added.push(key);
  }
  return { changed, added, removed };
}
