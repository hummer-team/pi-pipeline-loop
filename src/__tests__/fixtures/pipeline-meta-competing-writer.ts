/**
 * 193 Phase 2 (Unit Tests Core #1): REAL competing meta.json writer.
 *
 * Spawned by `src/__tests__/core/pipeline-meta-transaction.test.ts` via
 * `Bun.spawn([execPath, thisFile, ...])`. Each child process owns an
 * INDEPENDENT `createSessionState` adapter (its own local entry array) over
 * the SAME shared `{projectRoot}/{auditDir}/{pipelineId}` directory — the
 * genuine cross-process situation the exclusive lock exists for. Serial
 * in-process stand-ins are NOT acceptable for these acceptance bullets, so
 * this fixture never mocks the strict path: it uses production code only.
 *
 * Usage:
 *   bun pipeline-meta-competing-writer.ts <mode> <projectRoot> <auditDir> \
 *       <pipelineId> <readyFile> <goFile> <resultFile> [choice]
 *
 * Modes:
 * - "choice-commit"  [choice] strict commit of a human choice against the
 *   shared pending revision (identity + decisionId + pending expectation).
 * - "send-intent-claim" strict in-lock dispatch claim (operationClaimable)
 *   against the shared not-sent operation.
 * - "plain-counter"  legacy plain updateMeta (loopCount bump) competing with
 *   strict writers — must never roll back a persisted choice.
 * - "stale-overwrite" takes a whole-meta snapshot BEFORE the go barrier, the
 *   parent persists a chosen decision meanwhile, then the child tries the
 *   stale plain whole-object overwrite — production must reject it.
 * - "reader"         hammers JSON.parse of meta.json while the parent does
 *   rapid atomic publishes — any half-written JSON is a parse failure.
 *
 * The child writes a small JSON verdict to <resultFile> for the parent to
 * assert. The go barrier is a plain file touch — both children poll (short
 * Atomics waits) and fire within milliseconds of each other.
 */

import fs from "node:fs";
import * as path from "node:path";
import { createSessionState, type MetaCommitExpectation } from "../../core/session-state";
import type { SessionMeta } from "../../types";

const [
  mode = "",
  projectRoot = "",
  auditDir = ".pi/audit",
  pipelineId = "",
  readyFile = "",
  goFile = "",
  resultFile = "",
  choice = "revise-plan",
] = process.argv.slice(2);

if (!mode || !projectRoot || !pipelineId || !resultFile) {
  process.stderr.write("pipeline-meta-competing-writer: missing arguments\n");
  process.exit(2);
}

// ─── real production adapter (own local entries, SAME shared dir) ───────────

const entries: unknown[] = [];
const pi = {
  appendEntry: (customType: string, data: unknown) => {
    entries.push({ type: "custom", customType, data });
  },
};
const ctx = {
  sessionManager: {
    getEntries: () => entries,
    getBranch: () => entries,
  },
};
const session = createSessionState(pi as never, ctx as never, { projectRoot, auditDir });

const sharedMetaPath = path.join(projectRoot, auditDir, pipelineId, "meta.json");

function readShared(): SessionMeta | undefined {
  try {
    return JSON.parse(fs.readFileSync(sharedMetaPath, "utf-8")) as SessionMeta;
  } catch {
    return undefined;
  }
}

function sleepMs(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Wait (bounded) until the parent touches the go file, then return. */
function awaitGo(timeoutMs = 20000): boolean {
  const start = Date.now();
  while (!fs.existsSync(goFile)) {
    if (Date.now() - start > timeoutMs) return false;
    sleepMs(1);
  }
  return true;
}

function writeResult(payload: Record<string, unknown>): void {
  fs.writeFileSync(resultFile, JSON.stringify(payload), "utf-8");
}

/** Union-safe read of the persisted choice. */
function choiceOf(meta: SessionMeta | undefined): string | undefined {
  const d = meta?.designReview?.decision;
  return d && d.state === "chosen" ? d.choice : undefined;
}

function markReady(): void {
  fs.appendFileSync(readyFile, `${process.pid}\n`, "utf-8");
}

// Seed this child's LOCAL entries from the healthy shared snapshot so
// getMeta() resolves the pipeline (a plain whole-object echo of UNCHANGED
// state is barrier-legal by design). Without this, the adapter honestly
// reports no current state.
function seedFromShared(): SessionMeta {
  const shared = readShared();
  if (!shared) {
    writeResult({ status: "setup_failed", reason: "shared_meta_missing" });
    process.exit(1);
  }
  session.updateMeta(shared);
  return readShared() ?? shared;
}

function expectationFromShared(shared: SessionMeta): MetaCommitExpectation {
  const dr = shared.designReview!;
  return {
    pipelineId,
    ...(dr.authorizationId !== undefined ? { authorizationId: dr.authorizationId } : {}),
    ...(dr.round !== undefined ? { round: dr.round } : {}),
    ...(dr.operation?.operationId !== undefined
      ? { operationId: dr.operation.operationId }
      : { operationId: null as string | null }),
    ...(dr.phase !== undefined ? { phase: dr.phase } : {}),
    stateUpdatedAt: dr.updatedAt,
  };
}

function main(): void {
  const shared = seedFromShared();
  markReady();
  if (!awaitGo()) {
    writeResult({ status: "barrier_timeout" });
    process.exit(1);
  }

  if (mode === "choice-commit") {
    const dr = shared.designReview!;
    const pendingDecision = dr.decision!;
    const expected: MetaCommitExpectation = {
      ...expectationFromShared(shared),
      decisionId: pendingDecision.decisionId,
      decisionState: "pending",
    };
    const chosenMeta: SessionMeta = {
      ...shared,
      designReview: {
        ...dr,
        decision: {
          ...pendingDecision,
          state: "chosen",
          choice: choice as "revise-plan" | "proceed-develop",
          source: "human",
          decidedAt: Date.now(),
        },
      },
    };
    const res = session.updateMetaVerified!(chosenMeta, expected);
    writeResult({
      pid: process.pid,
      choice,
      status: res.status,
      ...(res.status === "conflict" ? { reason: res.reason } : {}),
      ...(res.status === "unavailable" ? { reason: res.reason } : {}),
      persistedDecisionState:
        res.status === "persisted" ? res.meta.designReview?.decision?.state : undefined,
      persistedChoice:
        res.status === "persisted" ? choiceOf(res.meta) : undefined,
      persistedRevision:
        res.status === "persisted" ? res.meta.designReview?.updatedAt : undefined,
    });
    return;
  }

  if (mode === "send-intent-claim") {
    const dr = shared.designReview!;
    const expected: MetaCommitExpectation = {
      ...expectationFromShared(shared),
      operationClaimable: true,
    };
    const intentMeta: SessionMeta = {
      ...shared,
      designReview: {
        ...dr,
        operation: { ...dr.operation!, dispatchEvidence: "send_intent", updatedAt: Date.now() },
        updatedAt: Date.now(),
      },
    };
    const res = session.updateMetaVerified!(intentMeta, expected);
    writeResult({
      pid: process.pid,
      status: res.status,
      ...(res.status !== "persisted" ? { reason: res.reason } : {}),
      persistedEvidence:
        res.status === "persisted" ? res.meta.designReview?.operation?.dispatchEvidence : undefined,
      persistedRevision:
        res.status === "persisted" ? res.meta.designReview?.updatedAt : undefined,
    });
    return;
  }

  if (mode === "plain-counter") {
    // Stale-ish plain writer: bumps loopCount from the snapshot taken at
    // seed time. The production plain path merges on the IN-LOCK shared
    // snapshot, so a choice committed by another process between now and
    // then must survive.
    const returned = session.updateMeta({ loopCount: (shared.loopCount ?? 0) + 1 });
    const after = readShared();
    writeResult({
      pid: process.pid,
      returned: returned !== undefined,
      decisionStateAfter: after?.designReview?.decision?.state ?? "none",
      decisionChoiceAfter: choiceOf(after) ?? "none",
      loopCountAfter: after?.loopCount,
    });
    return;
  }

  if (mode === "stale-overwrite") {
    // `shared` was captured BEFORE the go barrier (the parent commits a
    // chosen decision between markReady() and awaitGo()). Trying to plain-
    // write the STALE whole designReview object must be rejected outright.
    const returned = session.updateMeta({ designReview: shared.designReview });
    const after = readShared();
    writeResult({
      pid: process.pid,
      rejected: returned === undefined,
      decisionStateAfter: after?.designReview?.decision?.state ?? "none",
      decisionChoiceAfter: choiceOf(after) ?? "none",
      revisionAfter: after?.designReview?.updatedAt,
    });
    return;
  }

  if (mode === "reader") {
    // Half-write detector: parse the shared file as fast as possible while
    // the parent performs rapid atomic publishes. A missing file counts as
    // a skip only when it was NEVER observable before; a parse failure of
    // an existing file is a HALF-WRITE (fatal for the atomic-publish claim).
    let reads = 0;
    let parseFailures = 0;
    let pipelineMismatch = 0;
    const start = Date.now();
    while (Date.now() - start < 1500) {
      let text: string | undefined;
      try {
        text = fs.readFileSync(sharedMetaPath, "utf-8");
      } catch {
        continue;
      }
      reads++;
      try {
        const parsed = JSON.parse(text) as SessionMeta;
        if (parsed.pipelineId !== pipelineId) pipelineMismatch++;
      } catch {
        parseFailures++;
      }
    }
    writeResult({ pid: process.pid, reads, parseFailures, pipelineMismatch });
    return;
  }

  writeResult({ status: "unknown_mode", mode });
  process.exit(2);
}

main();
