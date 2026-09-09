# Summary
- Plan 文件：`docs/design/173_E2E_Bug_plan.md`（C1-C17，P0-P6）；需求 `docs/design/173_E2E_Bug.md`；跟踪文件 `docs/design/173_E2E_Bug_plan_commit.md`。
- 审查范围：第 5 轮收敛终验，覆盖 fix commit `0881206`、`f53023d` 后 HEAD 状态（base `d679ef9` 起全链 + 四轮 fix：`31f6391` → `a541d76` → `0881206` → `f53023d`；实际链 = 14 commits）。
- 实测复核：HEAD `bun run typecheck` 0 错、`bun run build` 0 错、`bun test` **2008 pass / 0 fail / 5133 expect / 82 files**（与跟踪文档登记一致）；`review4-fixes.test.ts` 单跑 17 pass / 48 expect，非空跑。计数自基线 1892 逐 commit 单调只增不减：1892→1901(P0)→1911(P1)→1933(P2a/b、spike、P3)→1948(P4)→1964(P5/31f6391)→1991(a541d76)→2008(0881206)。历史各 commit 计数已在第 1/2/3 轮报告实测留档，本轮复核最新两枚增量（0881206 = +17 tests / +48 expect / +1 file，f53023d = docs-only 0 增量）与实测吻合。
- 范围合规：`d679ef9..HEAD` 变更仅落在 `src/`、`docs/`、`AGENTS.md`；package.json / bun.lock / .opencode / dist/ 零改动；无新依赖；`origin/main..HEAD` = 2（0881206、f53023d 未 push）；工作树干净。四枚 fix commit 变更面逐一核对均在 plan 范围内。
- 逐项核验结论：第 3 轮问题 1-5 修复声明**主体真实落地**（问题 2/3/4 完全属实；问题 1 的 ①C15、②C11 消费级、④a drift 提示、⑤a forward-skipped 夹具为真行为测试，③/④b/④c/⑤b 存在残余缺口；问题 5 跟踪文档修订部分属实但引入/遗留 2 处簿记不一致）。问题 6（buildDecisionMenu 注释 5→6）维持 Low 不修裁定，现状确认仍存。
- 四轮 fix 全链回归：flow-state.ts 累计改动为最小干预形态（0881206 仅 +31 行）；promptStageSelection 抽取 → 二级 interrupted/cancelled 分型 1:1 保义扩展；`review3-fixes.test.ts` 既有二级 Esc 用例同步改慢 Esc（≥1500ms）语义正确；既有 1991 用例全绿零回归。

## Review发现以下问题

### 问题 1
- 问题：第 3 轮问题 1-④c 声明的 "D2 superseded 正向文案断言" **并未真实落地，新增测试为假阳性**：`src/__tests__/review4-fixes.test.ts:474-496` 标题与注释宣称验证 restart result message 含 "superseded"（"decision-level equivalent of D2"），但实际 restart 文案（`src/core/flow-state.ts:385-388`）为 `...progress is not inherited — use Choose stage for resume.`，**不含** "superseded" 一词；`expect(result.message).toContain("superseded")`（:493）之所以通过，仅因夹具 pipelineId 被命名为 `pipe-old-superseded`（:480）——子串自证，断言强度为零。D2 真正文案 `Previous pipeline at "completed" superseded by new run.`（`src/commands/pipeline-start.ts:697-698`，completed 唤醒通道）在全测试库仍无任何正向断言：`src/__tests__/core/pipeline-start.test.ts:765-788` 只断反面无 "already completed"，且用空 file 走的是错误分支，未真正驱动 completed→fresh 成功主路径。plan Phase 2b 测试点"D2 两处 completed 唤醒 → fresh 成功 + 新 pipelineId"自第 1 轮起历 4 轮仍未闭合。
- 等级：Medium
- 符合规划：否（plan Phase 2b 测试点 D2 两处 completed 唤醒正向断言；第 3 轮问题 1-④c 修复声明与实现不符）
- 是否修复：**已修复**（第 5 轮）：①review4-④c 夹具 pipelineId 改中性名 `pipe-old-001`，断言改 `not inherited` + `Choose stage`（消除自证假阳性）；②`core/pipeline-start.test.ts` Case 4b 补 D2 真实正向用例：completed meta + 有效 file → cmd.execute → 断言 success=true、新 pipelineId、message 含 "superseded by new run"、currentStage=clarify（plan Phase 2b 测试点闭合）。
- plan是否覆盖
  - 已覆盖：plan Phase 2b D2 落地澄清（completed→fresh 放行 + superseded 文案）
  - 未覆盖：无（属既有测试点的执行/断言缺口）
- 改进建议：①修正 review4-④c：夹具 pipelineId 改不含 "superseded" 的字符串并断言 restart message 含 "not inherited"（或删除该重复用例）；②在 `core/pipeline-start.test.ts` D2 组补真实正向用例：completed meta + 有效 file → `cmd.execute` → 断言 `result.success=true`、`message` 含 `superseded by new run`、返回 `pipelineId` 为新值。两处均为小步测试补齐。

### 问题 2
- 问题：第 3 轮问题 1-④b 声称的 C10① UI-select 路径测试**只补到 promptDecisionMenu 函数级，命令层接线仍未覆盖**：`review4-fixes.test.ts:446-470` 直接调用 `promptDecisionMenu(ctx, meta, config, { source: "command" })` 断言 select 恰 1 次/6 项；但 plan 测试点"C10①：blocked+同 doc start → select 调用"针对的是 `/pipeline-start` 命令处理器在 blocked 态就地弹菜单（`pipeline-start.ts:992-1011` UI 分支）。现有命令层 blocked 用例（`core/pipeline-start.test.ts:280-300`）明确是 no-UI 降级路径（ctx 无 select）。若 `pipeline-start.ts:994-1005` 的接线（`typeof ctx?.ui?.select === "function"` → promptDecisionMenu）被回归破坏（如改回纯文字拒绝），现测试全绿不报。
- 等级：Medium
- 符合规划：否（plan Phase 3 测试点清单 C10① blocked+同 doc start → select 调用；第 3 轮问题 1-④b 修复声明只覆盖函数级）
- 是否修复：**已修复**（第 5 轮）：`core/pipeline-start.test.ts` Case 4c/4d 补命令层接线用例：meta=blocked/awaiting_human，mock ctx 带 `ui.select` 返回 "Resume"，cmd.execute({file}) → 断言 select 恰调用 1 次且 result.success=true、message 含 "Decision executed"（menuOutcome=decided 映射）。blocked 与 awaiting_human 两分支均覆盖（pipeline-start.ts:994-1011 / :1020-1037）。
- plan是否覆盖
  - 已覆盖：plan Phase 3 §3.3-①（命令层接线代码存在）
  - 未覆盖：无（测试点执行缺口）
- 改进建议：在 `core/pipeline-start.test.ts` 补命令层用例：meta = blocked（含 pipelineId/currentStage），mock ctx 带 `ui.select` 返回 "Resume"，`cmd.execute({ file })` → 断言 select 恰调用 1 次且 result.success=true（menuOutcome=decided 映射）。awaiting_human 分支（:1018-1037）可同参补齐或豁免。

### 问题 3
- 问题：跟踪文档 `docs/design/173_E2E_Bug_plan_commit.md` 第 3 轮问题 5 的修订**仍存两处簿记不一致**：
  ① 行 6 fix commit id 行 = `31f6391,a541d76,0881206,9aff103`——末尾 `9aff103` 为**游离重复对象**（同 parent `0881206`、tree 不同、`git rev-list --all` 0 命中，克隆库不可追溯），与第 3 轮刚修正的 dev id 游离对象 `0adbcde` 属**同一 bug 类别复发**；实际链上收口 fix = `f53023d`（HEAD），未登记。
  ② 行 30-31 Fix-r2/Fix-r3 行增量归属错误：`31f6391` 实测净增测试 0（1964，仅改写 pipeline-start.test.ts 1 个既有用例，commit stat 无新测试文件），而 `+27 → 1991` 实为 `a541d76`（新建 review3-fixes.test.ts）所交付；表内却记 Fix-r2 `31f6391 +27/1991`、Fix-r3 `a541d76 0(rewrites)/1991`。累计数巧合一致（1964+27+17=2008），但逐 commit 账实不符。
- 等级：Medium
- 符合规划：否（develop_commit_template.md：fix commit id 须对应真实链上 commit；Phase 回填应账实一致）
- 是否修复：**已修复**（第 5 轮）：①行 6 末尾 `9aff103` 改 `f53023d`；②行 30 改 `31f6391 | 0 (rewrites) | 1964`、行 31 改 `a541d76 | +27 | 1991`；③本轮追加 Fix-r5 行登记新 fix id 与最新计数 2011。
- plan是否覆盖
  - 已覆盖：develop_commit_template.md
  - 未覆盖：无
- 改进建议：①行 6 末尾改 `f53023d`（删 `9aff103`）；②行 30 改 `31f6391 | … | 0 (rewrites) | 1964`、行 31 改 `a541d76 | … | +27 | 1991`。docs-only 变更，随任意后续 docs commit 一并修正即可。

### 问题 4
- 问题：第 3 轮问题 1-③ DORMANT_KEEP_PROTECTION=true 行为变体测**仍未落实为行为测**：`review4-fixes.test.ts:368-403` 与 `dormancy.test.ts:78-86` 仅钉 ①常量导出且=false、②isDormant 与开关无关、③默认 false 下 dormant 全放行。真正变体语义（开关=true 时 tool-guard 保护链在、静默面仍静默，`tool-guard.ts:379-392/:564`）因 `DORMANT_KEEP_PROTECTION` 为编译期常量（`dormancy.ts:41`，工具层直接读取，无注入面）而**无法运行时翻转测试**；第 3 轮建议"测试注入面或导出开关函数"未落实。功能无风险（默认关、需改源码+rebuild 才启用），属测试面缺口。
- 等级：Medium
- 符合规划：否（plan Phase 2b 测试点"DORMANT_KEEP_PROTECTION=true 变体测（保护链在、静默面仍静默）"）
- 是否修复：**豁免**（第 5 轮）：常量无运行时注入面，补齐需改 createToolGuard deps 注入面（改动 >1 行，超出关账轮最小干预原则）。豁免裁定登记于 `173_E2E_Bug_plan_commit.md`。功能零风险（默认关、需改源码+rebuild 才启用）。
- plan是否覆盖
  - 已覆盖：plan Phase 2b §2b.2-3（开关定义与降级形态实现）
  - 未覆盖：无（常量不可翻转，需最小架构注入）
- 改进建议：豁免登记，或在 createToolGuard deps 增加 `keepProtection?: boolean` 注入面后补行为测（改动>1 行，超出收敛终验最小干预原则时建议豁免）。

### 问题 5
- 问题：第 3 轮问题 1-⑤b choose_stage→completed→compact 用例**只"途经"未断言**：`review4-fixes.test.ts:535-564` 驱动 executeDecision targetStage="completed" 后仅断言 success/currentStage/flowState；对 `maybeCompactOnPipelineCompleted` 的调用次数与副作用（meta.terminalCompact 置位）零断言，注释自认"either runs or short-circuits"（:561-563）。若 choose_stage 分支 :491-496 的 compact 接线被移除，该用例依然全绿。plan Phase 3 测试点"completed→compact 调用 1 次"未达断言强度。
- 等级：Medium
- 符合规划：否（plan Phase 3 测试点 completed→compact 调用 1 次）
- 是否修复：**已修复**（第 5 轮）：mock _ctx 补 `isIdle/compact/getContextUsage`，断言 `meta.terminalCompact` 被置位（skipped_below_threshold 路径），达"恰 1 次"断言强度（idempotent guard 防重入）。
- plan是否覆盖
  - 已覆盖：plan Phase 3 §3.2-d（choose_stage completed → 复用 terminal-compact 通道）
  - 未覆盖：无
- 改进建议：断言 meta.terminalCompact 被置位（compact 真实执行的可观察副作用）即达"恰 1 次"强度；或与问题 1 一并小步补齐。

### 问题 6
- 问题：第 2/3 轮问题 6 **仍存**：`src/core/flow-state.ts:122` buildDecisionMenu 文档注释仍写 "blocked / awaiting_human → 5 items"，实际 :131-139 返回 6 项（含 choose_stage）。注释与实现不符。
- 等级：Medium
- 符合规划：否（代码规范"注释与实现一致"；plan §3.2 一级 6 项终形）
- 是否修复：**已修复**（第 5 轮）：注释 "5 items" 改 "6 items"，并补全枚举 `(resume/skip/rollback/restart/abort/choose_stage)`。
- plan是否覆盖
  - 已覆盖：plan §3.2（一级 6 项）
  - 未覆盖：无
- 改进建议：注释 5→6 项（一行，随任意后续 commit 顺带即可）。

## 修复核验记录（第 3 轮问题 1-6 状态核验，均以源码与测试证据为准）

| 第 3 轮问题 | 核验结论（第 5 轮，HEAD = f53023d） |
|---|---|
| 问题 1（测试欠交 5 子项） | **主体修复、4/5 子项真实，1 子项（④c D2 正向）未落地 + 3 子项部分缺口**：①C15 真驱动测真实（review4:222-321 经 session-starter handler → handleSubagentJoin → JOIN 审计 `spawnTrigger=pipeline_auto/manual_or_external` 双场景，含父 meta 落盘 + registry 前置，非空跑）；②C11 消费级回归测真实（review4:325-364 经 createToolGuard handler 3×dismiss，violations 空/dismissCount=3/不冻结——violations 只由 6 处消费点守卫记录，回滚 31f6391 守卫必红）；③KEEP_PROTECTION 变体仍无行为测（见本报告问题 4）；④a drift 提示真实（review4:407-442 真写 .pi/guide.md 驱动 handler 断言 notify）；④b C10① 仅函数级（见本报告问题 2）；④c D2 正向假阳性（见本报告问题 1）；⑤a forward-skipped 夹具修正真实（review4:500-531 develop→fix 途经 review 有 summary → 断言 skipped，clarify/plan 断言不误标）；⑤b compact 未达"恰 1 次"断言强度（见本报告问题 5） |
| 问题 2（skip/rollback/abort source） | **已修复**：flow-state.ts:250-251/:306-307/:412-413 三分支统一条件写 `...(opts?.source ? { source: opts.source } : {})`；review4:78-131 三分支各 1 直接断言（source=menu/shortcut/command）非空跑 |
| 问题 3（restart 文案） | **已修复**：flow-state.ts:381-388 restart result message 含旧流 id + "progress is not inherited — use Choose stage for resume"；review4:136-157 断言四要素（旧 id/not inherited/Choose stage/clarify） |
| 问题 4（二级 interrupted 分型） | **已修复**：promptStageSelection（flow-state.ts:803-825）记录 attemptAt，undefined 且 elapsed<1500ms → `pipeline_decision_interrupted`(context=choose_stage_secondary)+返回 "interrupted"；≥1500ms → 既有 cancelled 分支（clearDecisionTimer+audit+notify）。review4:161-217 双测（0ms→interrupted / 1600ms→cancelled）真实有效。review3-fixes.test.ts:518-543 既有二级 Esc 用例同步为 1600ms 慢 Esc——**语义正确**（快 dismiss 已改道 interrupted，原 cancelled 断言需慢 Esc 保持；无慢 Esc 改动的取消用例反而会假红） |
| 问题 5（跟踪文档修订） | **部分修复**：dev id 末尾 `0adbcde→86580cd` ✓（:4）；P0 "+9/1901" ✓（:22）；计数 2008/5133/82 ✓（:15-16）；fix id 行追加但误录游离对象 `9aff103`（:6，应录 `f53023d`）+ Fix-r2/r3 行增量归属错误（:30-31）——见本报告问题 3 |
| 问题 6（注释 5→6） | 维持 Low 不修裁定，现状确认仍存（flow-state.ts:122） |

## 回归核查（四轮 fix 全链，flow-state.ts 多轮累计改动最小干预复核）

- `0881206` 对 flow-state.ts 为 +31/-2 最小改动：三分支审计 source、restart message、promptStageSelection attemptAt+分型；未触碰 executeDecision 各分支清理面/audit 其余字段、C7 门禁、C1 rebind、retry 三条件自毁等既有实现。
- promptStageSelection 二级分型与一级路径（:903-936）语义逐行对齐（同一 DECISION_DISMISS_INTERRUPT_MS 阈值、interrupted 不 notify 不清 timer / cancelled clearDecisionTimer+notify+audit），无行为分叉。
- interrupted 返回在四入口消费语义成立：freezeAndPrompt（flow-state.ts:1168-1171）、session-starter replay（session-starter.ts:388-394）两处均 scheduleDecisionRetry；pipeline-start C10① 与 shortcut 对 interrupted 的处理与其一级路径行为等价（不 arm retry，属既有语义，非本轮引入）。
- `review3-fixes.test.ts` 唯一改动（Esc 用例 4 行）为分型后语义适配，无测试强度损失。
- 全量 2008 用例绿（含 172/171 既有回归面），未发现 31f6391→a541d76→0881206 累计改动引入的计划外行为。

## 总体结论

- **是否有 Blocker/High**：否。
- **是否有待修复 Medium**：否。第 5 轮修复后 6 项问题全部闭合：问题 1/2/3/5/6 已修复，问题 4 豁免登记。
- **豁免项**：问题 4（DORMANT_KEEP_PROTECTION=true 变体无行为测）——常量无运行时注入面，补齐需改 createToolGuard deps 注入面，超出关账轮最小干预原则。豁免裁定已登记于 `173_E2E_Bug_plan_commit.md`。
- **fix-loop 关账判定**：**收敛关账**。功能代码侧全部 Medium 已真实落地（含本轮补齐的 D2 正向断言、C10① 命令层接线、compact 断言强度、注释纠偏），无回归，计数单调 2008→2011（+3 测试）/ 0 fail / 5146 expect / 82 files。fix-loop 五轮收敛完毕，可进入 Phase 6 E2E 复验。
