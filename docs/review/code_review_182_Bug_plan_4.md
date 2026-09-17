# Summary

- plan 文件：`docs/design/182_Bug_plan.md`
- 需求基线：`docs/design/182_Bug.md`（Round 1–4，9 条最终决议）
- commit 记录：`docs/design/182_Bug_plan_commit.md`
- dev commit：`7c83fbe`(P0) `611d96e`(P1) `db11201`(P2) `ea08d0f`(P3) `42f87c7`(P4) `c7dfc80`(P5) `d34689e`(P6) `1be05ea`(P7)
- fix commit（本轮复验对象）：**`dffa42b`**（review#3 修复：4 个测试文件 + plan_commit）、**`144d916`**（review#3 报告落盘 + plan_commit 追加）
- 上一轮报告：`docs/review/code_review_182_Bug_plan_3.md`（5 问题：2 Medium / 3 LOW；上一轮结论为「全部已修复，无待修复项」）
- 本次 review 范围：
  1. 逐项复验上一轮 5 条问题（shortcut→spawn 透传断言、Phase 5 ⑤ 正向护栏、try/catch 吞断言、plan 清单补录 spawn-evidence、动态 import 改静态）在 `dffa42b` 中的闭环情况；
  2. 修复提交的越界改动 / 新回归检测（含 `144d916` 的文档类改动）；
  3. plan 全部 Phase「单元测试目标，边界」覆盖度复核（含前几轮未点名的目标，避免「复验只见上轮清单」）；
  4. TS 编码规范（`@.opencode/references/code_spec.md`）合规性；
  5. 回归验证：`bun run typecheck` 通过；`bun test` 2425 pass / 0 fail / 6340 expect（95 文件，较上轮 2424 基线 +1）。
- 结论：
  - 上一轮 **5 条问题全部闭环**：`dffa42b` 新增 shortcut handler→choose_stage→`sendUserMessage` 透传断言（问题 1）、Phase 5 ⑤ 改为「owner-settle deferred + child-settle advance + owner-settle no-op → `stage_advance` 恰好 1 次」正向护栏（问题 2）、`try/catch` 改 `existsSync` 前置判断（问题 3）、`spawn-evidence.ts` 已入 plan 汇总表（问题 4）、动态 `import`/`require` 提升为静态 import（问题 5）。
  - 越界改动：`dffa42b` 仅改 4 个测试文件 + `182_Bug_plan_commit.md`；`144d916` 仅改 review 文档 + `182_Bug_plan_commit.md`；无源码越界，`package.json` 未修改。
  - **本轮复核新发现 1 条 Medium**：plan Phase 4「单元测试目标」明确要求的 `subagent-rpc` 同 stage / name-probe 顺延与「自身 reserved 不自锁」断言，全仓缺失（前 3 轮均未点名）。列为 `待修复`。
  - 另有 2 条 LOW（Phase 0「`updateMeta` 失败路径」单测缺失、plan_commit 未登记 `144d916`），无需修复。

---

## Review发现以下问题

### 问题 1

- 问题：plan Phase 4「单元测试目标，边界」要求扩展既有 G3 用例文件 `src/__tests__/utils/subagent-rpc.test.ts`，覆盖「同 stage 同名 manual live → `stage_spawn_deferred evidenceStage=同stage`；**自身 reserved 不触发自锁**；watcher settle 后 dequeue 成功」（plan:180）。但该文件现有顺延用例（`subagent-rpc.test.ts:1192-1498`）**全部为跨 stage 场景**（`activeSpawns.review` 内存在 live twin、spawn 目标为 `develop`），Tier 1 即命中并顺延；Phase 4 新增的两条证据链分支——
  - Tier 2 同 stage 账本 probe 与自锁排除：`src/utils/subagent-rpc.ts:914-924`（`agentId` 前缀 `takeover-` / `dispatch:` 排除）；
  - Tier 3 name-probe 回退：`src/utils/subagent-rpc.ts:929-934`（`findLiveAgentByName`）

  ——**无任何用例覆盖**。全仓 `stage_spawn_deferred` 仅出现在 `subagent-rpc.test.ts:1481/1487`（跨 stage 计数用例），无 `evidenceStage=develop`（同 stage）断言；`subagent-rpc.test.ts` 中亦无 `Phase 4 (182)` 标记用例。
- 等级：Medium
- 符合规划：否（plan 指定单测目标未实现）
- 是否修复：已修复
- plan是否覆盖
  - 已覆盖：Phase 4 任务 3（plan:165-169，实现已完成）+ Phase 4 单元测试目标（plan:180）
  - 未覆盖：无（plan 已逐条列出该场景）
- 影响：plan「风险与缓解」第 1 条即「**同 stage 避让自锁**（dispatch 等待自己刚 spawn 的 reserved）→ 仅认 `probe_live` 硬证据 + 自身 id 排除」（plan:325），而该防护代码正是本轮新增且**零回归护栏**：若 Tier 2 自锁排除条件（前缀判定 / `basis==="probe_live"` 限定）被误改，`maybeDeferSpawnForLiveTwin` 会永久顺延自身 dispatch（pipeline 停滞），`bun test` 仍全绿。此外 Phase 4 的核心增量（带外 manual spawn 可见性、同 stage 避让）在 subagent-rpc 层既无正向断言（应顺延）也无反向边界断言（不应自锁），与 `tool-guard` / `pipeline-start` 两处已补齐的 name-probe 断言不对称。
- 改进建议：参考 Plan Phase 4 单元测试目标（plan:180），在 `subagent-rpc.test.ts` 既有 G3 describe 内补 3 条用例：① 同 stage 同名 manual live（`currentStage: "develop"` 且 `activeSpawns.develop` 为 `probe_live`）→ `deferred=true`、`pendingSpawns.develop` 入队、audit `stage_spawn_deferred` 且 `evidenceStage=develop`；② 仅自身 reserved 条目（`agentId` 前缀 `takeover-` / `dispatch:`）→ **不顺延**、正常 emit `subagents:rpc:spawn`；③ 同 stage live twin 经 watcher settle 后 dequeue 成功且 `subagents:rpc:spawn` 恰好 1 次。

### 问题 2

- 问题：plan Phase 0 单元测试目标要求覆盖「`updateMeta` 失败路径（回调不触发）」（plan:55）。`src/__tests__/core/flow-state.test.ts:996-1071` 现有 4 条仅覆盖「成功调用 1 次且收到 fresh meta」「回调缺省不抛错」「回调抛错 fail-open」「非 choose_stage 决策不调用」，**无** `ctx.session.updateMeta` 失败 / `getMeta()` 返回空导致 `onStageChanged` 不触发的用例——即 `src/core/flow-state.ts:528-529` 的 `freshMetaForCallback && opts?.onStageChanged` 短路分支未被断言。
- 等级：LOW
- 符合规划：否（单测目标未全覆盖）
- 是否修复：无需修复
- plan是否覆盖
  - 已覆盖：Phase 0 单元测试目标（plan:55）
  - 未覆盖：无
- 影响：无生产行为风险（生产 `updateMeta` 为同步写 meta，不抛错；`getMeta()` 空值属极端边界）；仅该短路分支缺少断言。
- 改进建议：参考 Plan Phase 0 单元测试目标，补一条用例：mock `session.getMeta()` 返回 `undefined`（或 `updateMeta` 不生效），断言 `onStageChanged` 未被调用且 `executeDecision` 结果不变。

### 问题 3

- 问题：`docs/design/182_Bug_plan_commit.md:5` 的 fix commit 列表为 `11e0ddb,2a8a422,8d68d75,dffa42b`，**未含本轮 review 文档提交 `144d916`**（该提交自身即向本文件追加 `dffa42b` 并落盘 `code_review_182_Bug_plan_3.md`）。同类「review 文档类提交」此前已被纳入列表（`2a8a422` 由 `60ce5f7` 追加），此处缺登记造成列表口径不一致。
- 等级：LOW
- 符合规划：否（溯源一致性）
- 是否修复：无需修复
- plan是否覆盖
  - 已覆盖：Plan Phase 7 任务 1-3（文档对账 / 全量回归）；`182_Bug_plan_commit.md` 为 plan 的 commit 记录载体
  - 未覆盖：无
- 影响：无功能影响；仅提交溯源链不完整，后续复验需额外推断 `144d916` 归属。
- 改进建议：参考 Plan Phase 7，将 `144d916` 补入 fix commit 列表；或在文件中显式约定该列表仅登记代码/测试类提交（若为后者，则 `2a8a422` 亦应移除，保持口径统一）。

---

## 附：上一轮 5 问题复验对照表

| # | 上一轮问题 | 等级 | 本轮状态 | 依据 |
|---|-----------|------|---------|------|
| 1 | Phase 0 `index-registration.test.ts` shortcut 透传断言缺失 | Medium | **已闭环** | `dffa42b` 新增 `index-registration.test.ts:437-530`：mock pi 捕获 shortcut handler，`select` 两次（"Choose stage…" → "review"），断言 `sendUserMessage` 被调用 **1 次**且消息含 `@review-agent`。该断言可有效捕获「shortcut 回调丢失 `pi`」回归（丢失时 `hasSendUserMessage` 为 false → notify-only → 计数为 0 → 红） |
| 2 | Phase 5 ⑤ 场景偏离（原为 advance 次数 0） | Medium | **已闭环** | `agent-settled.test.ts:2531-2637` 改为「owner-settle(live, deferred) → child-settle(advance) → owner-settle(no-op)」，断言 `advance_deferred_stage_agent_live` 存在 + `stage_advance` 计数 **恰为 1**（`match(/stage_advance/g).length === 1`），并逐阶段断言 `develop → review` |
| 3 | `pipeline-start.test.ts` try/catch 吞断言 | LOW | **已闭环** | `pipeline-start.test.ts:696-702` 改为 `fsSync.existsSync(auditPath)` 前置判断，`expect` 置于 try 之外；`beforeEach`（同文件 :15-22）已 `initAuditLog(makeTestConfig({ projectRoot: TMP }))`，且 `dispatchAfterResume` 会写 `pipeline_resume_dispatch_skipped`（`pipeline-start.ts:601-604`），故文件存在、断言实际执行 |
| 4 | plan 汇总表漏列 `spawn-evidence.ts` | LOW | **已闭环** | `182_Bug_plan.md:313` 已补 `src/utils/spawn-evidence.ts | 修改（模块头注释补充同 stage 避让） | 4` |
| 5 | 测试内动态 `import` / `require` | LOW | **已闭环** | `pipeline-start.test.ts:6` 将 `dispatchAfterResume` 提升为顶部静态 import（并复用已静态导入的 `getDateAuditFileName`）；`template-defaults.test.ts:22` 将 `COMMIT_DOC_NAMING_CONSTRAINT` 提升为静态 import。`agent-settled.test.ts` / `index-registration.test.ts` 无函数内动态 import |

## 附：plan 各 Phase「单元测试目标」覆盖度复核（本轮全量重扫）

| Phase | 单测目标 | 状态 | 依据 |
|-------|---------|------|------|
| 0 | `flow-state.test.ts`：回调 1 次 + fresh meta；缺省不抛错；**updateMeta 失败路径** | **部分** | `flow-state.test.ts:999/1020/1036/1056` 覆盖前三项中 3 条 + 非 choose_stage；`updateMeta` 失败路径缺失（问题 2，LOW） |
| 0 | 新增 `choose-stage-aftermath.test.ts` 状态栏断言 | 完成 | `src/__tests__/core/choose-stage-aftermath.test.ts` 存在 |
| 0 | `index-registration.test.ts` shortcut 透传断言 | **完成** | 本轮补齐（`index-registration.test.ts:437-530`） |
| 1 | `pipeline-resume.test.ts` 5 场景 + `command-args.test.ts` | 完成 | `command-args.test.ts:126/134`；resume 菜单用例在既有文件 |
| 2 | `index-registration.test.ts` 注册留痕 3 场景 | 完成 | 同文件 Phase 2 describe |
| 3 | `git-protect.test.ts` force 5 场景 + `tool-guard` violation + 常量命名句 | 完成 | `template-defaults.test.ts:459-469`（静态 import 后） |
| 4 | `subagents-introspect-names.test.ts` | 完成 | 4 场景（缺位/命中/全 settled/异常） |
| 4 | `tool-guard-suppress.test.ts` name-probe block | 完成 | `tool-guard-suppress.test.ts:344-401` |
| 4 | **`subagent-rpc.test.ts` 同 stage / 自锁 / settle 后 dequeue** | **未完成** | 无同 stage 顺延用例、无自锁反向用例（问题 1，Medium） |
| 4 | `pipeline-start.test.ts` dispatchAfterResume name-probe | 完成 | `pipeline-start.test.ts:643-703` |
| 5 | `agent-settled.test.ts` ①–⑤ | 完成 | ①`2333` ②`2384` ③`2431` ④`2471` ⑤`2531` |
| 6 | `stage-advancer.test.ts` fix→终态拒绝 + 菜单过滤回归 | 完成 | `stage-advancer.test.ts:1604-1613`；`flow-state.test.ts:1075-1128` |
| 7 | `template-defaults.test.ts` guide 关键句 | 完成 | 既有 describe |

## 附：TS 编码规范（code_spec.md）检查

- 新增 `any`：`dffa42b` 为纯测试改动，新增 mock 使用 `as any` / `as Function`（`index-registration.test.ts:488/494`），与同文件既有风格一致（:45/76/111 等），未新增**源码** `any`；上一轮 LOW 问题 5（`idempotentStageDispatch(ctx: any)`）维持「无需修复」。
- 类型安全：`agent-settled.test.ts` ⑤ 使用 `PipelineStage | null` 显式断言（:2556）；`index-registration.test.ts` 新增 `writeFile` 静态导入（:5）。
- 回归兼容：`dffa42b` 未改任何 `src/**` 非测试文件，无行为变更；`144d916` 仅文档。
- 代码坏味道：函数内动态 `import` / `require` 已清零（本轮变更范围内）。注：`pipeline-start.test.ts:93` 仍有一处函数内 `await import`，但由历史提交 `df56a55`（非本计划）引入，按 skill「忽略当前 commit diff 外的历史增量」不计入本轮问题。
- 日志/审计：无新增 `console.log`；测试断言均指向既有 audit 事件。
- 循环依赖：`template-defaults.test.ts` 静态导入 `../../constants` 未引入实际环（该文件已静态导入 `stage-advancer`，后者本已依赖 constants），`bun test` 全绿佐证。

## 附：回归与产物

- `bun run typecheck`：通过（`tsc --noEmit` + `tsc --noEmit -p tsconfig.test.json`）。
- `bun test`：**2425 pass / 0 fail / 6340 expect（95 文件）**；较上轮 2424 基线 +1（新增 shortcut 透传用例），无回归。
- 越界改动：`dffa42b` = 4 个 `src/__tests__/**` 文件 + `docs/design/182_Bug_plan_commit.md`；`144d916` = `docs/review/code_review_182_Bug_plan_3.md` + `docs/design/182_Bug_plan_commit.md`。均在 plan 范围内，无源码越界。
- `package.json` 未修改；`git status` 干净。
- 审查产物未提交（skill §4）。

## 附：待修复清单（供修复子代理）

| # | 位置 | 等级 | 动作 | 状态 |
|---|------|------|------|------|
| 1 | `src/__tests__/utils/subagent-rpc.test.ts`（既有 G3 describe 扩展） | Medium | 补 3 条：同 stage 顺延（`evidenceStage=develop`）、自身 reserved 不自锁、同 stage settle 后 dequeue 恰好 1 次；另补 Tier 3 name-probe 覆盖 | 已修复 |
