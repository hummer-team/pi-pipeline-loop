import { describe, it, expect } from "bun:test";
import {
  PIPELINE_ID_PATTERN,
  parsePipelineIdMarker,
  appendPipelineIdMarker,
} from "../../utils/pipeline-id-marker";

const VALID = "pipe-1723456789-abc123";

describe("pipeline-id-marker / parsePipelineIdMarker", () => {
  it("extracts a valid marker", () => {
    expect(parsePipelineIdMarker(`Begin work. Pipeline: ${VALID}. Requirement doc: x`)).toBe(VALID);
  });

  it("takes the FIRST marker when several are present", () => {
    const text = `Pipeline: ${VALID} and later Pipeline: pipe-1723456790-zzz999`;
    expect(parsePipelineIdMarker(text)).toBe(VALID);
  });

  it("returns null on empty / non-string input without throwing", () => {
    expect(parsePipelineIdMarker("")).toBeNull();
    expect(parsePipelineIdMarker(undefined as unknown as string)).toBeNull();
    expect(parsePipelineIdMarker(null as unknown as string)).toBeNull();
  });

  it("returns null when no marker is present", () => {
    expect(parsePipelineIdMarker("docs/design/204_Bug.md 1")).toBeNull();
  });

  it("rejects path-traversal style ids", () => {
    expect(parsePipelineIdMarker("Pipeline: pipe-1723456789-../../etc")).toBeNull();
    expect(parsePipelineIdMarker("Pipeline: pipe-../passwd")).toBeNull();
  });

  it("rejects legacy / malformed ids", () => {
    expect(parsePipelineIdMarker("Pipeline: pipe-legacy")).toBeNull();
    expect(parsePipelineIdMarker("Pipeline: pipe-1723456789-ABC123")).toBeNull();
    expect(parsePipelineIdMarker("Pipeline: pipe-1723456789-abc12")).toBeNull();
  });

  it("PIPELINE_ID_PATTERN matches the generator format", () => {
    const generated = `pipe-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    expect(PIPELINE_ID_PATTERN.test(generated)).toBe(true);
    expect(PIPELINE_ID_PATTERN.test(VALID)).toBe(true);
  });
});

describe("pipeline-id-marker / appendPipelineIdMarker", () => {
  it("appends the marker with a single separating space", () => {
    expect(appendPipelineIdMarker("docs/design/204_Bug.md 1", VALID))
      .toBe(`docs/design/204_Bug.md 1 Pipeline: ${VALID}`);
  });

  it("returns the prompt unchanged for an empty pipelineId (no trailing space)", () => {
    expect(appendPipelineIdMarker("doc 1", undefined)).toBe("doc 1");
    expect(appendPipelineIdMarker("doc 1", "")).toBe("doc 1");
  });

  it("is idempotent when the marker is already present", () => {
    const once = appendPipelineIdMarker("doc 1", VALID);
    expect(appendPipelineIdMarker(once, VALID)).toBe(once);
  });

  it("round-trips through the parser", () => {
    expect(parsePipelineIdMarker(appendPipelineIdMarker("doc 1", VALID))).toBe(VALID);
  });
});
