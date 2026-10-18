---
name: plan
description: Solution Planning‑ Generate complete development planning documents based on requirement understanding and clarification results
userInvocable: false
disable-model-invocation: true
---

## workflow

### Mandatory
1. The plan guides development in the develop phase. Plan content shall be definite solution descriptions, without options, ambiguity, redundant or useless text.
2. Must refer to `4. Follow YAGNI Principle‑Code Restraint & Reflection`.
3. Must balance feature implementation and performance; do not introduce technical debt.
4. Split long tasks reasonably. Large task phases can be split into separate phases to keep phases cohesive;
5. Keep phases independent. If dependencies exist, plan the provider phase in advance in sequence and mark e.g. **Depends on phase 0**

### Process Boundaries
1. Modification of any source‑code files is prohibited.
2. Only implementation‑step planning for solutions shall be performed.

### Input
- **Requirement Understanding Result**: Must contain clear solution‑decision information (requirement goals, scope, solution selection). No ambiguous or undecided solutions may enter the plan phase.
- **Source File**: Requirement and clarification document read in the `design` phase (e.g. `docs/design/{index}_{xxx}.md`)
  - Note: `{index}` and `{xxx}` are placeholders, example: 15_command_flow_skip.md

### Plan Must satisfy
1. Two‑way traceability between design and plan: The planning phase must reference specific points from the design solution.
2. Full‑coverage review before finalizing the plan.
3. Shall not exceed the scope of issue clarification and solution decisions.

### Follow YAGNI Principle‑Code Restraint & Reflection
1. Is there an existing implementation in codebase? Reuse existing functions and modules.
2. Can it be solved by standard library? Use standard‑library solutions.
3. Can it be solved by existing dependencies? Reuse current dependencies.
4. Can it be done in one line? Avoid over‑engineering; adopt simple implementation to meet requirements.
5. If none of above applies, design reasonable and maintainable code.

### Generate Planning Document
#### Planning content must include(**out put Language for [plan_template.md](.pi/references/plan_template.md)**):
  1. **Summary**: Concise description of the problem to be solved
  2. **Phase {x}**: Each Phase contains objectives, task list and acceptance criteria
  3. **Task List**: Scope of files to modify, new files, new interfaces / data‑structures, refactoring approach and detailed logic implementation
  4. **Acceptance Criteria**: Validation requirements of `compile` + `unit test` for each Phase
  5. **Unit Tests Core**: Describe key unit‑test objectives for the phase, including new or updated tests
  6. **Commit Specification**: Compliant with git commit convention, example:
    - feat(scope):scope is Core Modifications，e.g: fulfillment,kernel‑picker,rfm

#### Generate the complete plan referencing template [plan_template](.pi/references/plan_template.md).
#### **Plan File Path**: User‑specified output path for `_Plan.md`
  - Example：`docs/design/01_e2e_flow_v1_Plan.md`

### Output Requirements
1. Keep content concise, highlight key points and boundaries; avoid redundant or irrelevant content.
2. **Forbidden output**: Development time estimation, workload assessment, etc.

### Plan Review
1. After finishing the plan, **must review it** to verify full coverage of solutions and clarified issues; supplement content if anything is missing.
2. refer `### Mandatory`

### Do Not Commit Design and Plan Docs
1. Store design and planning documents locally; no commit required.

### Checkpoint discipline (crash-resilient output)
- Create the deliverable file early (skeleton with section headers), then append content in ≤2KB chunks.
- Never accumulate the full result for a single final write — at any crash point, the sunk cost is at most the last unwritten chunk.
