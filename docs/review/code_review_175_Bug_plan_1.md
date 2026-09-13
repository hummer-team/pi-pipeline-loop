# Summary
- Plan 文件：`docs/design/175_Bug_plan.md`（Phase 0-7）；跟踪文件 `docs/design/175_Bug_plan_commit.md`（dev commit id = `405ad6c` → `8aba5a5` → `fa0f043` → `7da93c0` → `96b9cbc` → `fb5fb71` → `d8d12f1` → `5c5150f`，共 8 个 Phase）；需求 `docs/design/175_Bug.md`。
- 审查范围：第 1 轮复核。对象 = 8 段开发提交的全量 diff（`e7f10e6..5c5150f`，37 文件 +1617/-123）。方法 = 逐 commit 比对 plan「任务 / 验收 / 测试目标 / 文件变更汇总 / Commit 规范 / 不需要做什么」，源码阅读核验语义，`bun run typecheck` + `bun run test` 实测验收，不采信自述。
- 范围合规：变更面与 plan「All Phase 文件变更汇总」大体吻合；`package.json` / `dist/` / `.opencode/` 零 diff，无越界改动。8 段 commit message 与 plan Commit 规范逐字一致。
- 实测验收：`bun run typecheck` 0 错；`bun run test` **2113 pass / 1 fail**（唯一失败 = `src/__tests__/template/template-agent-contract.test.ts:54` 期望 `permission` 字段，该测试与 `src/template/agents/` 均未被本期任何 commit 触碰，为存量失败、非本期回归）；本期新增/改动测试单跑 80 pass / 0 fail。
- 独立结论：发现 **1 项 Blocker + 3 项 High + 5 项 Medium + 3 项 LOW**。Phase 1、Phase 2（主语义）、Phase 4（主语义）、Phase 5（托管块主语义）、Phase 7（design SKILL）落地；**Phase 3 核心功能整体失效（Blocker）**，**Phase 5 任务 4 与 Phase 6 整段未实现（High）**。

## Review发现以下问题

### 问题 1
- 问题：`src/index.ts:293-298` `createPipelineFromJson` 未注入内部字段 `configSourcePath` / `configLoadedMtimeMs`（plan Phase 3 任务 1 明确要求，且文件变更汇总表列出 `src/index.ts`，但本期 8 段提交对 `src/index.ts` 零 diff）。`src/types.ts:704,711` 仅声明字段，`src/utils/config-staleness.ts:29-34` 读取之，全库 grep 无任何写入点。后果：`isConfigStale()` 因 `configSourcePath === undefined` 恒返回 false → `staleConfigNotice()` 恒 null → Phase 3 的 stale 检测、`/reload` 提示、session_start / `/pipeline-start` / `/pipeline-resume` 三触点、git block 消息附加提示全部为死代码。`src/__tests__/utils/config-staleness.test.ts:38-57` 通过 `makeTestConfig({ configSourcePath, configLoadedMtimeMs })` 手工注入字段，因此测试全绿却无法暴露生产链路断裂（假绿）。
- 等级：Blocker
- 符合规划：否
- 是否修复：已修复 (commit 939efc0)
- plan是否覆盖
  - 已覆盖：Phase 3 任务 1（`src/types.ts`+`src/index.ts` 注入 `configSourcePath`/`configLoadedMtimeMs`）；文件变更汇总表 `src/index.ts | 修改（记录 configSourcePath/loadedMtimeMs）| 3`
  - 未覆盖：无
- 改进建议：按 Plan Phase 3 任务 1，在 `createPipelineFromJson` 中 `statSync(resolvedPath)` 记录 `configLoadedMtimeMs` 并把 `resolvedPath` 写入 `configSourcePath`（IO 失败 fail-open 不写），并补一条「经 `createPipelineFromJson` 加载后 mtime 变化 → `staleConfigNotice` 非 null」的集成用例，防止再次假绿。

### 问题 2
- 问题：Phase 5 任务 4「session-starter 漂移通知：任意资产漂移 → 英文 notify 一次（计数+前 3 资产名+`re-run /pipeline-init`；guide.md 专项文案并入同条）」未实现。`src/core/session-starter.ts:285-305` 仍是 173 的旧逻辑：仅对 `drifts.some(d => d.asset === "guide.md")` 单资产 notify（文案 `guide.md is outdated — re-run /pipeline-init to overwrite.`），无计数、无前 3 资产名、其他 7 个 `DRIFT_CHECK_ASSETS` 漂移不通知。本期 `src/core/session-starter.ts` 仅含 Phase 3 stale notify 与 Phase 4 stale_startup 门控，无 Phase 5 漂移改动。
- 等级：High
- 符合规划：否
- 是否修复：已修复 (commit 57c000f)
- plan是否覆盖
  - 已覆盖：Phase 5 任务 4（R1Q2A）；文件变更汇总表 `src/core/session-starter.ts | 修改（… drift 全量 notify …）| 3, 4, 5`
  - 未覆盖：无
- 改进建议：按 Plan Phase 5 任务 4 实现：`drifts.length > 0` 时一次性英文 notify（总数 + 前 3 个 asset 名 + `re-run /pipeline-init`），guide.md 专项文案并入同条，补「多资产漂移计数/截断/一次性」「零漂移静默」用例。

### 问题 3
- 问题：Phase 6 未实现。commit `d8d12f1` 仅新增 `src/template/guide.md` §16 文档（+44 行），无任何代码改动：plan 任务 1 要求的 `verify-advance.ts` / `agent-settled.ts` / `stage-advancer.ts` 中 format 失败记录调用点核查与「`requiredFiles`/`fileContentPattern` 类失败退出 violations」改动缺失，任务 3 冻结文案核对缺失，任务 2 的行为违规计数保持（现状本就如此，无改动即无回归保护）。Phase 6 测试目标（连续 3 次格式失败 → violations 不增长、每次 `verify_fail_wake`、第 maxVerifyAttempts 次 `verify_attempt_overflow`；git_protected 3 连击仍 `violation_overflow`）全部未新增。注：全库 `trackViolation` 仅存在于 `src/core/tool-guard.ts`，`applyVerifyFail`（`src/core/verify-advance.ts:308-389`）只走 `verifyAttempts`+`verify_fail_wake`+`verify_attempt_overflow`，故当前行为可能已与需求 R2Q3A 一致，但 plan 要求的「审计调用点 + 红绿回归测试」交付物缺失，且 guide.md 现已对外声明该行为却无测试守护。
- 等级：High
- 符合规划：否
- 是否修复：已修复 (commits 0485b66 — 审计调用点确认 + 注释 + 回归测试)
  - 未覆盖：无
- 改进建议：按 Plan Phase 6 复核并落地：确认/补齐 format 失败不进 violations 的调用点（若现状已满足则在 `applyVerifyFail` 处加显式注释 + 回归断言防回退），新增「连续格式失败 violations 不增长 / 行为违规仍 `violation_overflow` / 混合互不污染」用例；否则重新评估 Phase 6 是否与需求文档事实（`trackViolation` 调用点不存在）一致后再调整方案。

### 问题 4
- 问题：Phase 0 任务 3「review 结论默认模式切换为双语+加粗形态」未落地。`src/template/references/review_spec/verify.md:7` 仍为旧单形态 `pattern: "结论：(通过|不通过)"`，而 `src/core/verify-generator.ts:104-108` 只在 `TEMPLATE_BUILTIN_CONTENT_PATTERNS`（hasCustom 白名单）里追加了新双语/加粗串。白名单只影响「存量 verify.md 是否判为 custom」，不改变 pipeline-init 部署的默认 review verify.md 内容（`collectTemplateFiles(TEMPLATE_DIR)` 原样拷贝该模板；`generateVerifyMdContent` 仅生成 file/command/git/keyword，不产出 fileContentPattern）。后果：新项目默认 review 校验仍拒绝 `结论：**通过**` / `Verdict: PASS` / `Conclusion: pass`，B7 事故场景在默认配置下未修复。
- 等级：High
- 符合规划：否
- 是否修复：已修复 (commit e9a58f8)
  - 未覆盖：文件变更汇总表仅列 `clarify_spec/verify.md`，未列 `review_spec/verify.md`（plan 自身清单有缺项）
- 改进建议：按 Plan Phase 0 任务 3，将 `src/template/references/review_spec/verify.md` 的 pattern 改为双语+加粗容忍形态（与 `CONTRACT_TOKENS.VERDICT_*` 单源一致），并补「模板默认 review verify.md 匹配 `结论：**通过**` / `Verdict: PASS`」用例。

### 问题 5
- 问题：Phase 4 任务 2 明确要求「提取与 `clearActiveSpawn` 共用的 helper 至 `session-state` 或 utils，**禁复制**」，但实现为在 `src/core/session-shutdown.ts:103-109` 与 `:117-119` 内联复制「`{...meta.activeSpawns}` → `delete stage` → `updateMeta`」清理逻辑（completed 分支还复制了 `spawnedStages` 清理），未新增/复用任何共享 helper（`src/utils/subagent-rpc.ts:514-522` 的 `clearActiveSpawn` 仍为私有闭包，`session-state` 无新增导出）。违反 plan 任务约束与 code_spec §3 DRY。
- 等级：Medium
- 符合规划：否
- 是否修复：已修复 (commit 5ae3b0c)
  - 未覆盖：无
- 改进建议：按 Plan Phase 4 任务 2 将 spawn 记录清理抽为 `session-state`（或 utils）共享函数，`session-shutdown.ts` 与 `subagent-rpc.ts` 共同引用。

### 问题 6
- 问题：Phase 4 任务 3（R1Q1A 观测性）部分未实现：① `reason=none` 已做（`session-shutdown.ts:78`）；② 「child quit 双写合并为单条 `session_shutdown_skipped`（字段并集）」未做 —— `:75-81` 仍写一条 `session_shutdown`、`:87-94` 再写一条 `session_shutdown_skipped`，仍为双写；③ 「同 sessionFile 无 reason 事件 10min 节流」未实现（`session_shutdown` 审计无任何节流，仅 notify 用 60s 节流）。
- 等级：Medium
- 符合规划：否
- 是否修复：已修复 (commit 01a27ea)
  - 未覆盖：无
- 改进建议：按 Plan Phase 4 任务 3 合并 child quit 双写为单条 `session_shutdown_skipped`（字段并集），并对同 sessionFile 的无 reason 事件加 10min 节流，补对应断言。

### 问题 7
- 问题：Phase 2 任务 3 明确「**删除**『无 agentId → 30min 时间窗』启发式的拦截用途（`checkLiveSpawn` 时间窗分支移除）」，但 `src/core/tool-guard.ts:63-108` 的 `checkLiveSpawn`（含 `ACTIVE_SPAWN_STALE_MS` 30min 分支）完整保留，且 3c 重构后已无任何生产调用点（全库仅定义处 + 测试名 + `prompt-injector.ts:855` 注释引用），成为死代码；`ACTIVE_SPAWN_STALE_MS` 仅被该死函数引用。
- 等级：Medium
- 符合规划：否
- 是否修复：已修复 (commit 9b0f023)
  - 未覆盖：无
- 改进建议：按 Plan Phase 2 任务 3 删除 `checkLiveSpawn` 与 `ACTIVE_SPAWN_STALE_MS`（或若 plan 意图仅移除拦截用途，则删除死函数并同步修正 `prompt-injector.ts:852-856` 中「aligned with tool-guard」的过时注释），保留 `activeSpawnNote` 自身 30min 可见性逻辑不变。

### 问题 8
- 问题：Phase 7 任务 2 要求交付件与 `DRIFT_CHECK_ASSETS` 全 8 项一一对应，验收亦要求「checklist 与 `DRIFT_CHECK_ASSETS` 清单一一对应（无缺项）」。但 `docs/design/175_Bug_skill_sync_checklist.md:16-25` 的 8 行包含 `references/clarify_spec/verify.md`（**不在** `DRIFT_CHECK_ASSETS`），却**缺少** `references/clarify_template.md`（`src/utils/template-drift.ts:48-57` 中确实在册）。同时第 51-59 行「基线参考」标注 `clarify_template e08920b424af`，与第 24 行资产 `clarify_spec/verify.md` 名称/对象不一致。
- 等级：Medium
- 符合规划：否
- 是否修复：已修复 (commit 8d839e5)
  - 未覆盖：无
- 改进建议：按 Plan Phase 7 任务 2 将 checklist 第 7 行改为 `references/clarify_template.md`（或同时列出两者并明确 clarify_spec/verify.md 为 Phase 0 附带项），使 8 行与 `DRIFT_CHECK_ASSETS` 逐项一致。

### 问题 9
- 问题：Phase 5 任务 3 要求托管块合并「写失败 **notify+error 审计**，fail-open 不阻断 init 其余产物」。`src/commands/pipeline-init.ts:312-318` 的 catch 仅 `safeWriteAuditLog("pipeline_init_managed_block_error", { error: errMsg }, "warn")`，既无 `ui.notify`，级别也为 warn 而非 error，且未记录失败的 stage/文件上下文。
- 等级：Medium
- 符合规划：否
- 是否修复：已修复 (commit 8453d95)
  - 未覆盖：无
- 改进建议：按 Plan Phase 5 任务 3 在 catch 中补英文 notify 与 `"error"` 级审计（含 stage / 目标文件路径上下文），保持 fail-open。

### 问题 10
- 问题：Phase 0 任务 2 要求「轮次标题与 latest-round 定位改用 constants 源」。`src/utils/clarify-args.ts:85-88` 的 latest-round `headingPattern` 仍硬编码 `^#{1,2}\\s*第\\s*${latestRound}\\s*轮澄清|^#{1,2}\\s*[Rr]ound\\s+${latestRound}`，未引用 `CONTRACT_TOKENS.ROUND_HEADING_*`，形成与 `ROUND_HEADING_PATTERN`（:40-43）并存的第二处正则定义，违反单一定义源（DRY）。
- 等级：LOW
- 符合规划：否
- 是否修复：无需修复（LOW，零行为风险）
- plan是否覆盖
  - 已覆盖：Phase 0 任务 2（改用 constants 源）
  - 未覆盖：无
- 改进建议：将 latest-round 定位改为基于 `CONTRACT_TOKENS` 源串拼接（或复用已提取的 match index），消除第二处硬编码。

### 问题 11
- 问题：Phase 1 任务 3 要求派生参数场景发一次性英文说明「参数由文档状态派生（round N）」。`src/commands/pipeline-start.ts:829-832` 的 notify 位于 `skipSpawn` 早退（:801-810）与 `!agentName` 早退（:812-816）之后，因此 `await-answer` / `confirmed` 派生分支只发 `skipMessage`，不会发该派生来源说明（`argsSource=derived` 审计也随之丢失）。
- 等级：LOW
- 符合规划：否（字面）；是（意图：skip 分支已有等价引导 notify，不阻断流程）
- 是否修复：无需修复（LOW）
- plan是否覆盖
  - 已覆盖：Phase 1 任务 3（派生 notify / `argsSource` 审计）
  - 未覆盖：skip 早退路径是否需补 notify 未明确
- 改进建议：如需严格对齐，在 `skipSpawn` 前发派生来源说明；否则在 plan 中明确 skip 分支以 `skipMessage` 覆盖即可。

### 问题 12
- 问题：Phase 3 任务 4 措辞为「git **block/forbidden** 消息与 suggestion 追加」策略来源与 stale 提示，但仅 `src/core/tool-guard.ts:478-497` 的 `gitPolicy === "block"` 分支被增强；`:464-474` 的 `isGitForbidden` 硬黑名单分支（`FORBIDDEN: git command matches forbidden pattern…`）未追加 `Policy source` / `protect.allow does NOT exempt` / stale 提示。
- 等级：LOW
- 符合规划：否（字面）；是（forbidden 属硬黑名单，非 `gitModify` 策略，附加策略键提示语义有限）
- 是否修复：无需修复（LOW）
- plan是否覆盖
  - 已覆盖：Phase 3 任务 4
  - 未覆盖：forbidden 分支是否需同样增强未明确
- 改进建议：若需字面对齐，在 forbidden 分支追加 stale 提示（策略来源对硬黑名单不适用）；否则在 plan 中注明该分支排除。

## 复核通过项（逐项独立实证）

| 项目 | 证据 | 结论 |
|---|---|---|
| 范围合规 | `e7f10e6..5c5150f` 变更面 37 文件；`package.json`/`dist/`/`.opencode/` 零 diff；8 段 commit message 与 plan 逐字一致；无重命名/移动越界 | 无越界 |
| Phase 0 双语 token 单源 | `src/constants.ts:331-373` `CONTRACT_TOKENS` 集中定义（ZH/EN 轮次、答字段、Option/Plan、模型确认、三类 verdict）；`clarify-args`（除 latest 定位外）、`review-conclusion.ts:92-95`、`verify-generator.ts:104-108` 均引用之；`CONFIRM_PATTERN` 去 `g` 修 lastIndex 隐患（:50-56） | 主语义落地（问题 4/10 见上） |
| Phase 0 clarify verify 模板 | `clarify_spec/verify.md:7` 新串与 `verify-generator.ts:93` 白名单逐字节一致；测试目标（`# Round 6`/`## round 3` 命中、`### 3.0 对 Round 2` 不命中、无标题 fresh）在 `clarify-args.test.ts`/`contract-tokens.test.ts` 覆盖 | 落地 |
| Phase 1 参数透传 | `command-args.ts:45-50` 新增 pipeline-resume 分支；`pipeline-resume.ts:34,109` 读取并透传 `forwardArgs`；`dispatchAfterResume`（pipeline-start.ts:562-593）6 参签名兼容；显式 description 逐字携带、派生 description 仅 `Clarify: {file}`、`argsSource`/`derivedRound` 审计齐备（:821-885）；Re-launch 硬性句落地 prompt-injector + yml | 主语义落地（问题 11 见上） |
| Phase 2 默认开启+证据型拦截 | `tool-guard.ts:657-690` 使能 `?? true`、拦截条件 = owner ∧ `SPAWN_TOOL_NAMES` ∧ 执行器同名 ∧（agentId+probe live ∨ reserved<60s），`basis` 审计、不计违规；`subagent-rpc.ts:524-551,553-595` reserved 写/清 + 成功 `writeGuard(agentId)` 转正 + in-flight `spawn_in_flight` 审计；`types.ts:514` 增 `reserved?`；调度文本单通道化（yml 3 处 + prompt-injector） | 主语义落地（问题 7 见上） |
| Phase 3 block 消息增强 | `tool-guard.ts:481-488` 三来源 `describeGitModifySource`（`protect.ts:288-315`）+ 正确键 + `protect.allow does NOT exempt` 子串 + stale 追加；测试断言齐备 | 落地（但整链因问题 1 恒不触发） |
| Phase 4 stale_startup 门控 | `session-starter.ts:354-390` owner-only abort（`!isChild`）、child running → 节流 `stale_suspect` 审计、`trigger.isSubagent` 语义；child shutdown 四分支（completed 幂等清理 / settled 清记录+节流英文 notify / unknown 仅审计 fail-open / live 不动）只读判定、绝不改 stage/flowState | 主语义落地（问题 5/6 见上） |
| Phase 5 托管块 | `skill-managed-block.ts` 标记常量 + `renderContractBlock`/`mergeManagedBlock`（原地替换/末尾追加、CRLF 归一、尾换行容忍）；`pipeline-init.ts:280-318` 五 stage 接入、幂等写；yml `stage_deliverable_*` 5 节点与 review verdict 双语形态增补；design SKILL 轮次契约（Phase 7）落地 | 主语义落地（问题 2/9 见上） |
| 验收门禁 | `bun run typecheck` 0 错；全量 2113 pass / 1 fail（存量无关失败，见 Summary）；本期新增/改动测试单跑 80 pass / 0 fail | 基本通过（存在 1 存量失败） |

## 总体结论

- **Blocker**：1 项（问题 1：Phase 3 配置过期检测因 `createPipelineFromJson` 未注入字段而整体失效，属「Phase 定义未实现」）。
- **High**：3 项（问题 2 Phase 5 漂移全量通知缺失；问题 3 Phase 6 整段未实现；问题 4 Phase 0 review 默认模式未切换）。
- **Medium**：5 项（问题 5 共享 helper 未提取；问题 6 Phase 4 观测性未完成；问题 7 `checkLiveSpawn` 时间窗死代码未删；问题 8 checklist 与 `DRIFT_CHECK_ASSETS` 不一致；问题 9 托管块写失败无 notify/error）。
- **LOW**：3 项（问题 10-12，无需修复）。
- **Phase 达成状态**：Phase 1、Phase 2（主语义）、Phase 4（主语义）、Phase 5（托管块主语义）、Phase 7（design SKILL）真实落地；Phase 0 主语义落地但 review 默认模式缺失；**Phase 3 核心功能不可用**；**Phase 6 仅有文档**。
- **待处理**：问题 1-9 均已修复，本轮闭合。
