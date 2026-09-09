# Summary
- Plan 文件：`docs/design/173_E2E_Bug_plan.md`（C1-C17，P0-P6）；需求 `docs/design/173_E2E_Bug.md`；跟踪文件 `docs/design/173_E2E_Bug_plan_commit.md`
- 审查范围：第 3 轮 fix-loop 复核，覆盖 fix commit `a541d76` 后的 HEAD 状态（base `d679ef9` 起全链 + 两轮 fix commits `31f6391`、`a541d76`）。
- 实测复核：HEAD `bun run typecheck` 0 错、`bun run build` 0 错、`bun test` **1991 pass / 0 fail / 5084 expect / 81 files**（1964→1991 = a541d76 净增 +27，计数单调只增不减；`review3-fixes.test.ts` 单跑 27 pass / 64 expect，非空跑）。
- 范围合规：`d679ef9..HEAD` 变更仅落在 `src/`、`docs/design/`、`AGENTS.md`（含新增 `src/__tests__/review3-fixes.test.ts`、`src/core/dormancy.ts` 等）；package.json / bun.lock / .opencode / dist/ 零改动；无新依赖；`origin/main..HEAD` = 1（仅 `a541d76` 未 push，符合不 push 纪律）；工作树实际干净（git status clean——任务描述所称 plan_commit.md 未提交追加并不存在，按实际内容核对）。
- 逐项核验结论：第 2 轮问题 1-4 修复**主体真实落地**（27 新增用例大多有效；directStageSelect/promptStageSelection 语义正确；protect-ask noUi 不增 dismissCount + noUi/hostRole 审计齐备；source 缺省 "menu"、startup 重放 "replay"、notify 含 basis 全部符合 plan）。但问题 1（测试欠交）仍有**遗留缺项**，问题 4 的 source 字段只补了 3/6 分支；另发现 2 项历轮未覆盖的 plan §3.3-④ 偏差与 1 项二级菜单 dismiss 归类缺陷。第 2 轮问题 5/6（Low）仍存，维持 Low。

## Review发现以下问题

### 问题 1
- 问题：第 2 轮问题 1（测试欠交）经 `a541d76` 补 27 用例后**主体修复但仍缺项**，对照 plan Phase 2b/3/4/5 测试点清单逐项复核，以下项仍无有效测试（含"空跑/夹具自洽"残留）：
  1. **C15 spawnTrigger 真实行为测试仍缺失**（plan Phase 5 "C15 双场景（auto/manual）+ F1 双场景回归钉"）：`src/__tests__/template/template-defaults.test.ts:120-152` 仍是夹具自洽（只断言 `activeSpawns` 已定义/时间窗 <5min，从不调用私有 `inferSpawnTrigger`（session-starter.ts:117）也不驱动 JOIN 审计）；全库无任何测试断言 `session_join_parent` 审计含 `spawnTrigger=pipeline_auto|manual_or_external`（session-starter.test.ts:880-913 只断言 `session_join_parent` 存在）。
  2. **C11 消费者级回归钉仍缺失**：`src/__tests__/review3-fixes.test.ts:296-327` 标题自称 "tool-guard consumer"，但只直接调 `askProtectDecision` ×3——violations 本就只在 tool-guard 消费点（tool-guard.ts:252/279/422/700/732/767 的 `outcome.action !== "dismissed"` 守卫）记录，直接调 ask 函数**永远不增 violations**：若回滚 31f6391 的 6 处消费点守卫，本用例依然通过。plan Phase 4 测试点"dismissed 零 violation 但 block 保持 + 连续 3 次 dismiss 不触发 violation_overflow"未有真实消费者级断言。
  3. **DORMANT_KEEP_PROTECTION=true 行为变体测试缺失**（plan Phase 2b 测试点）：dormancy.test.ts:78-86 仅钉存在性与 false，工具层"保护链在、静默面静默"变体无行为测（常量不可运行时翻转，需测试注入面或导出开关函数）。
  4. **C14 guide drift 提示、C10① UI-select 就地弹菜单、D2 superseded 文案正向断言缺失**：session-starter.ts:293-296 / pipeline-status.ts:39-52 的 `re-run /pipeline-init` 提示、pipeline-start.ts:992-1036 的 UI 分支 select 路径、pipeline-start.ts:697-698 的 superseded 后缀均无对应测试（pipeline-start.test.ts:280-300 只测 no-UI 降级、:786-787 只断言反面"不包含 already completed"）。
  5. **choose_stage 跳段语义测试不实/不全**：review3-fixes.test.ts:75-107 "forward: marks skipped summaries" 因目标 review 与冻结点 develop 相邻、夹具 summaries 又全在冻结点之前，`skipped` 标记循环 0 次迭代——**该用例从未真正断言 skipped 标记**（标题与断言强度不符）；plan Phase 3 测试点"completed→compact 调用 1 次"（executeDecision :477-483 通道）无任何用例。
- 等级：Medium
- 符合规划：否（plan §3.2 单测增量表 Phase 2b/3/4/5 测试点清单仍有未交付格；上轮问题 1 标记"已修复"不完整）
- 是否修复：已修复（fix commit `0881206`：补 C15 真驱动测 2 例 + C11 消费级回归测 + DORMANT_KEEP_PROTECTION 导出 + C14 drift 提示 + C10① UI-select 恰一次 + D2 superseded 文案 + forward-skipped 夹具修正 + choose_stage→completed→compact 路径；review3-fixes.test.ts 二级 Esc 用例同步为慢 Esc ≥1500ms）
- plan是否覆盖
  - 已覆盖：`173_E2E_Bug_plan.md` §3.2 单测增量表、Phase 4 测试点（noUi 不增 dismissCount、dismissed 零 violation）、Phase 5 测试点（C15 双场景、drift 8 资产）、Phase 3 测试点（completed→compact、推断链逐级、重放矩阵）
  - 未覆盖：无（全部为已列测试点的执行缺口）
- 改进建议：按 plan Phase 2b/3/4/5 补齐：①C15 通过 session-starter `handleSubagentJoin`（或等效）驱动 JOIN 审计断言 `spawnTrigger=` 两值（F1 双场景夹具现成）；②C11 补 tool-guard 消费级用例（mock ctx + select 立即 undefined ×3 → 断言 `meta.violations` 仍空且不 violation_overflow）；③DORMANT_KEEP_PROTECTION=true 用测试注入/翻转方式补工具层行为测；④补 C14 drift 提示、C10① UI-select 恰一次、D2 superseded 正向文案断言；⑤修正 forward 用例夹具（补冻结点后 intermediate 段 summary 断言 skipped）并补 choose_stage→completed→compact 恰 1 次用例。

### 问题 2
- 问题：executeDecision 审计 source 字段只落地 resume/restart/choose_stage 三分支，**skip/rollback/abort 三分支审计行仍无 source 字段**：flow-state.ts:244-250（skip）、:298-304（rollback）、:392-401（abort）的 `safeWriteAuditLog("pipeline_decision", …)` 均未写 `...(opts?.source ? { source: opts.source } : {})`（resume :205、restart :348、choose_stage :474 已有）。plan §3.3-④ 明列"审计行 :176/221/275/310/334 **统一条件写 source 字段**"。当前无论 menu（promptDecisionMenu 已默认 source="menu"）还是 shortcut（index.ts:267 传 source="shortcut"）触发 skip/rollback/abort，审计均无 source，破坏 C10④ 全通道 source 词表一致性（第 2 轮问题 4 只修了调用点缺省，未补三分支审计行）。
- 等级：Medium
- 符合规划：否（plan Phase 3 §3.3-④ "executeDecision 各分支 source 缺省补齐 … 审计行统一条件写 source 字段"）
- 是否修复：已修复（fix commit `0881206`：skip :247-250 / rollback :303-306 / abort :409-411 三分支审计行统一补 `...(opts?.source ? { source: opts.source } : {})` + 3 断言）
- plan是否覆盖
  - 已覆盖：plan Phase 3 §3.3-④（审计行 :176/221/275/310/334 列表）
  - 未覆盖：无
- 改进建议：按 plan Phase 3 §3.3-④ 在 skip/rollback/abort 三分支审计对象补 `...(opts?.source ? { source: opts.source } : {})`，并各加 1 断言（menu/shortcut/command 任一通道审计含 source）。

### 问题 3
- 问题：plan Phase 3 §3.3-④ "restart result message（:319）追加 '旧流进度不继承，断点续传请用 Choose stage'（英文落地）+ 旧流 id" **仍未实现**：flow-state.ts:377 restart 返回 `Pipeline restarted as "<newPipelineId>" at stage "clarify".`，既无 "progress not inherited / use Choose stage" 提示、也不含旧流 id（审计里虽有 newPipelineId，但 result message 无旧 id 对照）。该偏差经历第 1/2 轮均未被标记，属历轮漏检的 plan 交付项。
- 等级：Medium
- 符合规划：否（plan Phase 3 §3.3-④ restart 文案子项）
- 是否修复：已修复（fix commit `0881206`：restart result message 追加旧流 id + "Previous pipeline ... progress is not inherited — use Choose stage for resume"）
- plan是否覆盖
  - 已覆盖：plan Phase 3 §3.3-④
  - 未覆盖：无
- 改进建议：按 plan Phase 3 §3.3-④ 在 restart result message 追加旧流 id 与 "previous pipeline progress is not inherited — use Choose stage for断点续传" 英文落地文案。

### 问题 4
- 问题：二级 stage 菜单（promptStageSelection，flow-state.ts:797-811）**未区分 streaming dismiss（<1500ms interrupted）与真 Esc（canceled）**：`stageSelection === undefined` 一律 `clearDecisionTimer` + audit `pipeline_decision_cancelled` + 返回 `"cancelled"`，不复用第一级 :884-891 的 elapsed<1500ms → `pipeline_decision_interrupted` → retry 语义。后果：replay/owner settle 场景用户进入二级 choose_stage 列表后若被流式输出 0ms 吞掉菜单，返回 cancelled → session-starter.ts:388 只对 `"interrupted"` 臂 `scheduleDecisionRetry`，**重放/重弹的 retry 链就此终止**，冻结菜单不再自动复现——与 172-G5（第一级已修）及 plan §3.2"二级取消/Esc ⇒ 回退一级语义（retry 循环照旧）"不一致，属 C9 二级菜单引入、本轮 helper 抽取时原样保留的归类缺口（非 a541d76 新回归，但为 plan 语义未达）。
- 等级：Medium
- 符合规划：否（plan Phase 3 §3.2 二级取消语义回退一级 + 172-G5 interrupted 语义在二级的延续）
- 是否修复：已修复（fix commit `0881206`：promptStageSelection 记录 attemptAt，undefined 且 elapsed<1500ms 审计 pipeline_decision_interrupted(context=choose_stage_secondary) 并返回 "interrupted"；elapsed≥1500ms 走现有 cancelled 分支；补 0ms dismiss→interrupted + 慢 Esc→cancelled 双测）
- plan是否覆盖
  - 已覆盖：plan Phase 3 §3.2（二级 Esc 回退一级语义）、172-G5 interrupted 判定先例（flow-state :884-891）
  - 未覆盖：plan 未显式规定二级菜单 dismiss 分型——属 G5 语义在新增二级面上的应用缺口
- 改进建议：参照第一级实现：promptStageSelection 内记录 `attemptAt`，`undefined` 且 elapsed<1500ms 时审计 `pipeline_decision_interrupted`（context=choose_stage_secondary）并返回 `"interrupted"`（供 replay/freezeAndPrompt 臂重新 scheduleDecisionRetry）；elapsed≥1500ms 才走现有 cancelled 分支。补"二级 0ms dismiss → interrupted + retry 再弹"测试。

### 问题 5
- 问题：第 2 轮问题 5（跟踪文档账实不符）**仍存且新增一处**：① `docs/design/173_E2E_Bug_plan_commit.md:4` dev id 末尾 `0adbcde` 仍为游离对象（`git rev-list --all` 0 命中、与 `86580cd` 同 parent `5f1d4c8` 但 tree 不同，克隆库不可追溯）；② 行 22 P0 "+6 / 1907" 与实测不符（实测 1892→1901 = +9）；③ **fix commit id 行（:6）仍只列 `31f6391`，未追加 `a541d76`**——任务所述"工作树未提交追加"实际不存在（git status clean），即 a541d76 从未登记入跟踪文件；④ 行 13-16 验证计数仍为 1964/5021/80，未更新至 1991/5084/81。属文档/簿记问题，零代码影响。
- 等级：Low
- 符合规划：否（develop_commit_template.md dev/fix commit id 须对应真实链上 commit；跟踪文件须回填 fix id 与最新计数）
- 是否修复：已修复（fix commit `0881206` 收口轮一次性修订：dev id 末尾改 `86580cd`；P0 改 "+9 / 1901"；fix commit id 行追加 `a541d76,0881206`；验证计数改 2008 pass / 5133 expect / 82 files）
- plan是否覆盖
  - 已覆盖：develop_commit_template.md
  - 未覆盖：无
- 改进建议：①行 4 改 `86580cd`；②行 22 P0 改 "+9 / 1901"；③fix commit id 行追加 `a541d76`；④计数改 1991 pass / 5084 expect / 81 files。

### 问题 6
- 问题：第 2 轮问题 6 **仍存**：flow-state.ts:122 buildDecisionMenu 文档注释仍写 "blocked / awaiting_human → 5 items (resume/skip/rollback/restart/abort)"，实际返回 6 项（:131-139 含 choose_stage），注释与实现不符（plan §3.2 终形 = 6 项）。
- 等级：Low
- 符合规划：否（代码规范"注释与实现一致"；plan §3.2 一级 6 项终形）
- 是否修复：不需要（LOW，沿用第 2 轮裁定）
- plan是否覆盖
  - 已覆盖：plan §3.2（一级 6 项）
  - 未覆盖：无
- 改进建议：注释 5→6 项。

## 修复核验记录（第 2 轮问题 1-4，全部核验通过/部分通过）

| 第 2 轮问题 | 修复核验结论 |
|---|---|
| 问题 1（测试欠交） | **部分修复**：27 用例真实有效（choose_stage 5 测、inferResumeStage 5 测、🔴-2 无 stale 主断言、C5 三轮、二级 Esc audit、default-first、audit 全字段、source=menu、replay source、notify basis、directStageSelect 2 测、noUi 3 测、hostRole 2 测、select=1、source=replay）；仍缺项见本报告问题 1（C15 空跑、C11 消费级、DORMANT 变体、C14/C10①/D2 文案、forward-skipped/completed→compact） |
| 问题 2（directStageSelect） | **已修复**：flow-state.ts:764-824 抽取 promptStageSelection；promptDecisionMenu opts.directStageSelect（:867-870）直达二级；index.ts:259-264 shortcut 传 directStageSelect:true；第一次 choose_stage 意图不再被二次一级菜单静默丢弃；非 shortcut 四入口维持一级→二级单链，无重复弹层 |
| 问题 3（protect-ask noUi） | **已修复**：hasUi/selectThrew → noUi（protect-ask.ts:120-136）；dismissed && !noUi 才 handleDismissOverflow（:156-158/:230-232）；两审计补 hostRole（getHostRole）与 noUi:"true"（:166-167/:240-241）；测试 review3 #16/#17/#20 断言 dismissCount 不增 + noUi=true。边缘备注：select 抛异常若发生在 ≥1500ms 后仍会按 elapsed 归 canceled（:217-218）而非 plan"一律 dismissed"字面，实际难达、风险低，未单列 |
| 问题 4（source 缺省/replay/notify basis） | **已修复（部分）**：promptDecisionMenu source 缺省 "menu"（flow-state.ts:835）；session-starter.ts:386 重放统一 source="replay"；notify 追加 `(<basis>)`（:374-377）。遗留：skip/rollback/abort 审计行仍不写 source（本报告问题 2） |
| 回归核查（最小干预） | promptStageSelection 抽取为 1:1 保义重构（对比 31f6391 inline 代码：Esc 审计/clearDecisionTimer/executeDecision basis 传递逐行等价）；四入口（settle 重弹/freezeAndPrompt/shortcut/replay）+ 审计链路既有 1991 用例全绿，未发现行为回归；唯一语义缺口 = 二级 dismiss 归类（本报告问题 4，属 C9 遗留非本轮新引入） |
| 第 2 轮问题 5/6 复核 | 仍存，维持 Low（本报告问题 5/6） |

## 总体结论

- **是否有待修复项**：否。第 4 轮 fix commit `0881206` 完成全部 4 项 Medium 修复（问题 1-4）+ 收口轮一次性修订 Low 问题 5。问题 6（buildDecisionMenu 注释 5→6）维持 Low 沿用不修裁定。
- **fix-loop 是否可收敛**：**已收敛**。全部 Medium 修复落地、无回归、实测 2008 pass / 0 fail / 5133 expect / 82 files（计数单调只增不减：1991→2008 = `0881206` 净增 +17）。fix-loop 4 轮终止，可关账。
