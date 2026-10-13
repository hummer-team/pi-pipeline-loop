---
name: develop
description: Complete phase‑feature development and unit testing according to the plan.
userInvocable: false
disable-model-invocation: true
---

## workflow

### Must Follow
1. **plan**: Complete all planned tasks strictly in the order of phases in plan doc (no skipping or omission)
2. **Follow YAGNI**
3. **Technical Spec**: Read [frontend_ts_code_spec.md](.pi/references/frontend_ts_code_spec.md)
4. **Forbidden**: Overwriting plan content in any form is prohibited

### Follow YAGNI Principle for Plan Implementation‑Code Restraint & Reflection
1. If an implementation already exists in the codebase, reuse existing functions and modules directly.
2. If solvable by the standard library, use the standard library.
3. If solvable by existing dependencies, use current dependencies.
4. If achievable in one‑line code, avoid over‑engineering; simplify and combine sub‑functions to meet business goals.
5. **Documentation and code comments shall be concise, highlight key points only, avoid lengthy and redundant descriptions.**

### Phase Development Workflow
1. **Pre‑check**:
   - Verify whether the plan file exists. Prompt the user and terminate if missing.
   - Check if the file contains sections marked `## Phase <index>`. If not, report "Invalid plan file".
     - Examples: `Phase 0: xxx`, `Phase 1: xxx`.
2. **Parse Plan**: Read the plan file and understand all phases, their task lists and acceptance criteria.
3. **Git Log Check**
   - Read recent completed features from git‑log to avoid duplicate work and ensure continuous development.
4. **Incremental Development by Phase** (Phase index starts from 0):
   - Execute each phase sequentially.
   - Report progress to user after finishing each phase (e.g. "Phase 1/5 completed").
   - Run project build and unit‑test commands (based on actual tech stack) after every phase to confirm success.
     - Auto‑fix failed tests.
5. **Mandatory actions after each phase**:
   - **Commit must be recorded after each phase completes**
   - **Commit code following the commit instructions defined in the plan document**
   - `Read` the template [develop_commit_template](.pi/references/develop_commit_template.md)
6. **Deliverable Specification**: `Read` the template [develop_deliverable_template](.pi/references/develop_deliverable_template.md)

---
## Deliverables
1. Commit document must be generated following the specification in [develop_commit_template](.pi/references/develop_commit_template.md)

## Checkpoint discipline (crash-resilient output)
- Create the deliverable file early (skeleton with section headers), then append content in ≤2KB chunks.
- Never accumulate the full result for a single final write — at any crash point, the sunk cost is at most the last unwritten chunk.
