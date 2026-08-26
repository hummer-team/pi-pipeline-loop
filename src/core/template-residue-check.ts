/**
 * @module template-residue-check
 *
 * Rule-based detection of unresolved template placeholders (Template-TODO marker)
 * in .pi/skills/{stage}/SKILL.md and .pi/agents/*.md files.
 *
 * Pure fs + substring matching — no LLM involvement.
 *
 * Provides:
 * - checkTemplateResidues — scan for Template-TODO markers
 * - computeResidueFingerprint — stable sha256 over the scan target set
 * - readResidueGateStatus / writeResidueGateStatus / clearResidueGateStatus
 *   — persistent gate state so pipeline-start can short-circuit repeated checks
 *
 * All file-system failures are fail-open (never block the pipeline).
 *
 * Phase 5/6 of 147_Skill_v2 plan.
 */

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { CONFIG_DIR_NAME } from "../constants";
import { computeStringHash } from "../utils/hash";
import { safeWriteAuditLog } from "../utils/auditLog";

// ─── Types ────────────────────────────────────────────────────────────────────

/** A single line that still carries the Template-TODO placeholder. */
export interface ResidueHit {
  /** Relative path from project root (e.g. `.pi/skills/develop/SKILL.md`) */
  file: string;
  /** 1-indexed line number */
  line: number;
  /** Trimmed line content (the full line text, truncated for readability) */
  marker: string;
}

/** Result of a template-residue scan. */
export interface ResidueCheckResult {
  /** Number of files scanned */
  scanned: number;
  /** Lines that still contain Template-TODO markers */
  hits: ResidueHit[];
  /** True when no hits were found (clean) */
  clean: boolean;
}

/** Persistent gate state written by `pipeline-init 2` / `pipeline-start`. */
export interface ResidueGateStatus {
  /** Whether the last check passed (no residues) */
  passed: boolean;
  /** ISO timestamp of the last check */
  checkedAt: string;
  /** Fingerprint of the scan target set at the time of check */
  fingerprint: string;
}

// ─── Constants ────────────────────────────────────────────────────────────────

/** Reserved placeholder marker that indicates an unfilled template slot. */
const RESIDUE_MARKER = "Template-TODO";

/** Default audit directory (relative to project root) when none is configured. */
const DEFAULT_AUDIT_DIR = ".pi/audit";

/** Name of the gate status file inside the audit directory. */
const GATE_STATUS_FILE = "template-residue-check.json";

// ─── Scan target resolution ───────────────────────────────────────────────────

/**
 * Returns the absolute paths of all files that should be scanned for
 * Template-TODO residues, relative to `projectRoot`.
 *
 * Scan set:
 * - .pi/skills/{stage}/SKILL.md (covers design, plan, develop, review, fix)
 * - .pi/agents/*.md (all agent templates)
 *
 * .pi/references/sop.md and pipeline_loop.json are NOT scanned (sop.md is
 * a pure process declaration after Phase 4 generalization; no placeholders).
 */
function resolveScanTargets(projectRoot: string): string[] {
  try {
    const piDir = path.join(projectRoot, CONFIG_DIR_NAME);
    if (!fs.existsSync(piDir)) return [];

    const targets: string[] = [];

    // skills: .pi/skills/*/SKILL.md
    // Each directory is independently wrapped so a permission/concurrent-delete
    // error on one does not prevent scanning the other (fail-open per directory).
    const skillsDir = path.join(piDir, "skills");
    try {
      if (fs.existsSync(skillsDir) && fs.statSync(skillsDir).isDirectory()) {
        for (const entry of fs.readdirSync(skillsDir, { withFileTypes: true })) {
          if (!entry.isDirectory()) continue;
          const skillFile = path.join(skillsDir, entry.name, "SKILL.md");
          if (fs.existsSync(skillFile)) targets.push(skillFile);
        }
      }
    } catch {
      // skills dir enumeration failed — skip (fail-open)
    }

    // agents: .pi/agents/*.md
    try {
      const agentsDir = path.join(piDir, "agents");
      if (fs.existsSync(agentsDir) && fs.statSync(agentsDir).isDirectory()) {
        for (const entry of fs.readdirSync(agentsDir, { withFileTypes: true })) {
          if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
          targets.push(path.join(agentsDir, entry.name));
        }
      }
    } catch {
      // agents dir enumeration failed — skip (fail-open)
    }

    return targets;
  } catch {
    // Outer safety net: any unexpected failure → empty set (fail-open)
    return [];
  }
}

// ─── checkTemplateResidues ────────────────────────────────────────────────────

/**
 * Scans the project's `.pi/` skill and agent templates for unresolved
 * `Template-TODO` placeholders.
 *
 * Fail-open: if the `.pi/` directory does not exist, returns `{ scanned: 0, hits: [], clean: true }`.
 */
export function checkTemplateResidues(projectRoot: string): ResidueCheckResult {
  const targets = resolveScanTargets(projectRoot);
  if (targets.length === 0) {
    return { scanned: 0, hits: [], clean: true };
  }

  const hits: ResidueHit[] = [];
  for (const absPath of targets) {
    let content: string;
    try {
      content = fs.readFileSync(absPath, "utf-8");
    } catch {
      // Read failure — skip this file (fail-open)
      continue;
    }
    const relPath = path.relative(projectRoot, absPath);
    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].includes(RESIDUE_MARKER)) {
        hits.push({
          file: relPath,
          line: i + 1,
          marker: lines[i].trim().slice(0, 200),
        });
      }
    }
  }

  return { scanned: targets.length, hits, clean: hits.length === 0 };
}

// ─── computeResidueFingerprint ────────────────────────────────────────────────

/**
 * Computes a stable fingerprint over the scan target set:
 * `sha256(sort(relPath + "\0" + content).join("\n"))`.
 *
 * Returns a fixed empty-set fingerprint when no scan targets exist, so that
 * missing `.pi/` produces a consistent (but distinct) fingerprint.
 *
 * Fail-open: unreadable files are skipped; the fingerprint reflects whatever
 * could be read.
 */
export function computeResidueFingerprint(projectRoot: string): string {
  const targets = resolveScanTargets(projectRoot);
  if (targets.length === 0) {
    // Stable empty-set fingerprint — distinguishable from any real fingerprint
    return computeStringHash("__residue_empty_set__");
  }

  const entries: string[] = [];
  for (const absPath of targets) {
    let content: string;
    try {
      content = fs.readFileSync(absPath, "utf-8");
    } catch {
      continue;
    }
    const relPath = path.relative(projectRoot, absPath);
    entries.push(`${relPath}\0${content}`);
  }
  entries.sort();
  return computeStringHash(entries.join("\n"));
}

// ─── Gate status file R/W ─────────────────────────────────────────────────────

/**
 * Resolves the absolute path to the gate status file.
 */
function resolveGateStatusPath(projectRoot: string, auditDir?: string): string {
  const auditRel = auditDir ?? DEFAULT_AUDIT_DIR;
  const auditAbs = path.isAbsolute(auditRel)
    ? auditRel
    : path.join(projectRoot, auditRel);
  return path.join(auditAbs, GATE_STATUS_FILE);
}

/**
 * Reads the persisted gate status.
 * Returns `undefined` on any failure (missing file, parse error) — fail-open.
 */
export function readResidueGateStatus(
  projectRoot: string,
  auditDir?: string,
): ResidueGateStatus | undefined {
  const statusPath = resolveGateStatusPath(projectRoot, auditDir);
  try {
    const raw = fs.readFileSync(statusPath, "utf-8");
    const parsed = JSON.parse(raw);
    if (
      parsed &&
      typeof parsed === "object" &&
      typeof parsed.passed === "boolean" &&
      typeof parsed.checkedAt === "string" &&
      typeof parsed.fingerprint === "string"
    ) {
      return parsed as ResidueGateStatus;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * Persists the gate status to disk.
 * Creates the audit directory if missing. Failure is logged + swallowed (fail-open).
 */
export function writeResidueGateStatus(
  projectRoot: string,
  status: ResidueGateStatus,
  auditDir?: string,
): void {
  const statusPath = resolveGateStatusPath(projectRoot, auditDir);
  try {
    fs.mkdirSync(path.dirname(statusPath), { recursive: true });
    fs.writeFileSync(statusPath, JSON.stringify(status, null, 2), "utf-8");
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    // Fire-and-forget audit — best-effort
    safeWriteAuditLog("template_residue_gate_write_error", { error: errMsg }, "warn").catch(() => {});
  }
}

/**
 * Removes the gate status file. No-op when missing. Failure is swallowed.
 */
export function clearResidueGateStatus(
  projectRoot: string,
  auditDir?: string,
): void {
  const statusPath = resolveGateStatusPath(projectRoot, auditDir);
  try {
    fs.rmSync(statusPath, { force: true });
  } catch {
    // Swallow — fail-open
  }
}
