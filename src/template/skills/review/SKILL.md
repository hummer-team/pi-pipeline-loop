---
name: review
description: Code‑Review Expert‑Review the implementation against the plan
userInvocable: false
disable-model-invocation: true
---

## workflow
1. **Parse Input**: Extract file path `code‑review‑agent {file}_Develop_Commit.md` from task description passed by upstream Agent.
2. Read `{file}_Develop_Commit.md`. Terminate review and output "Missing plan document, please supplement" if `plan doc` is absent; terminate review and report error if `commit id` is missing.
3. Read references inside `{file}_Develop_Commit.md`
   - `plan doc`: Read and understand the plan
   - `commit id`: Perform review based on dev commit id or fix commit id
4. Complete review per steps below

### 0. Follow YAGNI Principle for Plan Implementation‑Code Restraint & Reflection
1. If an implementation already exists in the codebase, reuse existing functions and modules directly.
2. If solvable by the standard library, use the standard library.
3. If solvable by existing dependencies, use current dependencies.
4. If achievable in one‑line code, avoid over‑engineering; simplify and combine sub‑functions to meet business goals.

### 1. Scope Compliance
‑ Check whether changes from dev/fix commit id in `{file}_Develop_Commit.md` contain unexpected modifications to files unrelated to plan; mark severity as `High` if found.
‑ Note: Ignore historical incremental changes not included in commit diff during review.
‑ Check whether new files are explicitly specified in plan document; mark as `Medium` if not defined in plan.

### 2. Type & Null‑Safety
<!-- Template-TODO: 替换为项目审查规范 -->
‑ Rules below are general template; refer to project [frontend_ts_code_spec](.pi/references/frontend_ts_code_spec.md) for project‑specific requirements.
‑ **No raw types**: Type parameters must be specified for generic classes.
‑ **Proper nullable handling**: Explicit null handling (early return, default value, assertion) is required for potentially‑null return values; direct unchecked usage is forbidden.
‑ **NonNull check for public‑method arguments**: Critical input arguments of core public entry methods shall be checked for `null` / empty values.

### 3. Regression & Side‑Effect Detection
‑ **Method signature compatibility**: Modified public/protected method signatures must be compatible with all call‑sites.
<!-- Template-TODO: 替换为项目特有的回归检测规则（如 ORM 实体变更、定时任务调度影响等） -->

### 4. Code Quality
‑ **Overlong function**: Mark `Medium` when single method exceeds 100 lines without strong coupling justification.
‑ **Poor naming**: Mark `Low` for neutral variable/method names without clear business semantics.
‑ **Robustness**:
  ‑ Missing boundary checks (empty collection, null, blank string) for core logic.
  ‑ `catch` blocks must write `error`‑level log with explicit input parameters and exception stack trace; empty catch swallowing exceptions is forbidden.
  ‑ Single‑item failure in batch processing shall not abort the whole batch.
‑ **Code duplication**: Violates DRY principle.
<!-- Template-TODO: 替换为项目特有的代码质量规则（如外部调用规范等） -->

### 5. Logging Specification
<!-- Template-TODO: 替换为项目审查规范 -->
‑ **Unified framework**: Use project‑agreed logging framework; direct standard output stream usage is forbidden.
‑ **Log level**:
  ‑ Method entry/exit and core business flow → `info`
  ‑ Intermediate process data → `debug`
  ‑ Exceptions → `error`
‑ **Log content**: Critical logs must carry context information; exception logs must include stack trace.

### 6. Configuration Security
‑ Hard‑coding secrets, passwords, tokens and other sensitive data in source code is forbidden.
<!-- Template-TODO: 替换为项目特有的配置安全规则 -->

### 7. Output Format Issue / Severity / Improvement Suggestion
1. Severity definition
   - **Blocker**:
     - Missing phase defined in plan
     - Memory leak, OOM
   - **High**:
     - Tasks defined in plan document are not fully implemented
   - **Medium**:
     - Incomplete logic coverage against plan
     - Unclear implementation boundary, complex hard‑to‑maintain code
     - Potential functional impact under partial scenarios
     - Not following the `YAGNI` principle
   - **LOW**:
     - Non‑functional issues
     - Format, naming, style, readability concerns only
2. Mark **Blocker**, **High**, **Medium** items as `To‑Fix` or `待修复`; LOW items require no fixes.

### 8.1 Review Output Directory: `docs/review`
1. File naming rule: `Code_Review_{file}_Develop_Commit_{index}.md`
   - `{file}`: Plan file name
   - `{index}`: Review round number, starting from 1
   - Example: `docs/review/Code_Review_xx_Plan_Develop_Commit_1.md`
2. Strictly follow the content template. Output type‑safety, regression‑side‑effect detection issues via template if found. If no issues exist, briefly summarize review scope inside `Summary`.
3. use `read` tool report format flow [review_report_template.md](.pi/references/review_report_template.md)

### 9. not commit review doc
1. All review‑related documents and templates shall be stored locally; no commit required.
