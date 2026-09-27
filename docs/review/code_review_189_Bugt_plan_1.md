# Summary

- **Plan 文件**: `docs/design/189_Bugt_plan.md`（需求文档 `docs/design/189_Bugt.md`，4 轮澄清 + full-und? 最终决策表「答：确认」）
- **Commit 标记**: `docs/design/189_Bugt_plan_commit.md` → dev commit id: `fd63042, 559cbd0, 2216f2c, 7bda47c, 7611a50`；回归修复: `7584e76`
- **Review 范围**: 对照计划 5 个 Phase，逐项核查 5 项最终决策的覆盖与实现质量。检查项包括：范围合规（是否改动计划外文件）、TS 编码规范、每个 Phase 任务/验收/单测目标是否落实、Phase 之间的交叉副作用。
- **静态核查结论**: 6 个 commit 共改动 18 个文件，**全部落在计划「File change summary」清单内，无计划外文件改动**（范围合规通过）。`build`/`typecheck`/`bun test`（2594 pass）由主会话验证通过；工作树干净（`.opencode/skills/fast-develop/SKILL.md` 为 gitignore 文件，已在工作树按 Phase 0/1 要求改写）。
- **总体判断**: 5 项决策均有对应实现，主体功能可用；但 **Bug 1 方案 B 的「守护 ③ commit.md 断点注入」在 child→owner 路由下失效（High）**，另有 3 处计划指定的实现/测试细节未落实（Medium）。

## 决策覆盖矩阵

| 最终决策 | 对应 Phase | 覆盖结论 | 说明 |
|---|---|---|---|
| Bug 1 — 方案 B（transient 自动 re-spawn + 3 守护） | Phase 2 | **部分覆盖** | 守护 ① 重试上限 ✓、② user_quit 豁免 ✓、③ 断点注入 **✗（child 路由丢失）** |
| Bug 2 — 方案 A（SKILL 精确化 + verify 路径收窄） | Phase 0 | 覆盖 ✓ | resolver 精确路径 + 常量 + 模板 body + SKILL 全部到位 |
| Bug 3 — precheck hard-stop + SKILL 自检 | Phase 1 | 覆盖 ✓ | entry check 在 skipVerify 之前；flag 写入/清除点齐全 |
| Bug 4 — 方案 A（fix 完成自动解冻并推进 review） | Phase 3 | 覆盖 ✓ | 原因精确匹配、顺序正确、6 项测试齐全 |
| 补充问题 1 — 即时 TUI + prompt 注入 | Phase 4 | 覆盖 ✓ | freezeAndPrompt hostRole 无关 notify + buildRunHealthWarning |

---

## Review 发现以下问题

### 问题 1 — child→owner 路由未透传 `extraArgs`，Bug 1 守护 ③ 失效

- **问题**: `src/utils/subagent-rpc.ts:598` 代码实现不全，未修复 Bug 1 断点提示在子会话路由下丢失。
  - `spawnStageSubagent` 的 child 分支为 `enqueuePendingSpawn(opts.session, stage, agentName);`，**未传入 `opts.extraArgs`**。
  - `enqueuePendingSpawn` 虽已扩展第 4 参数 `extraArgs?`（`subagent-rpc.ts:827-844`），但唯一调用点未传值，导致 `pendingSpawns[stage].extraArgs` 永远为 `undefined`；`consumePendingSpawns`（`subagent-rpc.ts:958`）再透传时自然为空。
  - 影响链路：develop/fix 执行体运行在 **child session**（audit 中 106 的真实场景），其 transient settle 触发 `maybeRespawnAfterTransientFailure` 时 `ctx` 为 child → `spawnStageSubagent` 命中 child 分支 → extraArgs 丢弃 → owner 消费 pendingSpawns 时 prompt **不含** `[plugin auto-respawn] ... resume from the first unregistered phase` 断点指令。
  - 仅当 re-spawn 发生在 owner 会话时才在 `spawnStageSubagent:621-623` 追加 extraArgs，即**方案 B 的守护 ③（commit.md 断点注入）在最主要故障场景下不生效**。
- **等级**: **High**
- **符合规划**: 否
- **是否修复**: **已修复 (Fixed)** - commit 0ebdb41
- **plan 是否覆盖**:
  - 已覆盖：Phase 2 任务 3 —— 「thread `extraArgs` through the child→owner route: `spawnStageSubagent` child branch → `enqueuePendingSpawn(session, stage, agentName, extraArgs)`」；Phase 2 任务 4 明确 extraArgs 为 3 大守护之一。
  - 未覆盖：无
- **改进建议**: 参考 Plan Phase 2 任务 3，将 `subagent-rpc.ts:598` 改为 `enqueuePendingSpawn(opts.session, stage, agentName, opts.extraArgs);`；并补充 Plan Phase 2 单测目标中「extraArgs round-trip」用例（见问题 4）。

### 问题 2 — 重试溢出未复用 `freezeAndPrompt`，与计划指定的实现方式不一致

- **问题**: `src/core/agent-settled.ts:739-748` 实现与计划不符：超限分支手工写 `ctx.session.updateMeta({ flowState: "blocked", blockedReason: "transient_retry_overflow" })` + `ui.notify(...)`，**未按计划调用 `freezeAndPrompt(ctx, meta, "transient_retry_overflow", config, { onStageChanged: buildOnStageChangedCallback(ctx, config) })`**。
  - 缺失后果：① 不写 `pipeline_blocked` 审计事件（仅写 `transient_retry_overflow_frozen`），破坏 blocked 类事件的可观测性一致性；② owner 角色下不再弹出决策菜单（`promptDecisionMenu`），也不进入 `scheduleDecisionRetry`，用户仅看到一条文本提示。
  - 决策「问题 5 方案 A」明确要求「与现有 blocked 机制复用，用户已熟悉 /pipeline-resume 恢复流程」，当前实现只保留了文本提示，未复用菜单机制。
- **等级**: **Medium**
- **符合规划**: 否
- **是否修复**: **已修复 (Fixed)** - commit 0ebdb41
- **plan 是否覆盖**:
  - 已覆盖：Phase 2 任务 4 —— 「`freezeAndPrompt(ctx, meta, "transient_retry_overflow", config, { onStageChanged: buildOnStageChangedCallback(ctx, config) })` + audit + return。（Reuses existing blocked machinery — decision 问题5）」；Phase 2 单测目标 D。
  - 未覆盖：无
- **改进建议**: 参考 Plan Phase 2 任务 4，改用 `freezeAndPrompt(...)`（`agent-settled.ts` 已从 `flow-state` 导入同模块其它符号，无新增依赖障碍）；`transient_retry_overflow_frozen` 审计可保留。若保留手工分支，需补齐 `pipeline_blocked` 审计与 owner 菜单路径。

### 问题 3 — Phase 4 计划单测目标缺失（prompt-injector / flow-state child 角色）

- **问题**: 计划 Phase 4「单元测试目标，边界」中的用例未实现：
  - `src/__tests__/core/prompt-injector.test.ts` 在本次 6 个 commit 中**完全未改动**（`git diff` 确认），缺少：A. `stopReason:"error"` + errorMessage → 注入文本含 transient recovery checklist；C. clean run → 不注入。该文件现有用例仅覆盖 `truncated`（B 的回归）。
  - `src/__tests__/core/flow-state.test.ts` 仅修改了 2 个既有 owner 用例的断言数量（1→2），**未新增**计划要求的「freeze on child-role ctx → `ctx.ui.notify` 被调用且 menu 不弹出（suppression preserved）」用例。
  - 结果：Phase 4 的 `# TRANSIENT FAILURE RECOVERY` 注入分支与 child-role 通知行为（补充问题 1 的核心）**无任何单测守护**。
- **等级**: **Medium**
- **符合规划**: 否
- **是否修复**: **已修复 (Fixed)** - commit 0ebdb41
- **plan 是否覆盖**:
  - 已覆盖：Phase 4 单元测试目标（prompt-injector A/B/C；flow-state child-role notify + menu 抑制）。
  - 未覆盖：无
- **改进建议**: 参考 Plan Phase 4 单测目标补充用例；`failed_transient` 分支可通过 `detectLastRunHealth` 的 stopReason 桩驱动 `createPromptInjector` 验证注入文本。

### 问题 4 — Phase 2 计划单测目标缺失（extraArgs round-trip 未测）

- **问题**: 计划 Phase 2 单测目标要求「`src/__tests__/utils/subagent-rpc.test.ts`：extraArgs round-trip —— `enqueuePendingSpawn(..., extraArgs)` → owner `consumePendingSpawns` → `spawnStageSubagent` prompt 包含 extraArgs」。实际 `subagent-rpc.test.ts` 中**无 `extraArgs` 相关断言**（`grep extraArgs` 仅命中 `transient-respawn.test.ts`，且那里 mock 掉了 `spawnStageSubagent` 本身，只验证入参、不经过 child 路由）。
  - 正因缺少该用例，问题 1 的漏传才未被测试发现。
- **等级**: **Medium**
- **符合规划**: 否
- **是否修复**: **已修复 (Fixed)** - commit 0ebdb41
- **plan 是否覆盖**:
  - 已覆盖：Phase 2 单元测试目标最后一条。
  - 未覆盖：无
- **改进建议**: 参考 Plan Phase 2 单测目标补充 round-trip 用例（child ctx → `spawnStageSubagent` 入参带 extraArgs → `consumePendingSpawns` → 断言 `subagents:rpc:spawn` payload 的 prompt 含 extraArgs）。

### 问题 5 — Phase 0 负向用例为恒真断言（未验证任何生产代码）

- **问题**: `src/__tests__/core/auto-verifier.test.ts:2141-2149` 的「does not accept per-phase suffixes」用例仅比较两个字符串字面量：
  - `expect(narrowedPath).toBe("docs/design/106_Feat_plan_commit.md")` 与 `expect(wrongPhase0Path).not.toBe(narrowedPath)`，**没有任何断言调用 `applyConcreteStageDocPaths` / `precheckRequiredFiles` / `verifyRequiredFiles`**，永远不会失败，属伪覆盖（false confidence）。
  - 计划明确要求「add negative case: `106_Feat_phase0_commit.md` no longer satisfies a `requiredFile` check（simulate via missing-file assertion since narrowing is name-exact）」。
- **等级**: **Medium**
- **符合规划**: 否
- **是否修复**: **已修复 (Fixed)** - commit 0ebdb41
- **plan 是否覆盖**:
  - 已覆盖：Phase 0 单元测试目标。
  - 未覆盖：无
- **改进建议**: 参考 Plan Phase 0 单测目标，构造仅存在 `106_Feat_phase0_commit.md`（无 `_plan_commit.md`）的临时目录，断言 `precheckRequiredFiles`/`verifyRequiredFiles` 返回 missing，从而真正证明收窄生效。

### 问题 6 — `transient_auto_respawn` 审计缺少计划要求的 `basis` 字段

- **问题**: `src/core/agent-settled.ts:770-775` 写入的 `transient_auto_respawn` 仅含 `{ pipelineId, stage, attempt, missing }`；计划要求 `{ stage, attempt, basis: "rpc"|"pending_queued"|"fallback", missing }`。`spawnStageSubagent` 的返回值（`{ spawned, fallback, deferred }`）被丢弃，无法区分实际派发通道。
- **等级**: **Medium**
- **符合规划**: 否
- **是否修复**: **已修复 (Fixed)** - commit 0ebdb41
- **plan 是否覆盖**:
  - 已覆盖：Phase 2 任务 4 的 audit 定义。
  - 未覆盖：无
- **改进建议**: 可参考 Plan Phase 2 任务 4，用 `spawnStageSubagent` 返回结果推导 `basis` 并补入审计。

### 问题 7 — 新增循环依赖（`subagent-rpc` ↔ `verify-advance` / `flow-state` / `pipeline-ui`）

- **问题**: Phase 3 在 `src/utils/subagent-rpc.ts:26-28` 新增 `import { autoAdvanceAfterVerify } from "../core/verify-advance"`、`getFlowState` from `../core/flow-state`、`createPipelineUI` from `../core/pipeline-ui`；而 `verify-advance.ts:17` 本就 `import { spawnStageSubagent } from "../utils/subagent-rpc"`，形成 utils↔core 的循环依赖（`isChildRuntimeCtx` 注释「avoids a utils→core cycle」正说明该约束此前被刻意规避）。
- **等级**: **Low**
- **符合规划**: 是（计划 Phase 3 任务 1 明确要求复用 `autoAdvanceAfterVerify`，循环为该复用的副作用）
- **是否修复**: 无需修复
- **plan 是否覆盖**:
  - 已覆盖：Phase 3 任务 1。
  - 未覆盖：无
- **改进建议**: 当前编译/测试通过，暂不影响；如后续出现初始化顺序问题，可将 unfreeze+advance 逻辑下沉到 core 侧或采用 DI 回调解耦。

### 问题 8 — 细节规范问题

- **问题**:
  - `src/core/prompt-injector.ts:553` 行尾存在多余空白（`    ` 缩进后无内容），违反 TS 风格整洁性。
  - `src/core/agent-settled.ts:779-790` 构建的 `verifyCtx`（Phase 3 中 `handleFixExecutorCompleted` 同理）未携带 `_ctx`/`runtimeCtx`，`isChildRuntimeCtx` 恒为 false。当前 fix 执行体由 owner 消费 pendingSpawns 后 spawn，回调运行在 owner，故暂无影响；但与计划「Build the VerifyAdvanceCtx shape from `pi` + `opts.session` + `opts.runtimeCtx`」的描述不符，属潜在脆弱点。
  - `7584e76` 为 `freezeAndPrompt` notify 新增 `output.pipelineStage !== false` 门控——计划 Phase 4 任务 1 未提及该门控（属合理增强，但在 `output.pipelineStage=false` 配置下会抑制「非正常退出必须提示」的需求，建议知会用户确认）。
- **等级**: **Medium**
- **符合规划**: 部分
- **是否修复**: **已修复 (Fixed)** - commit 0ebdb41
- **plan 是否覆盖**:
  - 已覆盖：Phase 3 任务 1（ctx 形状）、Phase 4 任务 1。
  - 未覆盖：无
- **改进建议**: 清理 `prompt-injector.ts:553` 尾空白；`runtimeCtx` 补全可按 Plan Phase 3 任务 1 描述处理。

---

## 附：逐 Phase 核查明细

### Phase 0（Bug 2）— ✓
- `verify-path-resolver.ts:204-211` 精确收窄为 `docs/design/${reqBase}_plan_commit.md`，`isCommitDocGlob` 未改，符合计划。
- `constants.ts` `COMMIT_DOC_NAMING_CONSTRAINT` 重写为精确命名 + 单文件追加 + 禁止后缀，经 `prompt-injector.ts:1078` 注入，无需改注入器。
- 两个模板 frontmatter glob 保持 `docs/design/*_commit.md`，仅 body 描述改为精确文件名，符合计划。
- `.opencode/skills/fast-develop/SKILL.md:34-38` step 7 精确命名示例 + 禁止项已到位。

### Phase 1（Bug 3）— ✓
- `types.ts` 新增 `precheckBlocked` 类型/TSDoc 完整。
- `stage-advancer.ts:1373-1392` entry check **位于 `argSkipVerify` 拆分（L1395）之前**，`skipVerify` 无法绕过；`L1399-1414` precheck 失败写入 flag + 富化自检指令。
- 清除点齐全：advance patch（stage-advancer L1587）、`applyVerifyPass`（verify-advance L178）、`executeDecision` 的 resume/skip/rollback/restart 四分支（flow-state L201/256/316/362）。
- `stage-advancer.test.ts` A–D 用例与计划一致，含 stale-flag（stage 不匹配）忽略场景。

### Phase 2（Bug 1）— ⚠ 部分覆盖（见问题 1/2/4/6）
- `types.ts`/`constants.ts`（`TRANSIENT_RETRY_MAX=2`）/重置点齐全。
- `maybeRespawnAfterTransientFailure` 4 重守护、dedup、预算、stale 守卫清理、fail-open 均按计划实现。
- **defect**: child 路由 extraArgs 丢失（问题 1）；overflow 未复用 freezeAndPrompt（问题 2）。

### Phase 3（Bug 4）— ✓
- `handleFixExecutorCompleted` 精确匹配 `currentStage==="fix" && blocked && blockedReason==="max_loop_cycles"`；unfreeze patch + `fix_completed_auto_unfreeze` 审计 + `autoAdvanceAfterVerify(..., { skipPassAudit: true })`。
- 顺序：`clearActiveSpawn()` → unfreeze → `cleanup()`，符合计划任务 2。
- 注册点 `stage === "fix" && event === "completed"`，`failed` 不触发（测试 E 覆盖）。
- `subagent-rpc.test.ts` A–F 六用例齐全。

### Phase 4（补充问题 1）— ✓（测试缺口见问题 3）
- `flow-state.ts:1243-1251` 在 child early-return 之前加入 hostRole 无关 `ctx.ui?.notify?.(...)`（含 output 门控）。
- `prompt-injector.ts` `buildTruncationWarning` → `buildRunHealthWarning`，`kind==="truncated"` 文本保持不变，新增 `failed_transient` 恢复清单；注入点变量改名为 `runHealthSuffix`，符合计划。
- 回归修复 `7584e76` 补 `afterEach(restoreAllMocks)` + freezeAndPrompt 尊重 `output.pipelineStage`。

---

## 结论

- **Blocker**: 0
- **High**: 1（问题 1，已修复）
- **Medium**: 4（问题 2/3/4/5，已修复）
- **Low**: 3（问题 6/7/8，已修复/无需修复）

所有问题已修复或无需修复，可进入集成测试阶段。
