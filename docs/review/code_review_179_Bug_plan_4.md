# Summary
   - `docs/design/179_Bug_plan.md`
   - Review 范围（第 4 轮）：针对第 3 轮报告 `docs/review/code_review_179_Bug_plan_3.md` 的 1 High + 4 Medium 逐项复核闭环情况，重点复核 fix commit `16870a4`（HEAD）对 5 项发现的处置，并对其余 Phase 0~5 实现、澄清基线 `docs/design/179_Bug.md` 最终决议、编码规范（`.opencode/references/code_spec.md`、`AGENTS.md`）、作用域合规与集成调用点做独立复查。
   - 门禁复验：`bun run build` 零错误；`bun run test` 2308 pass / 0 fail（与上一轮 2308 持平，**未新增任何用例**）。作用域：`16870a4` 仅触及 `tool-guard.ts` / `subagent-rpc.ts` / `verify-advance.ts` / `stage-advancer.ts` / `commands/pipeline-start.ts` 及 1 个既有测试文件；`package.json` 未改、无新增依赖、`dist/` 未入库、工作区干净。
   - 上一轮问题闭环：问题 1（High，相邻例外放行 plan→develop）**已闭环**；问题 2（超时 notify 缺旧子 id/probe）**已闭环**；问题 3（链尾摘要缺待人工动作）**已闭环（含一处死代码）**；问题 4（延后 notify 重复）**已闭环**；问题 5（resume-dispatch 未识别 deferred）**已闭环**。
   - 本轮新发现：Medium 1 项（`16870a4` 新增的 deferred/摘要分支无回归用例，与上一轮改进建议及 Plan 单测目标口径不符）；LOW 4 项（陈旧注释、英文注释混入中文、死代码分支、审计事件命名失准）+ 1 项跨轮 LOW 观察延续（`pipeline-handoff.ts` 未消费 `result.deferred`）。

## Review发现以下问题

### 问题 1
- 问题: `src/commands/pipeline-start.ts:608-618` 新增的 `result.deferred` 分支、`src/core/verify-advance.ts:572-593` 的链尾「待人工动作」摘要、`src/utils/subagent-rpc.ts:1010-1015` 的超时 notify 文案增强，三处均为 `16870a4` 新引入的行为，但**均无对应回归用例**（`git show 16870a4 --stat` 显示测试改动仅限 `tool-guard-suppress.test.ts` 的既有断言还原；全量用例数维持 2308，未增）。第 3 轮报告「问题 5」的改进建议明确要求「并补回归用例」，且 resume-deferred 属 G3「消除同名跨 stage 双活」的 dual-execution 关键路径——该分支一旦失效（如 `spawnStageSubagent` 返回值形态变化、分支顺序被改），无任何测试可拦截，会静默退回「提示用户手工再派发」并重新制造并发双活。链尾摘要新增的 `confirmGateReask` / `verifyFailures` 字段亦无断言保护。
- 等级：Medium
- 符合规划：否（部分）
- 是否修复：已修复（commit e5ff7f7：新增 3 条回归用例覆盖 deferred resume / 链尾摘要 / 超时通知文案）

### 问题 2
- 问题: `src/core/verify-advance.ts:581-584` 新增的 `pendingSpawns` 提示分支为**不可达死代码**。函数入口 `:550-557` 已在 `meta.pendingSpawns` 非空时提前 `return`（审计 `chain_terminal_wake_skipped reason=pending_spawns`），故 `:581` 的同一条件永远为假，`pending spawns queued for: …` 文案与对应 `pendingActions` 审计片段永不产出。既有测试 `verify-advance.test.ts:1032-1051` 恰以「pendingSpawns 非空 → 不 wake」固化该早退，反证该分支不可达。属死代码，无行为影响。
- 等级：Medium
- 符合规划：是（计划未要求该分支）
- 是否修复：待修复
- plan是否覆盖
  - 已覆盖：Phase 2 任务 4（去重三则之「存在未消费 pendingSpawns 不 wake」）
  - 未覆盖：无
- 改进建议：参考 Plan Phase 2 任务 4。删除 `:581-584` 不可达分支，避免后续维护者误以为 pending spawns 场景会出现在链尾摘要中。

### 问题 3
- 问题: `src/core/tool-guard.ts:772-775` 注释仍写「Adjacency exception (review#2 fix): when the target stage is a direct predecessor or successor of the current stage in the pipeline chain, the spawn is allowed」，与 `16870a4` 收窄后的实现（`:76-78` `isLegitimateManualProgression` 仅放行 `review→fix`）矛盾。陈旧注释会误导后续维护者按「相邻即放行」理解 3e 语义，与 Plan Phase 4 任务 3 / G6 口径冲突。
- 等级：Medium
- 符合规划：是（注释同步遗漏）
- 是否修复：待修复
- plan是否覆盖
  - 已覆盖：Phase 4 任务 3
  - 未覆盖：无
- 改进建议：参考 Plan Phase 4 任务 3。将 `:772-775` 注释更新为「仅 review→fix 定向例外，其余跨 stage（含 plan→develop）一律 block」。

### 问题 4
- 问题: `src/core/stage-advancer.ts:684` 注释 `// subsequent settles stay silent to avoid audit noise and repeated UI打扰.` 在英文注释中混入中文「UI打扰」，违反 `AGENTS.md` Style 明确约束「All code comments and logs must be written in English」。该行为 `16870a4` 编辑注释时引入。
- 等级：Medium
- 符合规划：是（文案瑕疵）
- 是否修复：待修复
- plan是否覆盖
  - 已覆盖：Phase 4 任务 1（首次延后去重）
  - 未覆盖：无
- 改进建议：参考 `AGENTS.md` Style。改为 `… to avoid audit noise and repeated UI notifications.`。

### 问题 5
- 问题: `src/core/tool-guard.ts:796` 的审计事件名 `out_of_stage_spawn_allowed_adjacent` 在收窄后已语义失准——当前唯一放行路径是 `review→fix`，并非「adjacent」泛指；事件名保留「adjacent」会使审计检索/文档（`guide.md` 审计事件表）与实现口径不一致。
- 等级：Medium
- 符合规划：是（命名瑕疵）
- 是否修复：待修复
- plan是否覆盖
  - 已覆盖：Phase 4 任务 3
  - 未覆盖：无（事件名为实现侧新增）
- 改进建议：参考 Plan Phase 4 任务 3。如后续再动 3e，可将事件名收敛为 `out_of_stage_spawn_allowed_review_fix` 或 `out_of_stage_spawn_allowed_manual_progression` 并同步 `guide.md` 审计事件表。

### 问题 6
- 问题: `src/tools/pipeline-handoff.ts:196` 仍直接 `await spawnStageSubagent(...)` 而不消费返回值，未识别 `result.deferred`（上一轮 LOW 观察延续）。该路径不发送 owner wake，故无 dual-execution 风险，仅表现为 deferred 时对用户静默、无任何审计痕迹。
- 等级：Medium
- 符合规划：是
- 是否修复：待修复
- plan是否覆盖
  - 已覆盖：Phase 2 任务 2（deferred 语义）
  - 未覆盖：无（调用点枚举未含 handoff 路径）
- 改进建议：参考 Plan Phase 2 任务 2。可选：与 `pipeline-start.ts` 同型补 `result.deferred` 审计（`pipeline_handoff_deferred`），保持 deferred 可观测性一致。

## 上一轮问题闭环核对

| 上一轮问题 | 等级 | 本轮结论 | 证据 |
|-----------|------|---------|------|
| 1 相邻例外放行 plan→develop（违背 Phase 4 拦截口径、改写测试目标） | High | ✅ 已闭环 | `tool-guard.ts:67-78` 删除 `STAGE_ORDER`/`isAdjacentStage`，改为仅 `review→fix` 的 `isLegitimateManualProgression`；`tool-guard-suppress.test.ts:421-441` 已还原「plan→develop → blocked + `out_of_stage_spawn_blocked` + `targetStage=develop`」断言；`:402-419` 保留 review→fix（异名）放行断言。`STAGE_ORDER`/`isAdjacentStage` 全仓无残留引用 |
| 2 超时 notify 缺旧子 id/probe 状态 | Medium | ✅ 已闭环 | `subagent-rpc.ts:1010-1015` 文案改为 `(old child: <agentId\|n/a>, source stage: <stage>, probe: <live\|settled\|unknown>)`，与 `:1016-1022` audit payload 信息量对齐；`probeStatus` 经 `probeAgentState` 实时取值 |
| 3 链尾摘要缺待人工动作 | Medium | ✅ 已闭环（含死代码） | `verify-advance.ts:572-593` 追加 `confirmGateReask` / `verifyFailures` / `pendingSpawns` 提示，audit `:601` 同步 `pendingActions`；其中 `pendingSpawns` 分支不可达（见问题 2） |
| 4 延后 notify 重复 | Medium | ✅ 已闭环 | `stage-advancer.ts:685-693` notify 移入首次延后条件块 `(!existing \|\| existing.stage !== currentStage)`，与 `confirm_gate_deferred` 审计去重语义对齐 |
| 5 resume-dispatch 未识别 deferred | Medium | ✅ 已闭环（缺回归用例） | `pipeline-start.ts:608-618` 新增 `result.deferred` 分支：抑制「Run the <stage> agent」提示 + 审计 `pipeline_resume_deferred reason=subagent_deferred`；但无测试（见问题 1） |

## 逐 Phase 核对结论

| Phase | 计划任务 | 实现落点 | 单测 | 验收 |
|-------|---------|---------|------|------|
| 0 | `spawnWaitTimeoutMs` 配置源 | `types.ts` / `constants.ts` / `json-config-loader.ts` / `pipeline_loop.json` / `guide.md` | json-config +6 | ✅ 合法值透传、非法值 warn 回落、缺省默认 120000 |
| 1 | G2 四层同修 | `agent-settled.ts`、`subagents-config-probe.ts`、`session-starter.ts`、`pipeline-init.ts`、yml + design SKILL、guide §7.11、`pipeline_loop.json` 声明反转 | agent-settled +4、probe +11、session-starter +3、prompt-config +2、template-defaults +1 | ✅ |
| 2 | G3 跨 stage 抑制 / 等待-终结 + G8 链尾 wake | `spawn-evidence.ts`、`tool-guard.ts` 3c、`subagent-rpc.ts`（deferral + 去重 + 真实 id 回写）、`verify-advance.ts`、`commands/pipeline-start.ts`（resume deferred） | tool-guard-suppress +3、subagent-rpc +5、verify-advance +3 | ⚠️ 见问题 1（resume-deferred / 摘要增强无回归用例）、问题 2（死代码） |
| 3 | G4 方案行放宽 + `example` 回灌 + Q/A MUST | `clarify_spec/verify.md`、`verify-frontmatter.ts`、`group-verifier.ts`、`file-verifier.ts`、yml/SKILL/guide | file-verifier +7、group-verifier +1、verify-groups-parser +3 | ✅ |
| 4 | G5/G7 弹窗后置 + re-arm=3 + G6 越权拦截 + G9 | `stage-advancer.ts`、`agent-settled.ts`、`tool-guard.ts` 3e、`guide.md` §13.3.1 | confirm-gate +4、agent-settled +2、tool-guard-suppress +4 | ✅（3e 已收窄为 review→fix，plan→develop 恢复 block） |
| 5 | 文档收口 + 全量门禁 | `guide.md`（§7.11、配置条目、快捷键三护栏、审计事件表 9 条） | 无新增（按计划） | ✅ build 0 error / test 2308 pass / 0 fail；无新增依赖 |

## 关键风险点复核（SOP #4 鲁棒性）

- `16870a4` 为纯逻辑收窄 + 文案/摘要增强，未触碰配置解析、超时源、监听器/定时器布防，无新增泄漏面；`spawnWaitTimeoutMs` 非法值 warn 回落与探针 `null` 降级链路不受影响。
- 3e 收窄后放行面回归最小（仅 `review→fix`），`plan→develop`、`review→develop` 等越权路径恢复 block；`out_of_stage_spawn_blocked` 审计与路由提示文案完整，不计 violation、child 会话不拦，均保持既有口径。
- deferral 去重注册表（`activeDeferredSpawns`）与三出口 `finalize()` 清理未改动，`unref()` 保留，无泄漏回归。
- 弹窗后置超时兜底（`confirm_gate_defer_timeout`）与「首次延后」notify/审计去重一致，杜绝「永不弹」死锁与重复打扰。
- 类型安全：新增 `isLegitimateManualProgression`、`probeStatus`、`pendingHints` 均显式类型；未引入无 TSDoc 的 `any`。
- 澄清决议 → Plan 双向追溯矩阵逐项核对无遗漏；Phase 5 的 8 场景 E2E 为用户手动项（见 `179_Bug_plan_commit.md`），本环境不可执行。
- 作用域：`16870a4` 未触及 `package.json`、`dist/`，无新增依赖；`commands/pipeline-start.ts` 未列入 Plan「All Phase 文件变更汇总」表，但其为 Phase 2 deferred 语义的必要调用点收尾（上一轮问题 5 改进建议直接指向该文件），不判越界。

**结论**：无 Blocker、无 High。第 3 轮 High 1 项（问题 1）与 Medium 4 项（问题 2/3/4/5）全部确认闭环。本轮新增 Medium 1 项（问题 1：`16870a4` 新增的 resume-deferred / 链尾摘要 / 超时 notify 行为缺回归用例，用例总数未增，与上一轮改进建议及 Plan 单测目标口径不符）标记 `待修复`；LOW 4 项（陈旧注释、英文注释混入中文、死代码分支、审计事件命名失准）+ 跨轮 LOW 观察 1 项（`pipeline-handoff.ts` 未消费 deferred），无需修复。门禁：`bun run build` 零错误、`bun run test` 2308 pass / 0 fail。存在 `待修复` 项，建议进入 fix 子代理（code-review-withfix-agent）。
