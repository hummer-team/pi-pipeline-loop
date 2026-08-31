## Code & Architecture Principles
1. **New features or bug fixes**: Phase planning must be completed first. For unclear requirements or issues, raise questions and wait for my feedback. Code‑writing can only start after the solution passes review and approval.
2. **Mandatory**: After each phase implementation:
    - Run the project build command (defined in `AGENTS.md`). Build must pass; fix failures before proceeding.
3. **Unit‑Testing**:
    - New features and bug fixes must be covered by corresponding unit tests.
    - Run project test commands for validation before marking completion; all tests must pass.
4. **Minimum‑Intervention Principle**: Make localized changes targeting the problem. Large‑scale refactoring or deletion of unrelated valid code is prohibited.
5. **Robustness Requirement**: Improve code robustness. Ensure no syntax errors, type errors or null‑pointer exceptions.
6. **Auto‑Permissions**: Read‑only inspection and build‑verification terminal commands for project build tools are allowed by default (subject to `AGENTS.md`).
7. **Coding Standards**:
    - All code comments and logs shall be written in English.
    - Code shall follow industry best practices of the tech stack with clear comments.
8. **Naming Convention**: New directories and files shall use business‑meaningful names following naming standards. Meaningless names such as `temp`, `test2` are forbidden.

## Output Requirements
1. **Mandatory**: Keep outputs concise (no irrelevant content). Perform thorough reasoning.
2. **Interaction Language**: Summarize modifications and implementations in Chinese; thinking‑process content may use English.

## 🤖 Sub‑Agent Scheduling SOP
```
Requirement Doc → design‑und → full‑und? → design‑plan → develop → code‑review
(Request File)  (Clarification)  (User Confirm)  (Output _plan.md)  (Phase‑wise Dev)  (Review Report)
```

| # | Rule | Description |
|---|------|------|
| 1 | **No Unauthorized Output‑Path Assignment** | Output paths are defined inside the loaded Sub‑Agent skill. The main agent shall not specify file‑write or overwrite targets in prompts. |
| 2 | **No Self‑Stage‑Judgment** | Entry‑exit conditions for each workflow stage (e.g. `full‑und?`) are defined by the skill. The main agent waits for user signals and shall not skip stages automatically. |
| 3 | **Transparent Forwarding** | Forward user inputs (replies, `full‑und?`, feedback) to the sub‑agent as‑is. The sub‑agent’s internal skill decides next‑step actions. |
| 4 | **Trust Skill Workflow** | Sub‑Agent executes independently under `context: fork`. The main agent shall not issue low‑level implementation instructions (e.g. specific files or lines to modify). |

## 🛡️ Scope Boundaries
**Hard‑Stop Prohibited Actions**:
- Adding new project dependencies is forbidden unless explicitly approved.
- Renaming or relocating existing files is forbidden unless required by the task.
- Modifying core project configuration files (which break project structure) is forbidden.
- Stop execution and report blockers after 3 consecutive failures; no 4‑th retry attempt.
- Avoid complimentary opening or closing remarks.
- Reason based on project facts and evidence, rather than simply endorsing user opinions.
