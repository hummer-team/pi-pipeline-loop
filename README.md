# @earendil-works/pi-pipeline

> A controlled pipeline plugin for [pi agent](https://github.com/earendil-works/pi) — enforcing a 7-stage quality loop with automated verification, file protection, circuit breakers, and full audit trail.

---

## Capabilities

| Capability | Description |
|------------|-------------|
| **7-Stage Pipeline** | `clarify → plan → develop → review ⇄ fix → completed` with `awaiting_human` as fallback freeze state |
| **6 Lifecycle Hooks** | Automatic verification, prompt injection, tool safety, loop circuit breaking, session recovery, and shutdown |
| **6+1 Tools** | Stage advancement, loop checking, pipeline state, summary generation, summary validation, handoff, plus conditional `pipeline_verify` (registered when any stage uses tool mode) |
| **4 Commands** | `/pipeline-init`, `/pipeline-start`, `/pipeline-status`, `/pipeline-quit` |
| **Decision Menu** | Keyboard shortcut (default `Ctrl+Enter`) for 5-option frozen pipeline recovery: resume / skip / rollback / restart / abort |
| **5 Verification Rules** | `requiredFiles`, `requiredCommands`, `requiredGit`, `fileContentPattern`, `keywords` — with `and`/`or` combinator mode |
| **Hook/Tool Dual Mode** | Verification triggers automatically via hook (default) or on-demand via explicit tool call |
| **Three-Layer File Protection** | Hardcoded paths (`.pi/`, `.git/`) → dynamic `.gitignore` protection → allow-list exemptions, plus stage-level write whitelists |
| **Audit Trail** | JSONL event log, prompt snapshot archival, and per-file diff archiving |
| **JSON Config Entry** | Simplified setup via `pipeline_loop.json` — no TypeScript config needed |
| **Crash Recovery** | Stale session auto-reset on process restart (covers SIGKILL / terminal force-kill) |

---

## Quick Start

**1. Install**

```bash
npm install @earendil-works/pi-pipeline
```

**2. Create `.pi/pipeline_loop.json`**

```json
{
  "stages": {
    "clarify": { "skillPath": "design-und/SKILL.md" },
    "plan":    { "skillPath": "design-plan/SKILL.md" },
    "develop": { "skillPath": "fast-develop/SKILL.md" },
    "review":  { "skillPath": "code-review/SKILL.md" },
    "fix":     { "skillPath": "code-review-withfix/SKILL.md" }
  }
}
```

**3. Start pi agent**

```bash
pi start
```

The plugin auto-detects `.pi/pipeline_loop.json` via `createPipelineFromJson` and registers all hooks, tools, and commands. Stages not listed in the JSON are disabled. All other fields receive sensible defaults.

---

## Workflow

```
┌─────────┐    ┌──────┐    ┌─────────┐    ┌─────────┐    ┌─────┐
│ clarify │───▶│ plan │───▶│ develop │───▶│ review  │───▶│ fix │
└─────────┘    └──────┘    └─────────┘    └─────────┘    └─────┘
                                    ▲                   │
                                    └───────────────────┘
                                     review ⇄ fix loop
                                     (≤ maxLoops per stage)
                                                       │
                                                       ▼
                                               ┌───────────┐
                                               │ completed │
                                               └───────────┘
```

| Stage | Purpose |
|-------|---------|
| **clarify** | Requirement analysis and ambiguity resolution. Produces a clarified requirement document. |
| **plan** | Solution design and implementation planning. Includes a human confirmation gate before proceeding. |
| **develop** | Code implementation following the plan. Verification gates check deliverables before review. |
| **review** | Code review against the plan and requirements. |
| **fix** | Address review findings. Loops back to review (up to `maxLoops` iterations). |
| **completed** | Terminal state — all stages passed. |
| **awaiting_human** | Fallback freeze state — pipeline frozen due to circuit breaker or manual intervention required. |

Each stage transition is governed by verification rules. The pipeline advances only when all checks pass.

---

## Key Features

### Verification Gates & Failure Wake

When the agent settles, the `agent_settled` hook automatically runs verification against the current stage's rules. If verification fails:

- The pipeline does **not** advance.
- The model is woken up with specific failure details to fix the issues.
- The cycle repeats until verification passes or the circuit breaker triggers.

Verification supports five rule types (file existence, command execution, git state, content patterns, keywords) with `and`/`or` combinator logic. Rules are defined in per-stage `verify.md` files with YAML frontmatter.

### Loop Circuit Breaker

Two independent circuit breakers prevent infinite loops:

- **maxLoops** — Maximum iterations within a single stage (default: 3). Triggered by test failures or verification failures.
- **maxLoopCycles** — Maximum full pipeline cycles (e.g., fix → develop loops, default: 3).

When either limit is reached, the pipeline freezes and presents the decision menu.

### Decision Menu

When the pipeline is frozen (circuit breaker, `awaiting_human`, or manual block), press the configured shortcut (default `Ctrl+Enter`) to open a 5-option menu:

1. **Resume** — Continue from the current stage
2. **Skip** — Skip the current stage
3. **Rollback** — Return to the previous stage
4. **Restart** — Restart the current stage
5. **Abort** — Terminate the pipeline

Each action is audited. The menu is also available programmatically when no TUI is present.

### Three-Layer File Protection

| Layer | Mechanism | Exemptable? |
|-------|-----------|-------------|
| Hardcoded paths | `.pi/`, `.git/` always protected | No |
| Dynamic gitignore | Files matching `.gitignore` patterns are protected | Yes, via `protect.allow` |
| Allow list | Specific paths exempted from gitignore protection | Edit only; git add/commit still blocked |

Additionally, each stage has a write whitelist controlling which directories can be modified. Stage whitelists cannot override hardcoded protection.

When `protect.ask` is enabled, a 3-choice dialog is shown for protection violations: follow plugin default / allow this edit / allow for session.

### Destructive Command Interception

Bash commands matching destructive patterns (`rm -rf /`, `sudo`, system-level paths) are blocked by default. With `protect.ask`, a confirmation dialog is shown instead.

### Git Safety

`git add` and `git commit` operations are intercepted and checked against protection rules using `--dry-run` and `diff --cached`. Protected paths cannot be staged or committed, even via `-a` flags.

### Crash Recovery

On process restart, if the pipeline was not cleanly shut down, the session state is automatically reset to `aborted`. This covers SIGKILL, terminal force-kill, and other ungraceful shutdown paths.

### Audit & Diff Archiving

All pipeline events are recorded as JSON Lines in the audit directory:

- Stage transitions, verification results, circuit breaker triggers
- Prompt snapshots (configurable: full / plugin-only / off)
- Per-file diffs archived at `{auditDir}/{pipelineId}/step-{n}/loop-{n}/`

### Plan Human Gate

The `plan` stage includes a mandatory human confirmation gate. Before advancing to `develop`, the user must confirm the plan document via a TUI dialog (confirm / adjust / cancel). Without UI, the pipeline waits silently.

### Summary Hash Integrity

Each stage summary includes a content hash. If a summary is manually modified outside the pipeline, the hash mismatch blocks stage advancement until the stage is re-entered.

---

## Commands

| Command | Description |
|---------|-------------|
| `/pipeline-init` | Initialize the pipeline configuration for a project |
| `/pipeline-start` | Start a new pipeline run (requires a requirement document) |
| `/pipeline-status` | Display current pipeline state, stage, loop count, and model |
| `/pipeline-quit` | Terminate the current pipeline session |

---

## Startup Modes

The `/pipeline-start` command supports three modes (configurable via `startStageMode`):

| Mode | Behavior |
|------|----------|
| `auto` | Zero-interaction default. Fresh start → clarify; aborted → resume at last stage |
| `confirm` | Resumable aborted pipelines prompt "Resume at {stage}?" before proceeding |
| `ask` | Interactive TUI menu with new / resume / spec / cancel options |

---

## License

MIT
