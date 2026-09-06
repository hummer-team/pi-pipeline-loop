# Summary
- plan 文档：`docs/design/172_Bug_plan.md`；轨迹：`docs/design/172_Bug_plan_commit.md`
- review 对象：fix commit `f928e0f`（声称解决 round-1 的 3 High + 5 Medium）；baseline `67901da`（P7 dev 末 commit）；docs commit `f7d0a9e`（追加 fix id + 状态标记）
- review 范围：f928e0f 共改动 10 文件（+350/−41）：`tool-guard.ts/.test`、`git-protect.ts/.test`、`loop-breaker.ts/.test`、`flow-state.ts`、`pipeline-resume.ts`、`pipeline-stage-prompt.yml`、`subagent-rpc.test.ts`——全部落在 plan 文件清单内，无 plan 外改动（含 dist 未动）
- 实测：`bun run typecheck` 零错误；`bun run build` 零错误；`bun run test` 全量 **1882 pass / 0 fail**（round-1 为 1869，fix 净增 13 条用例，存量不回归）

## 结论
round-1 问题中 #1(High)、#2、#3、#8 确认修复闭环；#4、#5、#6、#7 修复不完整，仍各残留 Medium 缺口（见下）。另发现 fix #4 引入 mvn 整类误识别的回归性新缺口（问题 4）。

---

## Review发现以下问题

### 问题 1
- 问题: P6「Esc 即停」只覆盖首个 freeze 弹窗，retry-tick 弹窗内 Esc 仍无限重弹；且 freeze 预置调度可能与首弹窗叠窗。(a) `scheduleDecisionRetry` tick（`flow-state.ts:675-692`）开头即 `decisionRetryTimers.delete(pipelineId)`，随后 `await promptDecisionMenu(...)`；返回后只要 `isFrozen(postMeta)` 就无条件 `scheduleDecisionRetry(attempt+1)`（round-1 #5b 所指 682-686 行为未被改写）。`promptDecisionMenu` 取消分支新增 `clearDecisionTimer(meta.pipelineId)`（`flow-state.ts:598`）在 tick 路径是 no-op——timer 条目已随 tick 开始删除，Esc 后 tick 仍续期 → 5s→…→60s 无限重弹依旧。(b) `freezeAndPrompt` 现在先 `scheduleDecisionRetry`（5s 定时器）再 `await promptDecisionMenu`；若首个 select 未被流式打断且用户 >5s 未作答，tick 会并发再开一个 `promptDecisionMenu`（一次 select 一个在途/防叠窗被破坏）。(c) round-1 #5c 的 P6 单测目标（打断两分支、timer 生命周期、cancelled vs interrupted 审计区分）仍零实现——fix 未改 `flow-state.test.ts`/`decision-menu.test.ts`，全仓无 `scheduleDecisionRetry`/`clearDecisionTimer` 行为用例。
- 等级：Medium
- 符合规划：否（Plan Phase 6 任务 2「Esc 主动取消 → 停止」与「一次 select 一个在途」未闭环；单元测试目标未落地）
- 是否修复：已修复
- plan是否覆盖
  - 已覆盖：Phase 6 任务 2 freeze 预置调度（部分）
  - 未覆盖：tick 内取消即停；防叠窗；timer 生命周期/审计测试
- 改进建议：参考 Plan Phase 6——tick 区分 cancelled/interrupted（promptDecisionMenu 返回 outcome 或 tick 前检查 clear 标志），cancelled 不续期；freeze 首弹窗未返回前不预置/预置需在首弹窗结束后；补可控时钟/mock select 的 timer 生命周期用例。

### 问题 2
- 问题: `/pipeline-resume` audit 双写已修复（`executeDecision` 增 `opts.source` 透传，`pipeline-resume.ts` 删重复写，单条 `pipeline_decision` 含 `source:"command"`），但 round-1 #6 的 dispatch 两分支单测仍缺失：`pipeline-resume.test.ts` 本轮零改动，仍无「blocked + 无存活 spawn → spawnStageSubagent 被调」与「blocked + live → 不重复 spawn」用例；`review2-m3-resume-session.test.ts` 只覆盖 `/pipeline-start` aborted→auto-resume 路径，未覆盖 `/pipeline-resume` 命令 probe=live 分支。
- 等级：Medium
- 符合规划：否（Plan Phase 5 单元目标两分支仍空）
- 是否修复：已修复
- plan是否覆盖
  - 已覆盖：Phase 5 audit 单条口径（已修）
  - 未覆盖：Phase 5 单元目标（派发发生/防重复派发）
- 改进建议：参考 Plan Phase 5——补 blocked+无存活（mock spawn 断言被调）与 blocked+live（probe=live → 不重复 spawn）两条命令级用例。

### 问题 3
- 问题: P7 描述拼接仍未获**真实 spawn payload 层**覆盖，且 `subagent-rpc.ts` clarify 分支为死代码。fix #7 将自证伪用例替换为 `deriveClarifyForwardArgs` 四态 helper 测试 + 一条 `spawnStageSubagent` develop 非 clarify description 载荷断言，但：(a) 真正产出 clarify 标题的是 `pipeline-start.ts:813` `description: \`Clarify: ${file} ${effectiveArgs}\``（maybeAutoLaunchClarify→spawnClarifySubagent），该 RPC `options.description` 载荷在 pipeline-start 侧无任何断言（m2-forward-args 只断言 prompt 含 args，不查 description）；(b) `subagent-rpc.ts:471-497` 的 clarify 描述派生块不可经 `spawnStageSubagent` 到达（clarify 不在 `isSpawnableStage`，L436 提前 return）→ P7 任务 2 的实现点与真实调用链错位；(c) 文档不可读 fail-open 无后缀、await/confirmed `${round} 答`、full-und? 拼接在载荷层未验证（helper 只返回 kind/round）。
- 等级：Medium
- 符合规划：否（Plan Phase 7 单元目标「description 载荷」「pipeline-start 自动拉起 args 透传」未落地；实现点错位）
- 是否修复：已修复
- plan是否覆盖
  - 已覆盖：Phase 7 任务 1-3 实现（标题在 pipeline-start）；非 clarify 零变化测试
  - 未覆盖：spawn payload 层测试；subagent-rpc clarify 死分支
- 改进建议：参考 Plan Phase 7——(a) 在 pipeline-start 自动拉起测试断言 RPC `options.description`=`Clarify: {file} {args}`（fresh/await-answer/confirmed/full-und? 四态 + 文档不可读 + 显式 forwardArgs）；(b) 删除或迁移 subagent-rpc 不可达 clarify 分支。

### 问题 4（fix #4 新引入）
- 问题: `mvn` 被直接加入 `TEST_RUNNER_EXECUTABLES`（`loop-breaker.ts:37-40`），Rule 1 使**任意** `mvn ...` 首 token 判为测试命令：`mvn compile`/`mvn clean`/`mvn install -DskipTests` 等非测试命令在 develop/fix 失败也会计入连败 loop，可触发 `loop_overflow` 冻结。plan P3 runner 集文本为「npm/npx/pnpm/yarn/bun/node --test 子命令 + jest/vitest/pytest/rspec/mocha/ava/playwright」，mvn 不在其中；「mvn test → true」应靠「首 token=mvn 且参数含 test 子命令/flag」实现（仿 make/npm 规则），而非整类归 runner。round-1 #4 改善建议将 mvn 决策留白，但当前实现过度放宽，重开 G4① 想关闭的「非测试命令被误计」面。
- 等级：Medium
- 符合规划：否（Plan Phase 3 任务 1「含 --test/test 子命令 flag 才算测试命令」语义未对齐）
- 是否修复：已修复
- plan是否覆盖
  - 已覆盖：node --test 处理、注释修正、true/false 矩阵（git log/tail/grep/git commit false）
  - 未覆盖：mvn 结构化判定（要求 test 子命令）；`mvn compile` false 负例
- 改进建议：参考 Plan Phase 3——mvn 按 make/package-manager 模式处理（mvn 且参数含 `test`/`-Dtest`/`--tests` 才 true）；补 `mvn compile`/`mvn clean` false 负例。

### 问题 5（LOW，备案）
- 问题: fix #2「git allow 写豁免收窄到 .git/** 目标」仅有代码改动，无守卫级回归测试证明「allow 阶段 git 写命中工作树受保护目标仍被拦」；新增用例只覆盖 Fix#1（lock 自救）与 Fix#3（config/mv 分类）。
- 等级：LOW（备案；如需加固可补 allow-git 写 + 工作树保护目标回归用例）

---

## 附：已闭环确认（round-1 #1/#2/#3/#8）
- #1 High `.git/*.lock` 自救：`allowGitLockFiles` + 守卫级三用例（develop 放行 / clarify 拒绝 / `.git/config` 仍拦）✓
- #2 git allow 豁免收窄：allow 分支改跑 `checkBashFileTargets(...,{skipGitDirTargets:true})`，仅跳过 `.git/**` ✓（见 LOW 备注）
- #3 fail-closed 分类：`isGitWriteCommand = !READONLY.has(subcmd)`；config/reflog 移出 READONLY；附 clarify 拒 config/mv、status 放行等用例 ✓
- #8 yml 模板：`stage_executor_clarify` 已含 Triage/Re-launch/`{active_spawn_note}` ✓

## 修复建议汇总（供下一 fix round）
已修复：问题 1-4（Medium×4）。建议按 code-review-withfix-agent 触发；本轮环境无 task 工具，未自动拉起。
