# Summary
- Plan file: `docs/design/186_Bug_plan.md`
- Commit file: `docs/design/186_Bug_plan_commit.md`
- Commits reviewed (verified against real `git show` diffs, independent of round-1):
  - Phase 0 `4247ae5` — agent_settled guard reorder + syncStageStatusBar
  - Phase 1 `80e1aeb` — clear pendingSpawns on terminal states
  - Phase 2 `fa77ad3` — allowedReadOnlyPaths cross-stage protection
  - Phase 3 `b3ec0c4` — requiredGit.cleanWorkingTree in develop/fix verify
  - Phase 4 `70f2726` — PIPELINE AUTOMATION RULES in sop.md / sop_CN.md
- Verification run:
  - `bun run typecheck` → zero errors
  - `bun run build` → zero errors
  - `bun run test` → **2530 pass / 0 fail** (100 files), no regressions
- Scope compliance: all changed files fall inside the plan's file-change table or its
  Unit-Test Targets (Phase 1 `subagent-rpc.test.ts`, Phase 3/4 `template-defaults.test.ts`
  are implied by the required test targets even though the summary table omits them).
  No out-of-scope source modifications detected.
- Plan coverage: Phase 0/1/3/4 tasks fully implemented and verified. Phase 2 tasks 1–5 and 7
  fully implemented; **task 6 partially deviates from the prescribed mechanism** (see Issue 1).

## Review发现以下问题

### 问题 1
- 问题: `src/core/tool-guard.ts:116-125,138-186` — 交集告警的去重机制与 Plan 不一致。Plan Phase 2 任务 6 明确要求「Implement as a one-time check per stage (**use a meta flag** to avoid repeated warnings)」，但实现改用了**模块级** `const readOnlyWriteIntersectionWarned = new Set<string>()`，仅以 `stageName` 为 key。后果：
  1. 该 Set 是进程级全局状态，跨 session / 跨项目共享。同进程内启动第二个 pipeline（或切换项目）时，`develop`/`fix` 的 overlap 告警**不会再触发**，与「one-time per stage per session」的语义不符。
  2. 未写入 `meta`，告警状态无法随 session 生命周期重置，也无法在多实例插件下隔离。
- 等级：Medium
- 符合规划：否
- 是否修复：已修复
- fix commit: fb71385
- plan是否覆盖
  - 已覆盖：Phase 2 任务 6（"On pipeline start (or first tool_call per stage) … Implement as a one-time check per stage (use a meta flag to avoid repeated warnings)"）
- 改进建议：参考 Plan Phase 2 任务 6，改用 `meta` 上的布尔标记（例如 `readOnlyIntersectionWarned?: Record<string, boolean>`）做 per-stage 一次性去重，并保留 `__resetReadOnlyIntersectionWarned` 测试钩子或改为 meta 级重置。

### 问题 2
- 问题: `src/core/tool-guard.ts:958-987`（write/edit 路径）与 `:338-360`（bash 路径）— read-only 命中时 `checkStageWriteBlock` 统一返回 `status: "block"`，随后被当作「stage whitelist block」处理：当 `config.protect?.ask === true` 且 `isPathProtectedForModify(relPath, state)` 为真时，会弹出 ask 对话框，用户选择 allow 即可**绕过 read-only 保护**。read-only 的语义应是「即便 allowedWritePaths 允许也禁止写入」，但当前实现允许在受保护路径（hardcoded / gitignored）场景下被 ask 覆盖。默认模板 `protect.ask: true`，一旦业务项目将 `docs/` 加入 gitignore，plan 文档保护即可被覆盖。
- 等级：LOW
- 符合规划：部分符合（Plan 只要求"block with reason"，未要求绝对不可覆盖）
- 是否修复：无需修复（LOW）
- plan是否覆盖
  - 已覆盖：Phase 2 任务 5
- 改进建议：可参考 Plan Phase 2 任务 5，为 read-only 命中返回独立的 block 类别（不进入 ask 分支）以强化保证；或明确接受与 whitelist block 同语义。

### 问题 3
- 问题: `src/types.ts:187` — `allowedWritePaths?: string[];` 行首缩进被改为 3 个空格（`   allowedWritePaths`），与同块其它成员（2 空格）不一致。为 Phase 2 编辑引入的纯格式问题。
- 等级：LOW
- 符合规划：否
- 是否修复：无需修复（LOW）
- plan是否覆盖
  - 未覆盖：Plan 未涉及该行缩进，属编辑副作用
- 改进建议：恢复为 2 空格缩进。

### 问题 4
- 问题: `src/core/agent-settled.ts:151,172` — Phase 0 新增的两段代码各自调用一次 `detectSessionRole(ctx)`（consume 块与 sync 块），同一 settle 流程内重复计算。
- 等级：LOW
- 符合规划：符合（Plan 未禁止）
- 是否修复：无需修复（LOW）
- plan是否覆盖
  - 已覆盖：Phase 0 任务 1/2
- 改进建议：可参考 Plan Phase 0 任务 2，将 `const { isChild } = detectSessionRole(ctx)` 提升为一次计算后在两个分支复用。

### 问题 5
- 问题: `src/utils/protect.ts:147-211` — Plan Phase 2 任务 4 要求 `isPathReadOnly` "Uses the same `normalizeAllow` + `isPathAllowed` matching as `isPathAllowedWrite`"，实现却新增了独立的 `globToRegExp` 分支。这是为满足「glob support」与默认值 `docs/design/*_plan*.md` 所必需的合理取舍（若严格按 Plan 的 prefix/exact 匹配，默认 glob 将永不命中），但与任务 4 的字面要求存在偏差，且造成 `allowedWritePaths`（不支持 glob）与 `allowedReadOnlyPaths`（支持 glob）匹配语义不对称。
- 等级：LOW
- 符合规划：部分符合（Plan 自身任务 4 与 Goal「glob support」存在矛盾）
- 是否修复：无需修复（LOW）
- plan是否覆盖
  - 已覆盖：Phase 2 任务 4 / Goal
- 改进建议：可参考 Plan Phase 2 任务 4，保留 glob 支持但将 `globToRegExp` 抽为 `protect.ts` 共享工具并考虑让 `isPathAllowedWrite` 复用，消除两套匹配语义的不对称。

### 问题 6
- 问题: `src/core/tool-guard.ts:145-176` — 交集检测对 develop/fix 会**必然命中**：默认 `STAGE_TYPE_TOOL_DEFAULTS` 中 develop/fix 的 `allowedWritePaths = ["**"]`（`ALLOWED_WRITE_ALL`），`normalizedWrite === null → hasOverlap = true`。因此每次 pipeline 运行到 develop 首次工具调用时都会写 `readonly_write_intersection_warning` 审计并弹出 TUI 告警。虽然与 Plan「intersection exists → warn」一致，但把「write-all + read-only 例外」这一**正常配置**当作 overlap 异常告警，属于噪声。
- 等级：LOW
- 符合规划：是（Plan 未区分正常/异常 overlap）
- 是否修复：无需修复（LOW）
- plan是否覆盖
  - 已覆盖：Phase 2 任务 6
- 改进建议：可参考 Plan Phase 2 任务 6，将 write-all（`**`）情形排除出 overlap 判定，仅对显式列出的 write 路径与 read-only 路径的真实前缀/模式重叠告警。

### 问题 7
- 问题: `src/core/json-config-loader.ts:623-643` — 新增 `parseAllowedReadOnlyPaths` 使用 `console.warn`，而 `code_spec.md` §4 要求后端日志统一走 `logger` 模块。该文件既有 40+ 处 `console.warn`，本次改动与既有约定保持一致，属历史遗留风格而非本次回归。
- 等级：LOW
- 符合规划：符合（与既有文件模式一致）
- 是否修复：无需修复（LOW）
- plan是否覆盖
  - 未覆盖：Plan 未提及日志通道
- 改进建议：无需针对本 Phase 修复；如需收敛，可在后续独立任务中统一迁移该文件到 `logger`。
