# Code & Architecture Principles
## Clarify, Design, Plan
1. For new features or bug fixes: phase planning must be completed first. Raise questions for unclear requirements or issues, and continue analysis after receiving my feedback.
2. Analyze requirements and bug scope based on code and git commit records. Do NOT assume requirements or issues subjectively.

## Develop, Fix
1. **Mandatory**: After finishing each phase:
    - Run project build commands (defined in AGENTS.md). Build must pass; fix issues before proceeding.
2. **Unit Tests**:
    - New features and bug changes must have corresponding unit test coverage.
    - Run project test commands to verify code and ensure all tests pass before marking completion.
3. **Minimum Intervention Principle**: Make local changes focused on the problem. Large-scale refactoring or deletion of unrelated valid code is forbidden.
4. **Robustness Requirement**: Improve code robustness, ensure no syntax errors, type errors or null pointer exceptions.
5. **Coding Standards**:
    - Code comments and logs must be written in English.
    - Code follows best practices of the project tech stack with clear comments.
6. **Naming Convention**: New directories or files must use business-relevant names complying with naming rules. Meaningless names such as `temp`, `test2` are prohibited.

## Output Requirements
1. **Mandatory**: Keep output concise (no irrelevant content). Ensure thorough reasoning.
2. Interaction language: Summarize implementation or changes in Chinese; reasoning can use English.

## 🤖 Subagent Scheduling SOP
```
Requirement Doc → design-und → full-und? → design-plan → design-review → develop → code-review
(Request File)  (Append clarify) (User and model Confirm) (Output _Plan.md) (Review Plan) (Phase-wise Dev) (Review Report)
```
| # | Rule | Description |
|---|------|-------------|
| 1 | **Payload may name the expected artifact** | Output paths are defined in SKILL loaded by Subagent. Main Agent MUST NOT overwrite a business output path, but MAY carry the expected artifact path (per `references/review-loop-contract.md` §8), the injected issue ids and this round's scope in the dispatch payload. |
| 2 | **Do not replace stage judgement** | Stage entry/exit conditions are defined in SKILL (e.g. `full-und?`). Main Agent waits for user signal and must NOT skip stages automatically. |
| 3 | **Transparent forwarding** | Forward user input (`Answer`,`答`, `full-und?`, feedback) as-is to Subagent. Subagent’s internal SKILL decides next steps. |
| 4 | **Trust SKILL workflow** | Subagent runs independently with `context: fork`. Main Agent shall not send low-level implementation instructions (e.g. which file/line to modify). |

## 🛡️ Scope Boundaries
**Hard Stop Actions (Forbidden)**:
- Do NOT add new project dependencies unless explicitly approved.
- Do NOT rename/move existing files unless explicitly required by the task.
- Do NOT modify core project config files which break project structure.
- No complimentary opening or closing remarks.
- Do NOT cater to user opinions; reason and validate based on project facts.

## Review Loop Contract

The "find → fix → re-check" loop is defined once in `references/review-loop-contract.md` (nine sections). This SOP only states how the orchestrator runs it; every criterion (blocking set, issue ids, ledger, dispositions, convergence gates, artifact names) comes from that contract.

| Loop | Artifact |
|---|---|
| Plan review | `Design_Review_{index}_{docBase}.md` (design directory) |
| Plan revision receipt | `Design_Review_Update_{index}_{docBase}.md` (design directory) |
| Code review | `Code_Review_{reqBase}_Develop_Commit_{index}.md` (review directory) |

## Master Agent Orchestration Contract

The orchestrator owns dispatch and acceptance (contract §7). Skills/agents return `verdict + nextStage`; they never spawn the next stage.

**Pre-dispatch gates** (all MUST hold before dispatching):

1. The previous stage's artifact exists at the path the contract dictates.
2. The report is contract-parsable: every issue carries an id, a severity and Evidence (Blocker/High), and the ledger restates every injected id.
3. `openBlocking` was computed from the round report's `## Issue Ledger` (status `open` with severity Blocker/High).
4. None of the three convergence gates fired (contract §6).
5. The round budget is not exhausted.

**Dispatch payload fields**: `stage`, `round`, expected artifact path, the injected previous-round open id list, this round's scope, and the acceptance command(s).

**Post-dispatch acceptance** (in order): path exists → contract-parsable → verdict parsed → `openBlocking` recomputed → gate state updated. A sub-agent that claims completion while its artifact is unchanged counts as a FAILED dispatch.

**Failure matrix**:

| Failure | Action |
|---|---|
| Artifact missing / path mismatch | Re-dispatch once, carrying the expected path |
| Contract-invalid report | Return once with the validation feedback; a second failure escalates to a human |
| Same cause fails twice | Escalate to a human |
| Three consecutive failures | Hard stop |
| `pending_spawn_stalled` | Exactly one manual dispatch is allowed |
| Loop budget exhausted | Follow `onExhausted` / the human decision |

**Gate execution detail**: gates 1 and 2 compare the previous and current rounds' `Open blocking` / `Open ids` lines; gate 3 counts rounds of the loop. Hitting any gate stops the loop and outputs the remaining blocking list plus one recommendation (`revise-plan`, `request-human`, or `advance`).

## PIPELINE AUTOMATION RULES
The pipeline plugin handles the following automatically. Do NOT duplicate or interfere with these operations:

| Operation | Owner | Trigger |
|-----------|-------|---------|
| Stage verification (verify.md rules) | Plugin (agent_settled hook) | After agent settles |
| Stage advance (currentStage transition) | Plugin (auto-advance after verify pass) | Verify pass + confirm gate |
| Stage executor spawn (subagent dispatch) | Plugin (spawnStageSubagent) | After stage advance |
| TUI status bar update | Plugin (syncStageStatusBar) | Every owner settle |
| Pipeline freeze (verify overflow / violation breaker) | Plugin (freezeAndPrompt) | Threshold exceeded |
| Git clean check (develop/fix) | Plugin (requiredGit.cleanWorkingTree) | During verify |

**Model responsibilities** (you MUST do these):
1. Call `stage_advance` tool to declare stage completion (especially `reviewConclusion` for review stage)
2. Run `git add && git commit` before stage completion when the stage's commit contract is active (the plugin injects the effective capability — including a dedicated `Git:` line in the Loop Status of develop/fix and in the Stage Write Scope of every other stage); when git is read-only, do not attempt git writes
3. Call `generate_stage_summary` with `commitIds` parameter after committing
4. Follow SKILL output format requirements strictly
5. Do NOT call stage_advance for stages that auto-advance via verify pass
