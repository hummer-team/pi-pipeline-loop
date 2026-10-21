/**
 * 210 Phase 6 unit tests — deterministic review change evidence.
 *
 * Covers the plan acceptance list for `buildReviewChangeEvidence` with a FAKE
 * execFn (real git is never touched): review-stage gating, host-without-exec
 * degrade (explicit "unavailable" section — 210 review issue 4), the
 * committed-base path (`.md` filtering, base selection develop vs fix), the
 * working-tree fallback, the per-visit memoization, and the explicit
 * "Evidence unavailable" section on git failure — plus the
 * createPromptInjector integration (default prompt Part 13 on review, absent
 * elsewhere).
 */

import { describe, it, expect, beforeEach, afterEach, afterAll } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildReviewChangeEvidence,
  resetReviewEvidenceCache,
  reviewEvidenceCacheSize,
  REVIEW_EVIDENCE_HEADER,
} from "../../core/review-change-evidence";
import { createPromptInjector } from "../../core/prompt-injector";
import { __setSafeWriteAuditLogOverride } from "../../utils/auditLog";
import { makeTestConfig, makeTestMeta } from "../helpers";
import type { ExecFn, SessionMeta } from "../../types";

// ─── Harness ──────────────────────────────────────────────────────────────────

let seq = 0;
const uniq = (label: string) => `pipe-210-ev-${label}-${Date.now()}-${++seq}`;

interface GitRes {
  stdout: string;
  stderr: string;
  code: number;
}

const ok = (stdout = ""): GitRes => ({ stdout, stderr: "", code: 0 });
const fail = (stderr: string, code = 128): GitRes => ({ stdout: "", stderr, code });

/** Longest-matching-prefix fake git driver with call recording. */
function makeGit(rules: Record<string, GitRes>): { execFn: ExecFn; calls: string[] } {
  const calls: string[] = [];
  const ordered = Object.entries(rules).sort((a, b) => b[0].length - a[0].length);
  const execFn: ExecFn = async (_cmd, args) => {
    const key = args.join(" ");
    calls.push(key);
    for (const [prefix, res] of ordered) {
      if (key.startsWith(prefix)) return res;
    }
    return fail(`unmocked git call: ${key}`);
  };
  return { execFn, calls };
}

/** Write a summary artifact carrying JSON frontmatter with `commit_ids`. */
async function summaryFile(dir: string, name: string, ids: string[]): Promise<string> {
  const abs = join(dir, name);
  const front = `---\n{\n  "stage": "${name}",\n  "commit_ids": [\n${ids.map((i) => `    "${i}"`).join(",\n")}\n  ]\n}\n---\nbody\n`;
  await writeFile(abs, front, "utf-8");
  return abs;
}

async function freshRoot(label: string): Promise<string> {
  const root = join(tmpdir(), `pi-210-evidence-${label}-${Date.now()}-${++seq}`);
  await mkdir(join(root, "summaries"), { recursive: true });
  return root;
}

/** Review-stage meta fixture (unique pipelineId per call — cache/process isolation). */
function reviewMeta(_root: string, overrides: Partial<SessionMeta> = {}): SessionMeta {
  return makeTestMeta({
    pipelineId: uniq("rev"),
    currentStage: "review",
    previousStage: "develop",
    summaries: {},
    ...overrides,
  });
}

beforeEach(() => {
  resetReviewEvidenceCache();
});

afterAll(async () => {
  resetReviewEvidenceCache();
});

// ─── Stage / host gating ──────────────────────────────────────────────────────

describe("buildReviewChangeEvidence gating", () => {
  it("returns null outside the review stage (no git calls, no cache entry)", async () => {
    const { execFn, calls } = makeGit({});
    const config = makeTestConfig();
    for (const stage of ["develop", "fix", "plan", "completed"] as const) {
      const meta = makeTestMeta({ currentStage: stage, pipelineId: uniq(stage) });
      expect(await buildReviewChangeEvidence(config, meta, execFn)).toBeNull();
    }
    expect(calls).toEqual([]);
    expect(reviewEvidenceCacheSize()).toBe(0);
  });

  // 210 review issue 4 (plan Phase 6 task 5 / acceptance #9): a host without
  // `pi.exec` must show an explicit "unavailable" section on the review stage
  // instead of silently deleting the paragraph, and must not shell out or memo.
  it("returns an explicit unavailable section when the host provides no execFn", async () => {
    const meta = reviewMeta("/unused");
    const section = await buildReviewChangeEvidence(makeTestConfig(), meta, undefined);
    expect(section).not.toBeNull();
    expect(section).toContain(REVIEW_EVIDENCE_HEADER);
    expect(section).toContain("Evidence unavailable:");
    expect(section).toContain("pi.exec absent");
    // Not memoized: there was no git read to reuse.
    expect(reviewEvidenceCacheSize()).toBe(0);
  });
});

// ─── Committed-base path ──────────────────────────────────────────────────────

describe("buildReviewChangeEvidence with a develop/fix summary base", () => {
  it("renders the deterministic diff list (*.md filtered out) and commit stats", async () => {
    const root = await freshRoot("base");
    try {
      const config = makeTestConfig({ projectRoot: root });
      const devPath = await summaryFile(join(root, "summaries"), "develop-1.md", ["a1b2c3d", "e4f5a6b"]);
      const meta = reviewMeta(root, {
        summaries: { develop: { path: devPath, hash: "h1", status: "valid" as const } },
      });
      const { execFn, calls } = makeGit({
        "diff --name-status a1b2c3d^..HEAD": ok("M\tsrc/app.ts\nD\tdocs/notes.md\nA\tsrc/new.ts\n"),
        "rev-list a1b2c3d^..HEAD": ok("e4f5a6b\na1b2c3d\n"),
        "show --stat --oneline": ok("e4f5a6b fix thing\n src/app.ts | 2 +-\n a1b2c3d add feature\n src/new.ts | 5 +\n"),
      });

      const section = await buildReviewChangeEvidence(config, meta, execFn);
      expect(section).not.toBeNull();
      // Acceptance marker (the plan checks for `# REVIEW CHANGE EVIDENCE (DETERMINISTIC)`).
      expect(section).toContain("# REVIEW CHANGE EVIDENCE (DETERMINISTIC)");
      expect(section!.startsWith(REVIEW_EVIDENCE_HEADER)).toBe(true);
      expect(section).toContain("**Base**: `a1b2c3d`");
      expect(section).toContain("src/app.ts");
      expect(section).toContain("src/new.ts");
      expect(section).not.toContain("docs/notes.md"); // *.md changes are filtered
      expect(section).toContain("fix thing");
      expect(calls).toContain("diff --name-status a1b2c3d^..HEAD");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("base selection: the HIGHER summary version wins, ties favor fix", async () => {
    const root = await freshRoot("sel");
    try {
      const config = makeTestConfig({ projectRoot: root });
      const devPath = await summaryFile(join(root, "summaries"), "develop-1.md", ["dev1111"]);
      const fixPath = await summaryFile(join(root, "summaries"), "fix-1.md", ["fix2222"]);
      const { execFn, calls } = makeGit({
        "diff --name-status fix2222^..HEAD": ok("M\tsrc/a.ts\n"),
        "rev-list fix2222^..HEAD": ok("fix2222\n"),
        "show --stat --oneline": ok("fix2222 tweak\n"),
      });

      // fix v2 > develop v1 → fix base.
      const meta = reviewMeta(root, {
        summaries: {
          develop: { path: devPath, hash: "h1", status: "valid", version: 1 },
          fix: { path: fixPath, hash: "h2", status: "valid", version: 2 },
        },
      });
      await buildReviewChangeEvidence(config, meta, execFn);
      expect(calls.some((c) => c === "diff --name-status fix2222^..HEAD")).toBe(true);

      // Equal versions → fix still wins (produced later in the loop).
      resetReviewEvidenceCache();
      calls.length = 0;
      const metaTie = reviewMeta(root, {
        summaries: {
          develop: { path: devPath, hash: "h1", status: "valid", version: 2 },
          fix: { path: fixPath, hash: "h2", status: "valid", version: 2 },
        },
      });
      await buildReviewChangeEvidence(config, metaTie, execFn);
      expect(calls.some((c) => c === "diff --name-status dev1111^..HEAD")).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("unreadable or ids-less summary falls back to the working tree (never throws)", async () => {
    const root = await freshRoot("degrade");
    try {
      const config = makeTestConfig({ projectRoot: root });
      const noIds = await summaryFile(join(root, "summaries"), "develop-2.md", []);
      const meta = reviewMeta(root, {
        summaries: {
          // Unreadable path + readable-but-empty ids → no base.
          fix: { path: join(root, "missing.md"), hash: "h", status: "valid" },
          develop: { path: noIds, hash: "h2", status: "valid" },
        },
      });
      const { execFn } = makeGit({
        "diff --name-status HEAD": ok("M\tsrc/a.ts\n"),
        "status --porcelain": ok("?? src/b.ts\n"),
      });
      const section = await buildReviewChangeEvidence(config, meta, execFn);
      expect(section).toContain("**Base**: none");
      expect(section).toContain("src/b.ts");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

// ─── Working-tree fallback ────────────────────────────────────────────────────

describe("buildReviewChangeEvidence working-tree fallback", () => {
  it("no summaries at all → git diff HEAD + git status --porcelain", async () => {
    const root = await freshRoot("wt");
    try {
      const config = makeTestConfig({ projectRoot: root });
      const meta = reviewMeta(root);
      const { execFn, calls } = makeGit({
        "diff --name-status HEAD": ok("M\tsrc/mod.ts\nM\tdocs/readme.md\n"),
        "status --porcelain": ok("?? src/untracked.ts\n M src/mod.ts\n"),
      });
      const section = await buildReviewChangeEvidence(config, meta, execFn);
      expect(section).toContain(REVIEW_EVIDENCE_HEADER);
      expect(section).toContain("**Base**: none");
      expect(section).toContain("src/mod.ts");
      expect(section).toContain("?? src/untracked.ts");
      expect(section).not.toContain("docs/readme.md"); // *.md filtered
      expect(calls).toContain("diff --name-status HEAD");
      expect(calls).toContain("status --porcelain");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("clean tree renders explicit placeholders instead of empty blocks", async () => {
    const root = await freshRoot("clean");
    try {
      const config = makeTestConfig({ projectRoot: root });
      const meta = reviewMeta(root);
      const { execFn } = makeGit({
        "diff --name-status HEAD": ok(""),
        "status --porcelain": ok(""),
      });
      const section = await buildReviewChangeEvidence(config, meta, execFn);
      expect(section).toContain("(no changes)");
      expect(section).toContain("(clean)");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

// ─── Failure degradation & caching ───────────────────────────────────────────

describe("buildReviewChangeEvidence failure and cache semantics", () => {
  it("git failure → explicit Evidence unavailable section (never null, never silent)", async () => {
    const root = await freshRoot("gitfail");
    try {
      const config = makeTestConfig({ projectRoot: root });
      const meta = reviewMeta(root);
      const { execFn } = makeGit({
        "diff --name-status HEAD": fail("fatal: not a git repository (or any of the parent directories): .git"),
        "status --porcelain": fail("fatal: not a git repository"),
      });
      const section = await buildReviewChangeEvidence(config, meta, execFn);
      expect(section).not.toBeNull();
      expect(section!.startsWith(REVIEW_EVIDENCE_HEADER)).toBe(true);
      expect(section).toContain("Evidence unavailable");
      expect(section).toContain("not a git repository");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("execFn throwing → explicit unavailable section", async () => {
    const meta = reviewMeta("/unused");
    const boom: ExecFn = async () => {
      throw new Error("child_process exploded");
    };
    const section = await buildReviewChangeEvidence(makeTestConfig(), meta, boom);
    expect(section).toContain("Evidence unavailable");
    expect(section).toContain("child_process exploded");
  });

  it("memoizes per stage visit — repeated injections never re-shell git", async () => {
    const root = await freshRoot("cache");
    try {
      const config = makeTestConfig({ projectRoot: root });
      const meta = reviewMeta(root, { stageStartTime: 1000 });
      const { execFn, calls } = makeGit({
        "diff --name-status HEAD": ok("M\tsrc/a.ts\n"),
        "status --porcelain": ok(""),
      });

      const first = await buildReviewChangeEvidence(config, meta, execFn);
      const callsAfterFirst = calls.length;
      const second = await buildReviewChangeEvidence(config, meta, execFn);
      expect(second).toBe(first);
      expect(calls.length).toBe(callsAfterFirst);

      // New stage visit (different stageStartTime) → recomputed.
      meta.stageStartTime = 2000;
      await buildReviewChangeEvidence(config, meta, execFn);
      expect(calls.length).toBeGreaterThan(callsAfterFirst);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

// ─── prompt-injector integration ─────────────────────────────────────────────

describe("createPromptInjector integration (Part 13)", () => {
  it("appends the evidence section to the review prompt and omits it elsewhere", async () => {
    const root = await freshRoot("inject");
    try {
      const config = makeTestConfig({ projectRoot: root });
      const { execFn } = makeGit({
        "diff --name-status HEAD": ok("M\tsrc/app.ts\n"),
        "status --porcelain": ok("?? src/new.ts\n"),
      });

      const hook = createPromptInjector(config, { execFn });
      const review = makeTestMeta({ currentStage: "review", previousStage: "develop", pipelineId: uniq("injrev") });
      const result = (await hook.handler({ session: { getMeta: () => review } } as never))!;
      expect(result.systemPrompt!).toContain("# REVIEW CHANGE EVIDENCE (DETERMINISTIC)");
      expect(result.systemPrompt!).toContain("src/app.ts");

      // develop stage with the SAME host → section absent (baseline shape).
      const dev = makeTestMeta({ currentStage: "develop", pipelineId: uniq("injdev") });
      const devResult = (await hook.handler({ session: { getMeta: () => dev } } as never))!;
      expect(devResult.systemPrompt!).not.toContain("REVIEW CHANGE EVIDENCE");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  // 210 review issue 4: on review the paragraph is NEVER dropped — a host
  // without exec capability gets the explicit "unavailable" notice instead.
  it("without deps.execFn the review prompt shows the explicit unavailable section", async () => {
    const config = makeTestConfig();
    const hook = createPromptInjector(config);
    const review = makeTestMeta({ currentStage: "review", pipelineId: uniq("injnoexec") });
    const result = (await hook.handler({ session: { getMeta: () => review } } as never))!;
    expect(result.systemPrompt!).toContain("REVIEW CHANGE EVIDENCE");
    expect(result.systemPrompt!).toContain("Evidence unavailable:");
  });

  // Non-review stages stay byte-for-byte baseline even without exec (the
  // section is stage-gated, so the default-off shape is untouched).
  it("without deps.execFn a non-review prompt stays baseline", async () => {
    const config = makeTestConfig();
    const hook = createPromptInjector(config);
    const dev = makeTestMeta({ currentStage: "develop", pipelineId: uniq("injnodev") });
    const result = (await hook.handler({ session: { getMeta: () => dev } } as never))!;
    expect(result.systemPrompt!).not.toContain("REVIEW CHANGE EVIDENCE");
  });
});

// ─── 210 review issue 8: base commit rev-spec validation ────────────────────

describe("buildReviewChangeEvidence base validation (210 review issue 8)", () => {
  let captured: Array<{ event: string; fields: Record<string, string | boolean>; level?: string }>;

  beforeEach(() => {
    captured = [];
    __setSafeWriteAuditLogOverride(async (event, message, level) => {
      captured.push({ event, fields: (message ?? {}) as Record<string, string | boolean>, level });
    });
  });
  afterEach(() => {
    __setSafeWriteAuditLogOverride(null);
  });

  it("skips an option-injection candidate and uses the first VALID id", async () => {
    const root = await freshRoot("inject1");
    try {
      const config = makeTestConfig({ projectRoot: root });
      const devPath = await summaryFile(join(root, "summaries"), "develop-1.md", ["--output=/tmp/evil", "a1b2c3d"]);
      const meta = reviewMeta(root, {
        summaries: { develop: { path: devPath, hash: "h1", status: "valid" as const } },
      });
      const { execFn, calls } = makeGit({
        "diff --name-status a1b2c3d^..HEAD": ok("M\tsrc/app.ts\n"),
        "rev-list a1b2c3d^..HEAD": ok("a1b2c3d\n"),
        "show --stat --oneline": ok("a1b2c3d work\n"),
      });

      const section = await buildReviewChangeEvidence(config, meta, execFn);
      expect(section).toContain("**Base**: `a1b2c3d`");
      // The hostile token never reaches git argv in any position.
      expect(calls.some((c) => c.includes("--output"))).toBe(false);
      const rejected = captured.filter((e) => e.event === "review_change_evidence_base_rejected");
      expect(rejected).toHaveLength(1);
      expect(rejected[0]!.level).toBe("warn");
      expect(rejected[0]!.fields["rejected"]).toBe("--output=/tmp/evil");
      expect(rejected[0]!.fields["accepted"]).toBe("a1b2c3d");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("falls back to the working tree when EVERY candidate is ill-formed (and audits it)", async () => {
    const root = await freshRoot("inject2");
    try {
      const config = makeTestConfig({ projectRoot: root });
      const devPath = await summaryFile(join(root, "summaries"), "develop-1.md", ["--output=/tmp/evil", "--extcmd=sh"]);
      const meta = reviewMeta(root, {
        summaries: { develop: { path: devPath, hash: "h1", status: "valid" as const } },
      });
      const { execFn, calls } = makeGit({
        "diff --name-status HEAD": ok("M\tsrc/app.ts\n"),
        "status --porcelain": ok("?? src/new.ts\n"),
      });

      const section = await buildReviewChangeEvidence(config, meta, execFn);
      expect(section).toContain("**Base**: none");
      expect(calls).toContain("diff --name-status HEAD");
      expect(calls.some((c) => c.includes("--output") || c.includes("--extcmd"))).toBe(false);
      expect(captured.some((e) => e.event === "review_change_evidence_base_rejected")).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
