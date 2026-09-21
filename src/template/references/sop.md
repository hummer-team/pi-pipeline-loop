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
Requirement Doc → design-und → full-und? → design-plan → develop → code-review
(Request File)  (Append clarify) (User and model Confirm) (Output _plan.md) (Phase-wise Dev) (Review Report)
```
| # | Rule | Description |
|---|------|-------------|
| 1 | **Do not override output paths** | Output paths are defined in SKILL loaded by Subagent. Main Agent must NOT specify write/overwrite paths in prompts. |
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
2. Run `git add && git commit` before stage completion in develop/fix stages
3. Call `generate_stage_summary` with `commitIds` parameter after committing
4. Follow SKILL output format requirements strictly
5. Do NOT call stage_advance for stages that auto-advance via verify pass
