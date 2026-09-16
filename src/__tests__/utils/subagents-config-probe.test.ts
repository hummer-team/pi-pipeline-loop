import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { tmpdir } from "node:os";
import {
  probeSubagentsMentionMode,
  maybeNotifySubagentsMentionMode,
} from "../../utils/subagents-config-probe";
import { initAuditLog, getDateAuditFileName } from "../../utils/auditLog";
import { __resetMemoryThrottle } from "../../utils/audit-throttle";
import { makeTestConfig } from "../helpers";

let TMP: string;

beforeEach(async () => {
  TMP = path.join(
    tmpdir(),
    `pi-subagents-probe-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  await fs.mkdir(path.join(TMP, ".pi"), { recursive: true });
  __resetMemoryThrottle();
});

afterEach(async () => {
  await fs.rm(TMP, { recursive: true, force: true });
});

/** Writes `.pi/subagents.json`; a string argument is written verbatim (malformed JSON). */
async function writeSubagentsJson(value: unknown): Promise<void> {
  const content = typeof value === "string" ? value : JSON.stringify(value);
  await fs.writeFile(path.join(TMP, ".pi", "subagents.json"), content, "utf-8");
}

describe("probeSubagentsMentionMode (Phase 1 / 179)", () => {
  it("returns 'model' when agentMentions === 'model'", async () => {
    await writeSubagentsJson({ agentMentions: "model" });
    expect(probeSubagentsMentionMode(TMP)).toBe("model");
  });

  it("returns 'ok' when agentMentions === 'direct'", async () => {
    await writeSubagentsJson({ agentMentions: "direct" });
    expect(probeSubagentsMentionMode(TMP)).toBe("ok");
  });

  it("returns 'ok' for any other non-model value", async () => {
    await writeSubagentsJson({ agentMentions: "other" });
    expect(probeSubagentsMentionMode(TMP)).toBe("ok");
  });

  it("returns 'absent' when the file is missing", () => {
    expect(probeSubagentsMentionMode(TMP)).toBe("absent");
  });

  it("returns 'absent' when the agentMentions key is missing", async () => {
    await writeSubagentsJson({ maxConcurrent: 10 });
    expect(probeSubagentsMentionMode(TMP)).toBe("absent");
  });

  it("returns 'invalid' for malformed JSON", async () => {
    await writeSubagentsJson("{ not json");
    expect(probeSubagentsMentionMode(TMP)).toBe("invalid");
  });

  it("returns 'invalid' for a non-object JSON value", async () => {
    await writeSubagentsJson([1, 2, 3]);
    expect(probeSubagentsMentionMode(TMP)).toBe("invalid");
  });
});

describe("maybeNotifySubagentsMentionMode (Phase 1 / 179)", () => {
  it("model → exactly one notify (throttled) + audit", async () => {
    const config = makeTestConfig({ projectRoot: TMP });
    await initAuditLog(config);
    await writeSubagentsJson({ agentMentions: "model" });

    const notifications: string[] = [];
    const ui = { notify: (m: string) => notifications.push(m) };
    await maybeNotifySubagentsMentionMode(config, ui);
    await maybeNotifySubagentsMentionMode(config, ui);

    expect(notifications.length).toBe(1);
    expect(notifications[0]).toContain("direct");
    expect(notifications[0]).toContain("guide.md");

    const audit = await fs.readFile(
      path.join(TMP, ".pi", "audit", getDateAuditFileName()),
      "utf-8",
    );
    expect(audit).toContain("subagents_mention_model_detected");
  });

  it("direct → zero notify, no throw", async () => {
    const config = makeTestConfig({ projectRoot: TMP });
    await initAuditLog(config);
    await writeSubagentsJson({ agentMentions: "direct" });
    const notifications: string[] = [];
    await maybeNotifySubagentsMentionMode(config, { notify: (m) => notifications.push(m) });
    expect(notifications.length).toBe(0);
  });

  it("absent → zero notify, no throw", async () => {
    const config = makeTestConfig({ projectRoot: TMP });
    await initAuditLog(config);
    const notifications: string[] = [];
    await maybeNotifySubagentsMentionMode(config, { notify: (m) => notifications.push(m) });
    expect(notifications.length).toBe(0);
  });

  it("invalid → zero notify, no throw", async () => {
    const config = makeTestConfig({ projectRoot: TMP });
    await initAuditLog(config);
    await writeSubagentsJson("{ bad");
    const notifications: string[] = [];
    await maybeNotifySubagentsMentionMode(config, { notify: (m) => notifications.push(m) });
    expect(notifications.length).toBe(0);
  });
});
