/**
 * @module pipeline-prompt-boundary
 * 194 Phase 2 (C4): the plugin-owned boundary for system-prompt injection.
 *
 * Before 194 the injector appended its sections directly onto whatever
 * `ctx.getSystemPrompt()` returned. Whenever the SDK kept a previously
 * composed prompt (append mode, or a child session inheriting the owner's
 * prompt), old plugin instructions survived underneath the new ones: a
 * design-review child could still read "write the report" after the loop
 * had moved on, and every reinjection duplicated stale guidance.
 *
 * This module makes the plugin region explicit and idempotent:
 * - `wrapPluginRuntimeContext` delimits the freshly rendered plugin content
 *   with a paired HTML-comment marker (distinct from SKILL markers).
 * - `stripPluginPromptContent` removes those managed blocks (and, for
 *   prompts composed by older plugin versions, marker-less legacy sections)
 *   from a base prompt BEFORE anything downstream consumes it, so the
 *   injector can re-render the current stage and wrap exactly once.
 *
 * Safety rules (C4):
 * - Fenced code blocks and HTML comments are inert user content: a marker
 *   or heading inside one never starts, closes, or deletes a region.
 * - An unpaired BEGIN/END, a nested BEGIN, or a legacy region whose
 *   boundary cannot be confirmed against a known plugin fingerprint returns
 *   `ambiguous` — the injector must then fail closed (skip injection and
 *   ask the user for a clean session) rather than guess what is plugin text
 *   and what is the user's own same-named section.
 * - Same-named user sections WITHOUT the plugin field fingerprints are
 *   always preserved.
 * - Nothing here mutates the prompt_mode or session history: it only
 *   transforms the base string handed to the injector each turn.
 */

/** Opening marker of the plugin-managed runtime-context region. */
export const PIPELINE_RUNTIME_CONTEXT_BEGIN = "<!-- BEGIN pi-pipeline:runtime-context -->";

/** Closing marker of the plugin-managed runtime-context region. */
export const PIPELINE_RUNTIME_CONTEXT_END = "<!-- END pi-pipeline:runtime-context -->";

/** Separator the injector places between the base prompt and the managed region. */
export const PLUGIN_PROMPT_SEPARATOR = "\n\n---\n\n";

/** Successful strip: every removed region was confirmed; the rest is user content. */
export interface PromptBoundaryClean {
  status: "clean";
  /** Base prompt with all confirmed plugin-owned regions removed. */
  prompt: string;
  /** Number of marker-paired managed blocks removed. */
  removedManagedBlocks: number;
  /** Number of marker-less legacy sections removed. */
  removedLegacySections: number;
}

/**
 * Failed strip: the plugin region cannot be delimited safely. The injector
 * must fail closed — skip injection entirely and ask for a clean session.
 */
export interface PromptBoundaryAmbiguous {
  status: "ambiguous";
  /** Machine-readable conflict class, surfaced to audit and notify. */
  reason:
    | "unclosed_runtime_context_begin"
    | "nested_runtime_context_begin"
    | "stray_runtime_context_end"
    | "legacy_user_section_conflict";
}

export type PromptBoundaryResult = PromptBoundaryClean | PromptBoundaryAmbiguous;

// ─── Line-level inertness tracking (fences + HTML comments) ─────────────────

const FENCE_OPEN_RE = /^ {0,3}(`{3,}|~{3,})/;
const COMMENT_START = "<!--";
const COMMENT_END = "-->";

/** A fence line is the closer when it is only fence characters of the same kind. */
function isFenceCloseLine(line: string, fenceChar: string): boolean {
  const trimmed = line.trim();
  return trimmed.length >= 3 && [...trimmed].every((c) => c === fenceChar);
}

/**
 * Classify each line as active (real prompt content) or inert (inside a
 * fenced code block or an HTML comment). State transitions are evaluated
 * AFTER the line's own classification, so a self-contained marker comment
 * on one line counts as active content that can be matched.
 */
function computeActiveLines(lines: string[]): boolean[] {
  const active: boolean[] = [];
  let inFence = false;
  let fenceChar = "";
  let inComment = false;

  for (const line of lines) {
    active.push(!inFence && !inComment);

    if (inFence) {
      if (isFenceCloseLine(line, fenceChar)) inFence = false;
      continue;
    }
    const fm = FENCE_OPEN_RE.exec(line);
    if (fm) {
      inFence = true;
      fenceChar = fm[1][0];
      continue;
    }
    if (inComment) {
      const close = line.indexOf(COMMENT_END);
      if (close !== -1) {
        inComment = false;
        // A new comment may re-open later on the same line.
        const reopen = line.indexOf(COMMENT_START, close + COMMENT_END.length);
        if (reopen !== -1 && line.indexOf(COMMENT_END, reopen + COMMENT_START.length) === -1) {
          inComment = true;
        }
      }
      continue;
    }
    // Outside a comment: consume paired `<!-- ... -->` spans; an unterminated
    // `<!--` leaves the comment open for subsequent lines.
    let cursor = 0;
    for (;;) {
      const open = line.indexOf(COMMENT_START, cursor);
      if (open === -1) break;
      const close = line.indexOf(COMMENT_END, open + COMMENT_START.length);
      if (close === -1) {
        inComment = true;
        break;
      }
      cursor = close + COMMENT_END.length;
    }
  }
  return active;
}

// ─── Managed (marker-paired) block handling ─────────────────────────────────

interface ManagedScanResult {
  /** Null reason means the scan is clean. */
  reason: PromptBoundaryAmbiguous["reason"] | null;
  keptLines: string[];
  removedBlocks: number;
}

/**
 * Remove every paired BEGIN…END block. BEGIN without END, END without BEGIN,
 * or a nested BEGIN fail closed — silently guessing a boundary could delete
 * user content or leave stale instructions behind.
 */
function stripManagedBlocks(lines: string[]): ManagedScanResult {
  const active = computeActiveLines(lines);
  const kept = new Array<boolean>(lines.length).fill(true);
  let depth = 0;
  let start = -1;
  let removedBlocks = 0;

  for (let i = 0; i < lines.length; i++) {
    if (!active[i]) continue;
    const hasBegin = lines[i].includes(PIPELINE_RUNTIME_CONTEXT_BEGIN);
    const hasEnd = lines[i].includes(PIPELINE_RUNTIME_CONTEXT_END);

    if (hasBegin) {
      if (depth > 0) {
        return { reason: "nested_runtime_context_begin", keptLines: lines, removedBlocks: 0 };
      }
      depth = 1;
      start = i;
    }
    if (hasEnd) {
      if (depth === 0) {
        return { reason: "stray_runtime_context_end", keptLines: lines, removedBlocks: 0 };
      }
      for (let j = start; j <= i; j++) kept[j] = false;
      removedBlocks++;
      depth = 0;
      start = -1;
    }
  }

  if (depth > 0) {
    return { reason: "unclosed_runtime_context_begin", keptLines: lines, removedBlocks: 0 };
  }

  const keptLines = lines.filter((_, idx) => kept[idx]);
  return { reason: null, keptLines, removedBlocks };
}

/**
 * After a block that was appended as `base + separator + block` is removed,
 * the separator's `---` line dangles at the tail. Remove it (blank lines
 * included) so the surviving base is exactly what the user/SDK owns.
 */
function trimDanglingTail(text: string): string {
  let result = text.replace(/\s+$/, "");
  // Our separator always leaves a BLANK line before the trailing `---`; a
  // setext heading (`Title\n---`) has none and must survive untouched.
  for (;;) {
    const m = /\n\n+---\s*$/.exec(result);
    if (!m) break;
    result = result.slice(0, m.index).replace(/\s+$/, "");
  }
  return result;
}

// ─── Legacy (marker-less) plugin section handling ────────────────────────────

/**
 * Known plugin sections written by pre-194 injector versions. A heading
 * alone is NOT enough to delete a section (users may legitimately own a
 * `# Pipeline Status` of their own): the body must also carry the exact
 * plugin field lines below, confirmed line-anchored where the plugin emits
 * the field as a list item.
 */
interface LegacySectionSignature {
  /** Matches the trimmed heading line of a plugin section. */
  readonly heading: RegExp;
  /**
   * Field fingerprints required in the section body. A leading `^` anchors
   * the fingerprint to a line start (after trimming): the plugin emits its
   * fields as list items, and an anchored match means a user sentence that
   * merely MENTIONS `- Pipeline ID:` can never confirm removal.
   */
  readonly allFingerprints: readonly string[];
  /** At least one of these (same `^` anchoring) must appear in the body. */
  readonly anyFingerprints?: readonly string[];
}

const LEGACY_PLUGIN_SECTIONS: readonly LegacySectionSignature[] = [
  { heading: /^# PIPELINE STATE$/, allFingerprints: ["^- State:"] },
  { heading: /^# Pipeline Status$/, allFingerprints: ["^- Pipeline ID:"] },
  { heading: /^# LOOP ENGINEERING STATUS$/, allFingerprints: ["^- Current Step:"] },
  { heading: /^# STAGE WRITE SCOPE$/, allFingerprints: ["^- Write Scope:"] },
  {
    heading: /^# DESIGN-REVIEW DYNAMIC CONTEXT$/,
    allFingerprints: [],
    anyFingerprints: ["^- Operation:", "^- Decision:"],
  },
  { heading: /^# SMART CONFIRM PROTOCOL\b/, allFingerprints: ["stage_advance"] },
];

/** One fingerprint against one body: line-anchored or plain substring. */
function fingerprintMatches(body: string, fingerprint: string): boolean {
  if (fingerprint.startsWith("^")) {
    const needle = fingerprint.slice(1);
    return body.split("\n").some((line) => line.trimStart().startsWith(needle));
  }
  return body.includes(fingerprint);
}

const TOP_LEVEL_HEADING_RE = /^#(?!#)\s/;

type HeadingClass = "plugin" | "user" | "foreign";

interface HeadingHit {
  /** Line index of the heading. */
  idx: number;
  /** Trimmed heading text. */
  text: string;
  /** Body text from this heading up to the next heading (exclusive). */
  body: string;
}

function classifyHeading(hit: HeadingHit): HeadingClass {
  const signature = LEGACY_PLUGIN_SECTIONS.find((s) => s.heading.test(hit.text));
  if (!signature) return "foreign";
  const allOk = signature.allFingerprints.every((fp) => fingerprintMatches(hit.body, fp));
  const anyOk =
    signature.anyFingerprints === undefined ||
    signature.anyFingerprints.length === 0 ||
    signature.anyFingerprints.some((fp) => fingerprintMatches(hit.body, fp));
  // Known heading without the plugin fields = a user section of the same name.
  return allOk && anyOk ? "plugin" : "user";
}

interface LegacyScanResult {
  reason: PromptBoundaryAmbiguous["reason"] | null;
  prompt: string;
  removedSections: number;
}

/**
 * Remove a trailing run of confirmed legacy plugin sections. The plugin has
 * always appended its sections to the very end of the prompt, so a legacy
 * region is the suffix starting at the FIRST confirmed plugin heading — and
 * only when every heading after it is confirmed too. A foreign or
 * same-named-user heading inside that range makes the boundary unprovable:
 * fail closed.
 */
function stripLegacySections(lines: string[]): LegacyScanResult {
  const active = computeActiveLines(lines);
  const headingIdxs: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (active[i] && TOP_LEVEL_HEADING_RE.test(lines[i])) headingIdxs.push(i);
  }

  const hits: HeadingHit[] = headingIdxs.map((idx, order) => {
    const next = order + 1 < headingIdxs.length ? headingIdxs[order + 1] : lines.length;
    return {
      idx,
      text: lines[idx].trim(),
      body: lines.slice(idx + 1, next).join("\n"),
    };
  });

  const firstPlugin = hits.findIndex((h) => classifyHeading(h) === "plugin");
  if (firstPlugin === -1) {
    // Nothing confirmed: leave every heading (user sections included) intact.
    return { reason: null, prompt: lines.join("\n"), removedSections: 0 };
  }

  for (let k = firstPlugin; k < hits.length; k++) {
    if (classifyHeading(hits[k]) !== "plugin") {
      return { reason: "legacy_user_section_conflict", prompt: "", removedSections: 0 };
    }
  }

  const startLine = hits[firstPlugin].idx;
  const kept = lines.slice(0, startLine);
  const remaining = trimDanglingTail(kept.join("\n"));
  return { reason: null, prompt: remaining, removedSections: hits.length - firstPlugin };
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Remove all plugin-owned content (marker-paired blocks first, then any
 * confirmed marker-less legacy suffix) from a base system prompt.
 *
 * @param prompt - Raw base prompt from `ctx.getSystemPrompt()` (may be empty)
 * @returns `clean` with the stripped prompt and removal counts, or
 *   `ambiguous` when the plugin boundary cannot be proven (fail closed)
 */
export function stripPluginPromptContent(prompt: string): PromptBoundaryResult {
  if (prompt.length === 0) {
    return { status: "clean", prompt: "", removedManagedBlocks: 0, removedLegacySections: 0 };
  }

  const managed = stripManagedBlocks(prompt.split("\n"));
  if (managed.reason !== null) {
    return { status: "ambiguous", reason: managed.reason };
  }

  const afterManaged =
    managed.removedBlocks > 0 ? trimDanglingTail(managed.keptLines.join("\n")) : managed.keptLines.join("\n");

  const legacy = stripLegacySections(afterManaged.split("\n"));
  if (legacy.reason !== null) {
    return { status: "ambiguous", reason: legacy.reason };
  }

  return {
    status: "clean",
    prompt: legacy.prompt,
    removedManagedBlocks: managed.removedBlocks,
    removedLegacySections: legacy.removedSections,
  };
}

/**
 * Wrap freshly rendered plugin content in the paired managed markers.
 * Callers must append the result to the base prompt with
 * {@link PLUGIN_PROMPT_SEPARATOR} and must only ever wrap the FINAL plugin
 * content once — stripping before rendering keeps the prompt nested-free.
 *
 * @param content - Fully assembled plugin prompt (all sections joined)
 * @returns The marker-delimited plugin region
 */
export function wrapPluginRuntimeContext(content: string): string {
  return `${PIPELINE_RUNTIME_CONTEXT_BEGIN}\n${content}\n${PIPELINE_RUNTIME_CONTEXT_END}`;
}
