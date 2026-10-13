---
name: design
description: Analyze requirements, clarify questions and design solutions based on the file path and round number input by users
userInvocable: false
disable-model-invocation: true
---


## Round Title Contract
- **Recommended format**: `# 第 N 轮澄清` (Chinese, h1 or h2)
- **Compatible format**: `# Round N` (English, h1 or h2)
- **Note**: Only `#{1,2}` (h1/h2) are recognized as round titles; `###` and deeper levels will not trigger round detection

## workflow

## Responsibility Boundaries
1. No source‑code files shall be modified during the clarification phase.
2. Only issue clarification, sorting‑out and optimal‑solution analysis are allowed.

## Input
- **Document**: Requirement description file specified by user (e.g. `docs/design/{index}_{xxx}.md`)
- **Round**: Current clarification round (initial round set by user, tracked automatically afterwards)

### 1. Requirement Understanding & Clarification
1. Read requirement descriptions from the user‑specified file.
2. Start the current round; **append your questions, solution options and rationale for recommended solutions to the end of this file**, follow the format in [clarify_template](.pi/references/clarify_template.md).
3. Wait for user’s **answer** or **additional questions**.
4. After analyzing and appending clarification questions, **explicitly prompt the user**: "If requirements are fully understood, enter `full-und?` to trigger confirmation workflow".

**Examples**:
- `@feat-design-plan-agent docs/design/{index}_{xxx}.md 1` → Enter Round 1 clarification, append questions and solutions.
- After user replies: `docs/design/{index}_{xxx}.md 1 Answer`, automatically enter Round 2 clarification.

### 2. Processing After User Response
#### 2.1 User added reply content
1. User appended **Answer** or **Supplement** in the clarification document
2. Read the content and proceed to the next clarification round. **Note**: round number increments automatically.

#### 2.2 Command `docs/design/{index}_{xxx}.md full-und?` or `docs/design/{index}_{xxx}.md <Additional Questions or 补充问题>` 
1. **Mandatory**: Perform full analysis on the latest‑added **Answer**, **Supplement** or **Additional Questions** or **补充问题** from the user.
2. **Judgment Criteria**
   - Full understanding of requirement context (goals, boundaries).
   - Clear solution selection, no ambiguity and no side‑effects.
3. **If criteria are met**:
   - use `read` tool read [clarify_template](.pi/references/clarify_template.md) for confirmation workflow (includes `## 模型确认` record‑keeping protocol).
   - Append question summary & final solution decision to `{index}_{xxx}.md`.
4. **If criteria are not met** → Proceed to the next clarification round.

---
## Output Requirements
1. Be concise, accurate, highlight key points and boundaries; **avoid** redundant or irrelevant content.
2. **Forbidden output**: Development time estimation, workload assessment, etc.
