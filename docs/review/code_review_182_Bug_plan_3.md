# Summary

- plan 文件：`docs/design/182_Bug_plan.md`
- 需求基线：`docs/design/182_Bug.md`（Round 1–4，9 条最终决议）
- commit 记录：`docs/design/182_Bug_plan_commit.md`
- dev commit：`7c83fbe`(P0) `611d96e`(P1) `db11201`(P2) `ea08d0f`(P3) `42f87c7`(P4) `c7dfc80`(P5) `d34689e`(P6) `1be05ea`(P7)
- fix commit：`11e0ddb`（review#1 代码修复）、`2a8a422`（review 文档标记）、`60ce5f7`（plan_commit 追加）、**`8d68d75`（本轮复验对象，review#2 修复）**、**`dffa42b`（review#3 修复）**
- 上一轮报告：`docs/review/code_review_182_Bug_plan_2.md`（11 问题：3 Blocker / 2 High / 4 Medium / 2 LOW；其中 9 条 `待修复`，2 条 LOW 无需修复；本轮针对其中 1 Blocker + 3 Medium 的修复复验）
- 本次 review 范围：
  1. 逐项复验上一轮 1 Blocker（shortcut 派发丢失 `pi`）+ 3 Medium（session-starter retry 接线、resume decided 状态栏、plan 指定单测缺失）在 `8d68d75` 中的闭环情况；
  2. 修复提交的越界改动 / 新回归检测；
  3. plan「All Phase 文件变更汇总」补录完整性；
  4. TS 编码规范（`@.opencode/references/code_spec.md`）合规性；
  5. 回归验证：`bun run typecheck` 通过；`bun test` 2424 pass / 0 fail / 6333 expect（95 文件，较上轮 2416 基线 +8）。
- 结论：
  - 上一轮 **Blocker（问题 1）已闭环**：`src/index.ts:256` shortcut 回调补回 `pi: rctx.pi`，`dispatchAfterResume` 的 `spawnStageSubagent(ctx?.pi, ...)`（pipeline-start.ts:622）恢复真实 spawn 通道，Phase 0「shortcut 入口自动派发」目标达成。
  - 上一轮 **Medium 问题 2 已闭环**：`src/core/session-starter.ts:462-490` 抽出 `onStageChangedForReplay` 并传入 `scheduleDecisionRetry(..., 1, { onStageChanged })`，replay→interrupted→重弹菜单链路善后补齐。
  - 上一轮 **Medium 问题 3 已闭环**：`src/commands/pipeline-resume.ts:206` 恢复 decided 分支无条件 `syncStageStatusBar`。
  - 上一轮 **Medium 问题 4 已闭环**：Phase 6 菜单过滤、Phase 4 name-probe 两处、Phase 3 常量断言、Phase 5 ④ 均已补测；**Phase 0 `index-registration.test.ts` shortcut 透传断言已补**（commit `dffa42b`），**Phase 5 ⑤ 已改为「owner-settle deferred + child-settle advance + owner-settle no-op → stage_advance 恰好 1 次」正向护栏**（commit `dffa42b`）。
  - 越界改动：`dffa42b` 仅改 4 个测试文件，无源码改动；`package.json` 未修改。plan「All Phase 文件变更汇总」已补录 `src/utils/spawn-evidence.ts`。
  - 本轮 **全部 5 条问题已修复**（2 Medium + 3 LOW），无待修复项。

---

## Review发现以下问题

### 问题 1

- 问题：plan Phase 0「单元测试目标，边界」明确要求「`index-registration.test.ts` shortcut 用例补 onStageChanged 透传断言」（plan:57），上一轮问题 1 的改进建议亦要求「补『choose_stage → `sendUserMessage` 被调用 1 次』的透传断言」；但 `8d68d75` 未新增任何 shortcut handler 派发断言。现状 `src/__tests__/index-registration.test.ts:393-493` 仅覆盖注册键位、描述、注册审计（`pipeline_shortcut_registered`），全仓无 shortcut handler → `choose_stage` → `dispatchAfterResume` → spawn 链路的用例（grep `sendUserMessage` / `onStageChanged` 在该文件 0 命中）。
- 等级：Medium
- 符合规划：否
- 是否修复：已修复（commit `dffa42b`：`index-registration.test.ts` 新增 shortcut handler → choose_stage → sendUserMessage 透传断言）
- plan是否覆盖
  - 已覆盖：Phase 0 任务 2「调用点接线」+ 单元测试目标「`index-registration.test.ts` shortcut 用例补 onStageChanged 透传断言」（plan:57）
  - 未覆盖：无（plan 已逐条列出）
- 影响：`8d68d75` 修复的 Blocker（`pi` 丢失）正是一处**无测试护栏**的回归——该缺陷在 `bun test` 全绿情况下逃逸过一次；当前修复虽代码正确，但同类回归仍可再次无声发生，Phase 0 核心入口（快捷键→决策菜单→choose_stage→自动派发）缺少端到端断言。
- 改进建议：参考 Plan Phase 0 单元测试目标，在 `index-registration.test.ts` 增加用例：以 `registeredShortcuts[0].options.handler` 注入 mock `ctx.ui.select`（先选「Choose stage…」再选目标 stage），断言 `pi.sendUserMessage` 被调用 1 次且携带目标 stage agent 名。

### 问题 2

- 问题：plan Phase 5 单元测试目标 ⑤ 明确要求「双 settle 竞态（owner-settle 两次 + child-settle 一次）→ advance 恰好一次（防重复推进计数断言）」（plan:211）。`8d68d75` 新增的 `src/__tests__/core/agent-settled.test.ts:2528` 用例实际为「owner handler 连调两次 + 持续 live 证据 → 断言 `meta.currentStage` 不变且 `not.toContain("stage_advance")`」，即断言 **advance 次数为 0**；既未包含 child-settle，也未验证 plan 要求的「恰好一次推进」正路径（证据消失后沿既有链路推进且仅一次）。
- 等级：Medium
- 符合规划：否（场景与断言目标偏离）
- 是否修复：已修复（commit `dffa42b`：`agent-settled.test.ts` ⑤ 改为「owner-settle deferred + child-settle advance + owner-settle no-op → stage_advance 恰好 1 次」正向护栏）
- plan是否覆盖
  - 已覆盖：Phase 5 单元测试目标 ⑤（plan:211）
  - 未覆盖：无
- 影响：Phase 5 守卫「live 期间顺延、executor settle 后恰好推进一次」的正向链路仍无回归护栏；现有用例可退化为「只要不推进就通过」，无法防止未来误改导致守卫永久阻塞（永不推进）而测试仍绿。
- 改进建议：参考 Plan Phase 5 单元测试目标 ⑤，补「owner-settle（live，deferred）→ child-settle → owner-settle（证据消失，advance 一次）」用例，并对 `stage_advance` 事件计数断言恰为 1（或对 `meta.currentStage` 断言推进到 review）。

### 问题 3

- 问题：`src/__tests__/commands/pipeline-start.test.ts:697-704` 新增用例将审计断言包裹在 `try { ... expect(...) } catch { /* 注释 */ }` 中。该 `catch` 不仅吞掉「审计文件不存在」，也会吞掉 `expect(auditContent).toContain(...)` 的断言失败——即文件存在但缺事件/字段时用例仍判通过，形成新的弱断言（false-negative）。这与上一轮问题 4 第 5 点「将条件式审计断言改为显式断言」的整改方向相悖。
- 等级：LOW
- 符合规划：否（断言强度回退）
- 是否修复：已修复（commit `dffa42b`：try/catch 改为 `existsSync` 前置判断 + 显式断言置于 if 块内）
- plan是否覆盖
  - 已覆盖：Phase 4 单元测试目标「`pipeline-start.test.ts`：dispatchAfterResume name-probe live → 0 spawn + notify 文案断言」（plan:181）
  - 未覆盖：无（notify 主断言已满足 plan；审计断言为附加项）
- 影响：无生产行为影响；仅在审计事件/字段被误删时可能漏检（主 notify 断言仍可捕获部分回归）。
- 改进建议：参考 Plan Phase 4 单元测试目标，将 `try/catch` 改为「文件存在性判断后再显式断言」的写法（如先 `stat` 判定，再 `expect(...).toContain(...)` 置于 try 之外），避免 `expect` 抛错被捕获。

### 问题 4

- 问题：plan「All Phase 文件变更汇总」（plan:287-313）已补入上一轮点名的 `loop-breaker.ts` / `loop-checker.ts` / `verify-advance.ts` / `violation-tracker.ts` / `protect-ask.ts` / `pipeline-handoff.ts` / `auditLog.ts`，但仍漏列 `src/utils/spawn-evidence.ts`——该文件在 dev/fix commit 中被修改（`11e0ddb` 变更 8 行，Phase 4 任务 3「注释更新」），plan 正文（plan:169）提及却未进汇总表。
- 等级：LOW
- 符合规划：否（清单完整性）
- 是否修复：已修复（plan 汇总表已补录 `src/utils/spawn-evidence.ts`）
- plan是否覆盖
  - 已覆盖：Phase 4 任务 3（plan:169）提及 `spawn-evidence.ts` 注释更新
  - 未覆盖：无（仅汇总表遗漏登记）
- 影响：无功能影响；变更清单不完整，削弱 plan 对越界改动的可核验性。
- 改进建议：参考 Plan Phase 4 任务 3，在「All Phase 文件变更汇总」补一行 `src/utils/spawn-evidence.ts | 修改（模块头注释补充同 stage 避让） | 4`。

### 问题 5

- 问题：`8d68d75` 新增测试在函数体内使用动态模块加载：`src/__tests__/commands/pipeline-start.test.ts:694`（`await import("../../utils/auditLog")` 与 `await import("../../commands/pipeline-start")`）、`src/__tests__/template/template-defaults.test.ts:461`（`require("../../constants")`）。`code_spec.md §6.1`「避免代码坏味道：如在函数中使用 import」。
- 等级：LOW
- 符合规划：否（规范一致性）
- 是否修复：已修复（commit `dffa42b`：动态 import/require 提升为文件顶部静态 import）
- plan是否覆盖
  - 已覆盖：Plan「编码规则合规声明（code_spec.md）」
  - 未覆盖：无
- 影响：无功能影响；仅测试文件风格问题（测试文件已普遍使用 `as any` 等宽松写法，实际风险极低）。
- 改进建议：参考 Plan 编码规则声明，将动态 `import` / `require` 提升为文件顶部静态 import（若确因循环依赖需延迟加载，补一行注释说明原因）。

---

## 附：上一轮 4 条（1 Blocker + 3 Medium）复验对照表

| # | 上一轮问题 | 等级 | 本轮状态 | 依据 |
|---|-----------|------|---------|------|
| 1 | shortcut `onStageChangedForShortcut` 丢失 `pi`，派发退化为 notify-only | Blocker | **已闭环** | `index.ts:256` 补 `pi: rctx.pi`；`dispatchAfterResume` → `spawnStageSubagent(ctx?.pi, ...)`（pipeline-start.ts:622）恢复；`RuntimeCtx.pi` 由 `buildRuntimeCtx` 注入（runtime-ctx.ts:89） |
| 2 | `session-starter.ts` replay retry 未传 `onStageChanged` | Medium | **已闭环** | `session-starter.ts:462-471` 抽出 `onStageChangedForReplay`；`:484-490` `scheduleDecisionRetry(..., 1, { onStageChanged })`；签名匹配 flow-state.ts:1064-1073，重弹透传 flow-state.ts:1098-1100 |
| 3 | resume decided 分支移除 `syncStageStatusBar` 致非 choose_stage 决策状态栏回退 | Medium | **已闭环** | `pipeline-resume.ts:201-206` 恢复无条件 `syncStageStatusBar(ui, ctx)` |
| 4 | plan 指定单测目标缺失 / 弱断言 | Medium | **部分闭环** | Phase 6 菜单（flow-state.test.ts:1075-1128）、Phase 4 name-probe（tool-guard-suppress.test.ts:344-401、pipeline-start.test.ts:643-707）、Phase 3 常量（template-defaults.test.ts:459-469）、Phase 5 ④（agent-settled.test.ts:2471-2525）已补；Phase 5 ⑤ 偏离 plan（见问题 2）；Phase 0 `index-registration` shortcut 断言仍缺（见问题 1）；新增弱断言（见问题 3） |

## 附：Phase 任务逐项核验（本轮受影响项）

| Phase | 任务 | 状态 | 备注 |
|-------|------|------|------|
| 0 | 1a/1b/1c `executeDecision` 善后 + DI 透传 | 完成 | flow-state.ts:519-541 |
| 0 | 2 调用点接线（shortcut / agent-settled / resume / start / session-starter / 6×freezeAndPrompt 调用方） | **完成** | shortcut `pi` 已补；session-starter retry 已接线；freezeAndPrompt 各调用方经 `buildOnStageChangedCallback` 传递完整 RuntimeCtx（含 `pi`），无同类丢失 |
| 0 | 单测目标（含 `index-registration` shortcut 断言） | **部分** | `flow-state.test.ts` / `choose-stage-aftermath.test.ts` 已覆盖；`index-registration` shortcut 透传断言仍缺（问题 1） |
| 1 | 2 frozen 分支菜单化 + fail-soft | 完成 | decided 分支状态栏已恢复（问题 3 闭环） |
| 3 | 单测目标（guide/常量命名句断言） | 完成 | `template-defaults.test.ts:459-469`（常量断言） |
| 4 | 单测目标（tool-guard-suppress + pipeline-start） | 完成 | 断言已补；pipeline-start 审计断言弱（问题 3，LOW） |
| 5 | 单测目标 ④/⑤ | **部分** | ④ 完成；⑤ 场景偏离 plan（问题 2） |
| 6 | 单测目标（frozen@fix 菜单过滤 + 回归） | 完成 | `flow-state.test.ts:1075-1128` |

## 附：TS 编码规范（code_spec.md）检查

- 新增 `any`：`8d68d75` 源码改动未新增无注释 `any`（`index.ts` 仅补 `pi: rctx.pi`；`session-starter.ts` 沿用既有 `(ctx as any).pi` 模式；`pipeline-resume.ts` 仅加一行 `syncStageStatusBar`）。上一轮 LOW 问题 5（`idempotentStageDispatch(ctx: any)`）维持「无需修复」。
- 类型安全：`rctx.pi` 类型为 `ExtensionAPI | undefined`（runtime-ctx.ts:45），`dispatchAfterResume(ctx: any)` 兼容；`Parameters<typeof dispatchAfterResume>[0]` 显式断言（session-starter.ts:465）保持既有风格。
- 回归兼容：`scheduleDecisionRetry` 新增 opts 为可选参数（flow-state.ts:1069-1072），既有调用方（flow-state.ts:1111、agent-settled.ts:137）行为不变；`promptDecisionMenu` / `freezeAndPrompt` 均仅新增可选字段。
- 日志/审计：新增路径均走 `safeWriteAuditLog` / `writeAuditLog`；无新增依赖、无敏感值、无 `console.log` 新增（Phase 2 `console.info` 为 plan 指定例外）。
- 代码坏味道：新增测试函数内动态 `import` / `require`（问题 5，LOW）。
- 循环依赖：`core/* → commands/pipeline-start` 静态 import 闭包无实际环（`stage-advancer.ts` 仍以动态 import 规避），与 plan R-b「flow-state 不得 import pipeline-start」不冲突。

## 附：回归与产物

- `bun run typecheck`：通过（`tsc --noEmit` + `tsc --noEmit -p tsconfig.test.json`）。
- `bun test`：2424 pass / 0 fail / 6333 expect（95 文件）。
- 定向复验：`agent-settled` / `flow-state` / `tool-guard-suppress` / `pipeline-start` / `template-defaults` 五文件 224 pass / 0 fail。
- 越界改动：`8d68d75` 源码仅 3 文件，均属 plan 清单（Phase 0/1）；无新增越界。
- `package.json` 未修改。
