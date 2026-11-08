/**
 * 227 Phase 4 (D-3): the UNATTENDED contract section.
 *
 * Pins: the rendered sequence, the stop-and-report clause, and the human-track
 * `null` (zero prompt change).
 */
import { describe, it, expect } from "bun:test";
import { buildUnattendedSection } from "../../core/auto-pipeline/unattended-guidance";
import { makeTestConfig, makeTestMeta } from "../helpers";
import type { SessionMeta } from "../../types";

const autoMeta = (): SessionMeta =>
  makeTestMeta({
    currentStage: "develop",
    autoJob: { jobId: "guidance_loop", jobPath: "docs/jobs/guidance_loop.yaml", docIndex: 2, totalDocs: 4 },
  });

describe("227 P4: buildUnattendedSection", () => {
  it("renders job identity, the forward sequence and the stop-and-report contract", () => {
    const config = makeTestConfig();
    const text = buildUnattendedSection(config, autoMeta());

    expect(text).not.toBeNull();
    expect(text).toContain("# UNATTENDED AUTO JOB");
    expect(text).toContain("guidance_loop (doc 3/4)");
    expect(text).toContain("develop → review");
    expect(text).toContain("Do NOT ask the user");
    expect(text).toContain("stage_advance");
    expect(text).toContain("stop-and-report");
  });

  it("returns null on the human track", () => {
    expect(buildUnattendedSection(makeTestConfig(), makeTestMeta())).toBeNull();
  });
});
