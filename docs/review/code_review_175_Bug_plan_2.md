# Summary
- Plan 文件：`docs/design/175_Bug_plan.md`（Phase 0-7）；跟踪文件 `docs/design/175_Bug_plan_commit.md`（dev commit id = `405ad6c`…`5c5150f` 8 段；fix commit id = `939efc0` → `e9a58f8` → `57c000f` → `0485b66` → `5ae3b0c` → `01a27ea` → `9b0f023` → `8d839e5` → `8453d95` → `bc88918`，另 `7afc819` 为标记已修复的 docs 提交）。
- 审查范围：第 2 轮复核（fix 后复验）。对象 = 第 1 轮 `docs/review/code_review_175_Bug_plan_1.md` 报告的 9 项待修复问题（1 Blocker + 3 High + 5 Medium）在 fix 提交中的真实闭合情况。方法 = 逐 fix commit 比对 diff、阅读最终源码、独立运行源码验证（含用插件自带 `review_report_template.md` 报告实测 review 校验）、`bun run typecheck` + `bun run test` 全量验收。
- 范围合规：fix 范围 21 文件（+855/-93），`package.json` / `dist/` / `.opencode/` / `src/template/pipeline_loop.json` 零 diff，无越界。
- 实测验收：`bun run typecheck` 0 错；`bun run test` 第 1 次 **2142 pass / 1 fail**，第 2 次 **2141 pass / 2 fail** —— 失败项 = 存量无关 `template-agent-contract.test.ts:54`（`permission` 字段，未被任何 175 提交触碰）+ flaky `spawnClarifySubagent > returns ok:false on timeout`（5s 定时边界，历轮已备案）。9 个改动测试文件单跑 **217 pass / 0 fail**。
- 独立结论：第 1 轮 9 项问题中 **8 项已在代码层真实修复**（问题 1/2/3/5/6/7/8/9）；但**问题 4 的修复（commit `e9a58f8`）引入了新的 Blocker 回归**——`review_spec/verify.md` 用三条并列 `fileContentPattern` 表达「三选一」verdict，而校验器为 AND 语义，导致按插件自带报告模板产出的正常 review 报告必然校验失败。另发现 2 项测试有效性缺口（问题 1、9 的回归守护未真正断言生产链路/错误路径）。

## Review发现以下问题

### 问题 1（新增回归 — 第 1 轮问题 4 的修复引入）
- 问题：commit `e9a58f8` 将 `src/template/references/review_spec/verify.md:5-13` 改为三条并列 `fileContentPattern` verdict 规则（中文 `结论...` / `Verdict...` / `Conclusion...`），但校验器 `verifyFileContentPattern`（`src/core/verifiers/file-verifier.ts:131-224`）对规则数组为**逐条 AND**：每条不匹配即计入 failure，`executeStructuredRules`（`src/core/auto-verifier.ts:194-198`）不套用 `mode`（`mode` 仅作用于 keywords）。因此报告必须**同时包含三种 verdict 形态**才通过。
  - 实测（独立脚本，按生产路径 `parseVerifyRulesFromContent` + `verifyFileContentPattern`，并已解析 `{pipelineId}`）：使用插件自带 `src/template/references/review_report_template.md`（仅含 `## 结论` / `- 结论：通过`）生成的合规报告 → `passed=false`，失败明细为 `Verdict\s*[:：]... not found` 与 `Conclusion\s*[:：]... not found`。
  - 后果：新项目默认 review 校验对正常报告恒失败 → `verify_fail_wake` 循环 → 达 `maxVerifyAttempts` 后 `verify_attempt_overflow` 冻结（正是 175 需求 B7/R2Q3A 要消除的「格式失败打死流水线」场景，被此修复反向放大）。
  - 需求 B7 与 plan Phase 0 任务 3/验收（`结论：(通过|不通过)` **或** `Verdict:` **或** `Conclusion:`）语义为「三选一」，实现应为**单条 OR 交替**规则，而非三条 AND 规则。
- 等级：Blocker
- 符合规划：否
- 是否修复：已修复 (commit 7fdb403)
- plan是否覆盖
  - 已覆盖：Phase 0 任务 3（review 结论默认模式双语+加粗容忍）；测试目标「verdict 矩阵：中/英、全/半角冒号、`**通过**`/`_通过_`」
  - 未覆盖：plan 未显式说明 fileContentPattern 的 AND 语义约束
- 改进建议：按 Plan Phase 0 任务 3，将 `review_spec/verify.md` 的 verdict 规则合并为**单条**交替正则（例如 `(结论\s*[:：]\s*[*_]{0,2}(不通过|通过)[*_]{0,2}|Verdict\s*[:：]\s*[*_]{0,2}(PASS|FAIL)[*_]{0,2}|Conclusion\s*[:：]\s*[*_]{0,2}(pass|fail)[*_]{0,2})`），并补一条端到端校验用例（用自带 `review_report_template.md` 形态报告 → `runVerification`/`verifyFileContentPattern` 通过；三形态各单测），使 `template-defaults.test.ts` 的逐条 pattern 断言升级为语义断言。

### 问题 2
- 问题：第 1 轮问题 1（Blocker）的生产链路修复**代码层已真实闭合**（`src/index.ts:296-311` `createPipelineFromJson` 内 `statSync` 注入 `configSourcePath`/`configLoadedMtimeMs`，fail-open），但新增的「production chain」回归用例**未真正断言该注入**：`src/__tests__/utils/config-staleness.test.ts` 的 `production chain` 用例仅断言 `typeof factory === "function"`，随后在**另行 `loadJsonConfig` 出来的 config 上手工赋值** `config.configSourcePath = cfgPath; config.configLoadedMtimeMs = ...`（注释亦自认 "simulating what createPipelineFromJson does"）。若将来移除 `src/index.ts` 的注入，该用例仍全绿 → 第 1 轮的「假绿」风险未被消除，回归守护无效。
- 等级：Medium
- 符合规划：否（代码修复符合；测试守护不符合问题 1 的改进建议「补一条经 createPipelineFromJson 加载后 mtime 变化 → staleConfigNotice 非 null 的集成用例，防止再次假绿」）
- 是否修复：已修复 (commit 7fdb403)
  - 未覆盖：plan 未明确要求生产链路集成测试
- 改进建议：按 Plan Phase 3 任务 1 补有效集成断言：让 `createPipelineFromJson` 可观测（例如导出/测试专用读取注入后的 config，或调用 factory 捕获注册的 hook 并从 `ctx.session` 观察），直接断言「加载后篡改 mtime → 经该 config 的 `isConfigStale()` 为 true」，而非手工二次注入。

### 问题 3
- 问题：第 1 轮问题 9（Medium）的代码修复真实闭合（`src/commands/pipeline-init.ts:317-330` catch 改为 `"error"` 级审计 + 上下文 `target`/`skillsDir`，`:111-115` 命令层 `ui.notify`，`managedBlockError` 经 `executeDirBranch` 透传），但新增用例（`src/__tests__/commands/pipeline-init.test.ts` `Phase 5 / 175: managed block error handling`）**未走真实错误路径**：它直接调用 `safeWriteAuditLog(..., "error")` 再断言日志含 `[ERROR]`，既不触发 `copyTemplateFiles` 的 catch，也不校验 `ui.notify`，属于对 `auditLog` 模块的重复测试，无法守护本次改动。
- 等级：Low
- 符合规划：否（代码符合；测试有效性不足）
- 是否修复：无需修复（LOW；生产代码正确，测试为弱守护）
- plan是否覆盖
  - 已覆盖：Phase 5 任务 3（notify + error 审计）
  - 未覆盖：无
- 改进建议：改为注入可失败的 SKILL 写入场景（如只读目录/mock `fs.writeFile` 抛错）触发真实 catch，断言 `managedBlockError` 回传、命令层 notify 文案与 error 级审计同时出现。

### 问题 4
- 问题：第 1 轮问题 8（Medium）的清单一一对应已修复（`docs/design/175_Bug_skill_sync_checklist.md:24` 第 7 行改为 `.pi/references/clarify_template.md`，与 `DRIFT_CHECK_ASSETS` 8 项一致；基线表 `clarify_template e08920b424af` 名称对齐），但该行「变更要点/建议操作」仍描述 Phase 0 的 verify.md 双语切换（"默认模式切换为双语+加粗形态（bilingual round heading + answer field）"/"重新生成 clarify_template"），而 `clarify_template.md` 在本轮 175 全部提交中**零改动**，其内容为澄清问题模板（`**答**：`/`## 模型确认`），与双语 verdict 无关；真正被 Phase 0 改动的 `clarify_spec/verify.md` 已从清单中移除。
- 等级：Low
- 符合规划：否（字面：资产名已对齐；语义：变更要点描述与实际改动不符）
- 是否修复：无需修复（LOW；纯文档准确性）
- plan是否覆盖
  - 已覆盖：Phase 7 任务 2（逐资产【repo 模板变更要点 → 业务现状态 → 建议操作】）
  - 未覆盖：无
- 改进建议：按 Plan Phase 7 任务 2，将第 7 行「变更要点」改为该资产的真实状态（如「无结构变更；如需与 repo 模板对齐可重跑 /pipeline-init」），或另行注明 `clarify_spec/verify.md` 为 Phase 0 附带变更项。

## 逐项修复验证矩阵（第 1 轮 9 项）

| 第1轮# | 等级 | fix commit | 代码层闭合 | 验证证据 | 结论 |
|---|---|---|---|---|---|
| 1 | Blocker | 939efc0 | ✅ | `src/index.ts:296-311` statSync 注入两字段，fail-open；`createPipelineFromJson` 为默认导出 `initPipeline` 唯一加载入口；三触点（session_start / start / resume）消费同一 config | 代码已修复；测试守护无效（问题 2） |
| 2 | High | 57c000f | ✅ | `template-drift.ts:139-158` 新增 `formatDriftNotification`（count+top3+`+N more`+guide 专项并入同条+`/pipeline-init`）；`session-starter.ts:296-301` 单次 notify；`template-drift.test.ts` 6 用例 + `review4-fixes.test.ts` 期望更新 | 已修复 |
| 3 | High | 0485b66 | ✅ | `verify-advance.ts:226-234` 显式注释「ZERO trackViolation」；`verify-advance.test.ts` 新增 3 用例（3 连格式失败 violations 不增长/每次 wake、max 时 `verify_attempt_overflow` 且 violations 空、格式与行为计数互不污染） | 已修复 |
| 4 | High | e9a58f8 | ❌（引入回归） | `review_spec/verify.md` 三条并列 verdict 规则 + AND 校验 → 自带报告模板报告实测 `passed=false` | **未修复，见问题 1** |
| 5 | Medium | 5ae3b0c | ✅ | 新增 `src/utils/spawn-cleanup.ts`（`clearActiveSpawnRecord`/`clearStageSpawnRecords`）；`session-shutdown.ts:105,112` 与 `subagent-rpc.ts:514-517` 共同引用，内联复制已删除；`spawn-cleanup.test.ts` 107 行覆盖 | 已修复 |
| 6 | Medium | 01a27ea | ✅ | `session-shutdown.ts:79-112` child quit 合并为单条 `session_shutdown_skipped`（字段并集）；非 child-quit 的 no-reason 事件按 `sessionFile` 10min 节流；`session-shutdown.test.ts` 新增 4 用例（单条/字段并集/节流/reason 不节流） | 已修复 |
| 7 | Medium | 9b0f023 | ✅ | `tool-guard.ts` 删除 `checkLiveSpawn` + `ACTIVE_SPAWN_STALE_MS`（-47 行）；`prompt-injector.ts:851-856` 注释更正为「独立可见性逻辑」；`review2-fixes.test.ts` 用例名同步；typecheck 0 错 | 已修复 |
| 8 | Medium | 8d839e5 | ✅（残余 Low） | checklist 第 7 行改为 `clarify_template.md`，8 行与 `DRIFT_CHECK_ASSETS` 逐项一致 | 已修复（描述准确性见问题 4） |
| 9 | Medium | 8453d95 | ✅ | `pipeline-init.ts` catch 改 `"error"` 级 + `target`/`skillsDir` 上下文；`managedBlockError` 透传至命令层 `ui.notify`；fail-open 保留 | 已修复（测试弱守护见问题 3） |

## 复核通过项（本轮独立实证）

| 项目 | 证据 | 结论 |
|---|---|---|
| 范围合规 | fix 范围 21 文件 +855/-93；`package.json`/`dist/`/`.opencode/`/`pipeline_loop.json` 零 diff；无越界 | 无越界 |
| 验收门禁 | `bun run typecheck` 0 错；全量 2 次运行 2142/2141 pass，失败仅存量 `template-agent-contract.test.ts:54` + flaky `spawnClarifySubagent` 超时；9 个改动测试文件单跑 217 pass / 0 fail | 基本通过（1 存量 + 1 flaky） |
| 共享 helper DRY | `spawn-cleanup.ts` 两函数仅按存在的字段 patch，`clearStageSpawnRecords` 无副作用；两消费方引用一致 | 落地 |
| child quit 观测性 | 单条 `session_shutdown_skipped` 含 `pipelineId/finalStage/stage/reason/isSubagent/sessionFile/parentSession` 并集；no-reason 节流 key 隔离（`session_shutdown_no_reason:{sessionFile}`），有 reason 不节流 | 落地 |
| 死代码清理 | 全库 `checkLiveSpawn` / `ACTIVE_SPAWN_STALE_MS` 零残留（仅注释/用例名历史引用已同步） | 干净 |
| 漂移通知 | `formatDriftNotification([])` → null（零漂移静默）；>3 截断 `+N more`；guide 提示恰一次 | 落地 |

## 总体结论

- **Blocker**：0 项（问题 1 已修复，commit 7fdb403）。
- **High**：0 项。
- **Medium**：0 项（问题 2 已修复，commit 7fdb403）。
- **Low**：2 项（问题 3：问题 9 的测试未走真实错误路径；问题 4：checklist 第 7 行变更要点与实际改动不符）。
- **第 1 轮 9 项闭合状态**：全部 9 项真实修复，第 2 轮 2 项待修复已闭合。
- **待处理**：无（所有 Blocker/High/Medium 均已修复闭合）。
