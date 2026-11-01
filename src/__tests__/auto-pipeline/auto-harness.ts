/**
 * 219 Phase 5 test harness: a REAL project-shaped auto job.
 *
 * Not a test file — imported by the Phase 5 suites. Builds a temp project with
 * a resolved `PipelineConfig` (so the overlay has meaningful pre-values), a
 * `docs/jobs/alpha_loop.yaml`, a running sidecar and the process-level lock.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";
import type { PipelineConfig, PipelineJsonConfig, SessionMeta } from "../../types";
import { resolvePipelineConfig } from "../../core/json-config-loader";
import { acquireJobLock } from "../../core/auto-pipeline/config-overlay";
import {
  createJobState,
  readJobState,
  writeJobState,
  type AutoJobState,
} from "../../core/auto-pipeline/job-state";
import { hashJobBytes, parseAutoJob, type AutoJobConfig } from "../../core/auto-pipeline/job-schema";

const SRC_ROOT = path.resolve(__dirname, "..", "..", "..");
const TEMPLATE_JSON: PipelineJsonConfig = JSON.parse(
  fs.readFileSync(path.join(SRC_ROOT, "src", "template", "pipeline_loop.json"), "utf8"),
) as PipelineJsonConfig;

export const HARNESS_JOB_ID = "alpha_loop";
export const HARNESS_DOCS = ["docs/design/a.md", "docs/design/b.md"];

export const HARNESS_JOB_YAML = [
  "version: 1",
  "enabled: true",
  // 220 C-2: the harness config strips every `verify` block (transaction tests
  // never verify), and the `assisted` tier precondition requires the
  // design-review verify stage — `rule` is the tier that does not.
  "tier: rule",
  "docs:",
  "  list:",
  `    - doc: ${HARNESS_DOCS[0]}`,
  `    - doc: ${HARNESS_DOCS[1]}`,
  "designReview:",
  "  maxRounds: 3",
  "reviewFix:",
  "  maxRounds: 4",
  "  maxLoopsPerStage: 2",
  "stopConditions:",
  "  maxTotalLoops: 5",
  "  maxTotalFreezes: 2",
    "freezePolicy:",
  "  onFreeze: resume",
  "  maxAutoResumes: 2",
  "chain:",
  "  newSession: true",
  "  onSessionFail: same-session",
].join("\n");

export interface AutoHarness {
  root: string;
  projectRoot: string;
  job: AutoJobConfig;
  jobHash: string;
  config: PipelineConfig;
  state: () => AutoJobState;
  install: (opts?: { counters?: Partial<AutoJobState["counters"]>; status?: AutoJobState["status"] }) => Promise<AutoJobState>;
  writeDoc: (rel: string) => void;
  /** Corrupt the job YAML (a user edit) without touching the sidecar. */
  writeBrokenJob: () => void;
  dispose: () => void;
}

export function createAutoHarness(): AutoHarness {
  const root = fs.mkdtempSync(path.join(tmpdir(), "pi-219-p5-"));

  const jobPath = path.join(root, "docs", "jobs", `${HARNESS_JOB_ID}.yaml`);
  fs.mkdirSync(path.dirname(jobPath), { recursive: true });
  fs.writeFileSync(jobPath, HARNESS_JOB_YAML, "utf8");

  const json: PipelineJsonConfig = { ...structuredClone(TEMPLATE_JSON), projectRoot: root };
  const jsonPath = path.join(root, ".pi", "pipeline_loop.json");
  fs.mkdirSync(path.dirname(jsonPath), { recursive: true });
  fs.writeFileSync(jsonPath, JSON.stringify(json, null, 2), "utf8");
  const resolved = resolvePipelineConfig(json);
  resolved.configSourcePath = jsonPath;
  // Verify-file preflight is irrelevant for the transaction tests.
  for (const stage of Object.values(resolved.stages)) {
    if (stage) delete (stage as { verify?: unknown }).verify;
  }

  const parsed = parseAutoJob(HARNESS_JOB_YAML, `docs/jobs/${HARNESS_JOB_ID}.yaml`);
  if (!parsed.ok) throw new Error(`harness job invalid: ${parsed.errors.join("; ")}`);

  const harness: AutoHarness = {
    root,
    projectRoot: root,
    job: parsed.job,
    jobHash: parsed.hash,
    config: resolved,
    state: () => readJobState(root, HARNESS_JOB_ID) as AutoJobState,
    install: async (opts) => {
      const base = createJobState({
        jobId: HARNESS_JOB_ID,
        jobPath: `docs/jobs/${HARNESS_JOB_ID}.yaml`,
        jobHash: hashJobBytes(HARNESS_JOB_YAML),
        docs: HARNESS_DOCS.map((doc) => ({ doc })),
      });
      // Production shape: the doc at `docIndex` is the one currently running.
      base.docs[0]!.status = "running";
      const state: AutoJobState = {
        ...base,
        status: opts?.status ?? "running",
        counters: { ...base.counters, ...(opts?.counters ?? {}) },
      };
      await writeJobState(root, state);
      const lock = acquireJobLock({ projectRoot: root, jobId: HARNESS_JOB_ID });
      if (!lock.ok) throw new Error("harness lock acquire failed");
      return state;
    },
    dispose: () => fs.rmSync(root, { recursive: true, force: true }),
    writeDoc: (rel: string) => {
      const abs = path.join(root, rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, `# ${rel}\n`, "utf8");
    },
    writeBrokenJob: () => {
      fs.writeFileSync(jobPath, "version: 1\ndocs: [ this is not: valid yaml\n", "utf8");
    },
  };
  return harness;
}

/** Mutable session stub that records patches and can simulate newSession. */
export function createSessionStub(initial?: SessionMeta) {
  let meta: SessionMeta | undefined = initial;
  const patches: Partial<SessionMeta>[] = [];
  const notified: string[] = [];
  let newSessionImpl: ((opts: { withSession: (replaced: unknown) => Promise<void> }) => Promise<unknown>) | undefined;
  return {
    session: {
      getMeta: () => meta,
      updateMeta: (patch: Partial<SessionMeta>) => {
        patches.push(patch);
        meta = { ...(meta ?? ({} as SessionMeta)), ...patch } as SessionMeta;
        return meta;
      },
    },
    ui: { notify: (message: string) => notified.push(message) },
    patches,
    notified,
    setNewSession: (impl: typeof newSessionImpl) => {
      newSessionImpl = impl;
    },
    withNewSession: () => (newSessionImpl ? { newSession: newSessionImpl } : {}),
    meta: () => meta,
  };
}
