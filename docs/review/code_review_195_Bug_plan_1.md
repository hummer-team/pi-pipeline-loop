**pipeline**: pipe-1791459668110-z71xr5

# Summary

- plan 文档：`docs/design/195_Bug_plan.md`（Rev.4，sha256 `8f5c6c2b…b42f53`，`shasum -a 256` 复核一致；文件头自述仍为 "Rev.3"，属文档版本标注滞后）
- commit 链：`3994e78`（基线）→ P0 `32a4f43` → … → P10 `ef17d9c`（HEAD，工作区 clean），共 23 个 dev commit，diff 范围 `3994e78..ef17d9c`（53 文件；生产文件 26 个 + 新增 `src/utils/guard-conflict-report.ts`，其余为测试/模板/guide）
- 评审方式：逐 Phase 对照 plan 任务/硬约束/验收条目，核实 **commit diff + HEAD 实际源码 + 真实调用链**（不采信 commit doc 与 ledger 的自述结论）；对 develop 阶段 `docs/design/issue-195-code-review-ledger.md` 已裁定项 ①②③⑪ 做显式复核（问题 8/9/10）
- 独立复跑验证：`bun run build` ✓（tsc + template 拷贝）；`bun run typecheck` ✓（`tsconfig.json` + `tsconfig.test.json` 双配置 0 err）；`bun run test` **第 1 次 3980 pass / 1 fail**（194 文件）、**第 2 次 3981 pass / 0 fail / 194 文件**（详见 LOW 表第 11 项）
- 未执行/未核实：plan 附录 C 要求的"现场重演"依赖 vaultmind 等价配置与真实 pi 会话，本地不可复现，故只评代码与审计契约
- **结论：不通过** —— 3 项 High（附录 B NEW 事件名契约破损 ×2、owner 补弹机制在子会话侧被提前消费）+ 10 项 Medium 待修复；无 Blocker

## Review 范围

| 维度 | 覆盖面 |
|---|---|
| Phase 0–10 任务完成度 | P0 常量/字段一次性声明、P1 交付物豁免 + glob 收窄、P2 fail-fast、P3 `classifyVisitEdge` 五子句、P4 `effectiveMax` 15 点统一、P5 两个新决策动作、P6 菜单裁剪/无静默解冻、P7 违规分桶、P8 pending 归属、P9 事件三元组、P10 回归 |
| 类型与空值安全 | `VerifyAdvanceCtx.config` 必须性、新增 `any` 与 `as unknown as` 转换、`ParsedVerifyFile.parseError` 新增可选字段 |
| 回归与副作用 | `recordStageVisit` 签名 8 处调用点、`budgetLimitOf` 语义解耦（`maxLoopCycles` → `DEFAULT_EXECUTOR_FAILURE_BUDGET`）、`types.ts` 类型重导出面 |
| 审计契约 | 附录 B 事件名二分表（新增 8 个 + 复用若干）逐条核对 write point 与字段；`writeAuditLog`/`safeWriteAuditLog` 首参语义 |
| 日志/配置安全 | 日志英文、级别、上下文载荷；无硬编码密钥（本次变更无敏感常量） |
| YAGNI / 最小干预 | 新增模块必要性、模板文件改动面、死代码（`describeFrozenBlocked`） |

## Review发现以下问题

### 问题 1
- 问题: `src/core/tool-guard.ts:573-581` 与 `:1393-1400` —— 附录 B NEW 事件 `readonly_exempt_applied`（plan:156/579，写点 `checkStageWriteBlock` 豁免命中；字段 `stage/relPath/tool`）**事件名未落地**：两处均写成 `await safeWriteAuditLog(meta.currentStage, { readonly_exempt_applied: "tool=…, path=…" }, "info")`。而 `safeWriteAuditLog(stage, message?, level?)`（`src/utils/auditLog.ts:140-144`）**首参即事件名**，故实际落盘事件名为阶段名（`develop`/`fix`），豁免事实退化为消息体内的一个字符串字段，且字段契约（stage/relPath/tool 三字段）与 plan 不符（单个拼接字符串）。
- 等级：High
- 符合规划：否
- 是否修复：已修复
- 改进建议：
  1. 两个写点改为 `await safeWriteAuditLog("readonly_exempt_applied", { pipelineId: meta.pipelineId, stage: meta.currentStage, relPath, tool: "bash" / toolName }, "info")`，与附录 B 字段一一对应。
  2. `src/__tests__/core/tool-guard-deliverable-exempt.test.ts:182/215` 现仅断言 `toContain("readonly_exempt_applied")`——该子串在消息体内也成立，**恰好掩盖本缺陷**；改为断言 `events.find(e => e.stage === "readonly_exempt_applied")` 并校验三字段。
  3. commit doc 静态自查 ①（"diff 内新增 `writeAuditLog("…")` 字面名 3 个"）用的是**字面量 grep**，未覆盖 `safeWriteAuditLog` 站点、亦未与附录 B NEW 清单做双向差集，属自查口径过窄；建议复查口径改为"附录 B 每个 NEW 事件名在 src 内第一参出现次数 ≥1"。

### 问题 2
- 问题: `src/utils/stage-visit.ts` C4 分支 —— plan（:241 真值表、:275、附录 B:580 "`visit_edge_unclassified` NEW：stage-visit.ts C4 兜底（P3），一次性，防静默漏计"）要求的兜底审计**完全未实现**：`rg -n 'visit_edge_unclassified' src/` = **0 命中**，C4 仅返回 `{ kind: "unclassified", counted: false }` 并留一行注释。另核实 `classifyVisitEdge` 返回的 `edgeKind`/`counted` 在生产代码内**无任何消费方**（仅定义/返回 + 测试断言），故该审计是 C4 情形唯一的可观测通道。
- 等级：High
- 符合规划：否
- 是否修复：已修复
- 改进建议：
  1. 在 C4 分支按"一次性"语义写 `visit_edge_unclassified`（携带 `pipelineId/stage/source/target` 或 `stageVisitOrder` 末段），并复用既有节流工具（`src/utils/audit-throttle.ts`）避免高频刷盘。
  2. `stage-visit.test.ts:154` 现仅断言 kind/counted，补断言 `e.stage === "visit_edge_unclassified"`。
  3. 与问题 4 联动：`ctx.config` 为 `undefined` 的调用路径会使 C0–C3 全部退化到 C4，本审计缺失即"静默漏计"，修复后可自证该退化。

### 问题 3
- 问题: `src/core/flow-state.ts:1331-1338` —— `menuEscalationPending` 在 `promptDecisionMenu` **函数体最顶端**被清空并写 `menu_escalation_consumed`，位置**早于**：(a) `buildDecisionMenu` 与 `!menu`（aborted）提前返回（:1341-1352）；(b) owner-only 子会话闸（:1359 `pipeline_menu_suppressed_child`）。而该标志仅由 `freezeAndPrompt` 在 `hostRole === "child"` 时置位（:1679-1685），plan（:386/:393/:401/:407、附录 B:584 "子会话登记 / owner 消费"）要求"子会话冻结 → owner 补弹一次且仅一次"。实际后果：任何子会话触达 `promptDecisionMenu`（`commands/pipeline-resume.ts:286`、`commands/pipeline-start.ts:1330/1367`、`core/agent-settled.ts:147`、`core/session-starter.ts:660`）都会**先替 owner 消费掉**一次性标志，随后被自身子会话闸抑制、不渲染菜单；owner 侧后续 settle/shortcut/replay 读到 `menuEscalationPending === false` → 永不补弹，且审计 `menu_escalation_consumed` 错误地把消费记为已发生。owner 侧不存在任何其它消费点（`rg 'menuEscalationPending' src/ --glob '!__tests__'` 仅 types.ts 声明 + flow-state.ts:1332/1680 两处）。
- 等级：High
- 符合规划：否
- 是否修复：已修复
- 改进建议：
  1. 将消费块（清标志 + `menu_escalation_consumed`）下移到子会话闸与 `!menu` 判定**之后**，即仅在"owner 且确实渲染菜单"的分支内执行；`menu_escalation_consumed` 写点保持 flow-state.ts（附录 B:584）不变。
  2. 补一条对应用例：子会话 ctx 调 `promptDecisionMenu` 后断言 `menuEscalationPending` **仍为 true**、无 `menu_escalation_consumed`；owner ctx 调一次后断言置 false 且审计恰 1 条（现有 `flow-state.test.ts:1775-1880` 全部以 owner ctx 直调，无法覆盖该顺序缺陷）。
  3. aborted（`!menu`）分支不得消耗一次性标志——同样纳入用例。

### 问题 4
- 问题: `src/tools/pipeline-verify.ts:79-86` + `src/core/verify-advance.ts:47` —— P4 给 `VerifyAdvanceCtx` **新增必填** `config: PipelineConfig`（基线无此字段），同时给 `pipeline-verify.ts` 的 `sessionCtx = ctx as {...}` **类型字面量**补了 `config: PipelineConfig;`，但该对象是运行期 `ExtensionContext` 的原样转换，**运行期不存在 `config` 属性**。于是工具路径经 `applyVerifyPass(sessionCtx, …)`（:278）进入 `verify-advance.ts:209/210/223/224` 时 `ctx.config === undefined`：`effectiveMax(meta, undefined)` 使 plan P4 任务"verify-advance:198 补 config 兜底"在该路径**失效**（仅剩 `meta.maxLoopCycles ?? DEFAULT`），`recordStageVisit(meta, nextStage, max, undefined)` 亦无法完成 C0–C3 判定（依赖 `config.stages`）→ 全部落入 C4/unclassified（叠加问题 2 即静默）。`effectiveMax` 自身对 `undefined` 容忍（`src/utils/stage-visit.ts:207-212`）故无 NPE，但"声明必填而实际 undefined"属类型谎报。develop ledger ① 为该必填性给出"运行时防御"理由，本路径使之不成立。
- 等级：Medium
- 符合规划：否
- 是否修复：已修复
- 改进建议：在工具路径显式构造携带 config 的 ctx（如 `applyVerifyPass({ session: sessionCtx.session, ui: sessionCtx.ui, pi: sessionCtx.pi, _ctx: sessionCtx._ctx, config }, …)`）；或把 `VerifyAdvanceCtx.config` 降级为可选并在 `verify-advance.ts` 内做显式 `config ??` 归一。二者择一，禁止用类型断言伪造必填字段。

### 问题 5
- 问题: `src/core/flow-state.ts:749-772`（`set_budget`）与 `:794-797`/`:810-813`（`rewind_last_round`）—— 拒绝路径**零审计**：`set_budget` 的 5 个拒绝返回（未冻结 / budgetValue 缺失 / 非正数 / ≤ 当前计数 / 一次性上限）与 `rewind_last_round` 的一次性上限拒绝、终态 gate 拒绝都只 `return { success: false, message }`，不写 `pipeline_decision`；仅 gate 为 null 时写 `rewind_target_unresolved`（:799）。plan（:349 "两者均由 `executeDecision` 承担并写 `pipeline_decision`"、:353 "拒绝路径不改状态、写 `pipeline_decision` 记 `success:false`（与 set_budget 拒绝形态一致）"、:363 验收"断言…`pipeline_decision` 记录"）要求拒绝可留痕。
- 等级：Medium
- 符合规划：否
- 是否修复：已修复
- 改进建议：为两个 case 抽出统一的拒绝出口（写 `pipeline_decision`：`decision` + `success: false` + `reason` + `source`），消除 7 处重复返回；补单测断言"二次 `set_budget`/二次 `rewind` 被拒时恰 1 条 `pipeline_decision` 且 `success=false`"。

### 问题 6
- 问题: `src/core/flow-state.ts:822-831` —— `rewind_last_round` 成功的状态迁移只写 `currentStage/previousStage/loopCycleCount: 0/loopRewindCount/flowState/blockedReason/stageVisitOrder`，**未清理** `violations`（P7 分桶熔断计数）、`verifyAttempts`、`verifyFailures`、`loopCount`、`currentStepIndex`、`stageStartTime`、`dismissCount`、`confirmGateDeferredAt`、`transientRetryCount`、`reviewConclusionDeclared`；对照 `skip` 分支（:330-350）这些字段是**成组清理**的。后果：rewind 目的是"回到本轮返工起点 + 重造整轮预算"（plan N8/:354/:364），但残存的 `violations`/`verifyFailures` 会让下一轮首个违规或首个 verify 失败即再次冻结，部分场景下 rewind 形同无效。
- 等级：Medium
- 符合规划：否
- 是否修复：已修复
- 改进建议：复用 `skip` 分支同一份清理补丁（DRY，禁止再写第二份字段清单），随后按 plan:364 的现场序列（`…review, fix, review, fix, review, fix`）复跑断言 `violations/verifyFailures` 已清空。

### 问题 7
- 问题: plan:357（P5 任务 3，25-D 硬约束）要求 `rewind_last_round` 在 summary 侧"仅在 `195_Bug_plan_commit.md` 追加 `rolledBackFrom=<stage>` 标注，标注由 `generate_stage_summary` 现有通道写"。实际 `rg -n 'rolledBackFrom' src/` = **0 命中**；`src/tools/generate-summary.ts` 未被本次变更触及（不在 diff 文件集内），commit 文档中仅存在既有 `parent_stage: meta.previousStage`，语义不等价（后者是阶段标签，前者需表达"由某 stage 回退而来"的追溯标注）。
- 等级：Medium
- 符合规划：否
- 是否修复：已修复
- 改进建议：在 `generate_stage_summary` 现有产物通道内按 plan:357 追加该标注（不新增文件、不触碰工作区/git），并补一条断言"rewind 后生成的 summary 文本含 `rolledBackFrom=review`"。

### 问题 8
- 问题: `src/utils/guard-conflict-report.ts`（新增 202 行）—— P2 任务 1/2 的"与 `getStageDeliverableExemptions` 同源判定"未真正落实，存在四处空转/误导：(a) `:175` 用硬编码 `resolveCommitDocPath("plan")` 作为探针参数 → 实际探测 `docs/design/plan_plan_commit.md`（无意义路径），"冲突 i"的触发完全由该探针决定；(b) `:150-170` 的 requirementDoc 分支比对 `exemptions` 与 `allowedWritePaths`，但交付物路径**必然已在豁免集合内**，该分支恒真，退化为同义反复；(c) 交付物情形的文案沿用 `describeReadOnlyWriteConflict` 的"allowedReadOnlyPaths ∩ allowedWritePaths overlap"措辞，与真实成因（豁免与只读 glob 的契约关系）不符，会误导 owner；(d) `describeFrozenBlocked`（`:63`）为 plan P2 明确要求创建的导出函数，但生产代码 **0 调用点**（`rg` 仅定义处命中），属死代码。
- 等级：Medium
- 符合规划：否
- 是否修复：已修复
- 改进建议：探针路径改由 `getStageDeliverableExemptions(meta, stage)` 派生（与 tool-guard 判定单一来源，YAGNI）；删除恒真的同源比对分支或改为"豁免集合 ⊆ 只读集合补集"的真实判据；交付物情形使用独立文案；`describeFrozenBlocked` 要么接线到冻结提示，要么删除（plan 已要求创建，倾向接线）。

### 问题 9
- 问题: `remainingRounds` 口径**未扣减 `c0Used`**，与 plan N5 数值表（R1 ⇒ 4/5）不符：`src/core/flow-state.ts:1490`（`freezeAndPrompt` 的 `pipeline_blocked` 审计）、`src/core/verify-advance.ts:224`、`src/core/prompt-injector.ts:707`（`buildLowBudgetWarning`；:705 注释声称"derive from deriveReworkLoopGate … c0Used"，代码实为 `maxCycles - loopCycleCount`）。仅在 `max_loop_cycles` 冻结点两者偶然一致（均为 0/5），非回环冻结点相差 1。develop ledger ② 的"等价"理由经复核不成立。
- 等级：Medium
- 符合规划：否
- 是否修复：已修复
- 改进建议：抽一个共享 helper（如 `remainingRoundsOf(meta, config)`）统一三处，并由 `stageVisitOrder`/`deriveReworkLoopGate` 派生 c0Used；补一条数值表驱动单测（R1=4、R2=3 …），避免三处各自演进。

### 问题 10
- 问题: `src/core/agent-settled.ts:335-340/350/404` —— P8 的延迟上限治理条件为 `liveEvidence.basis !== "reserved"` 才复位、仅 `reserved` 路径计数与封顶；`probe_live`/`manual_live_probe` 等正向 basis 的延迟**无上限**，与 plan P8 任务 2 的"延迟上限 2"意图不一致。同时 plan:578 指定复用 `child_shutdown_probe_unavailable`，实现改用了 `probe_gave_up_after_delay`（:375，附录 B NEW），事件名与计划不符。另：`probeDeferralCount`/`probeDeferralStage`/`dispatchedProbeDeferrals` 三个 meta 字段在 P8 才加入，违反 plan I3 "所有新增 `SessionMeta` 字段统一在 Phase 0 声明"；归属校验只加了 `pipelineId`，plan 列出的是 session/pipelineId/stage/agent 四元。develop ledger ⑪ 已将本条挂起待裁定 → **review 裁定：维持为 Medium 待修复**（理由：上限语义与事件名都是可观测契约，非文案）。
- 等级：Medium
- 符合规划：否
- 是否修复：已修复
- 改进建议：延迟计数与上限对所有 basis 生效（或按 basis 分档并在 plan 修订中写明并附测试）；事件名与 plan 对齐；补齐四元归属校验。

### 问题 11
- 问题: `src/core/prompt-injector.ts:476-509`（`buildViolationPrompt` 分桶改写）—— P7 计划明确要求的两处文案侧行为未实现：(a) 任务 3 要求 `bash_destructive` 桶**明确"该类不触发冻结"**，实现只输出 `## bash_destructive (N)` 与条目，无任何"仅建议、不冻结"标注（`rg '不触发冻结|advisory' src/core/prompt-injector.ts` = 0 命中）；(b) 任务 2 要求 `bucketCount ≥ 5` 后"文案升级为收尾提示（仅提示）"，实现仅在 `violation-tracker.ts` 记录 `bucketLimit`（`DEFAULT_BASH_DESTRUCTIVE_PROMPT_MAX`），无任何文案升级。后果：模型仍可能把 bash 建议类违规误读为临近冻结，且计划要求的降级提示缺失。
- 等级：Medium
- 符合规划：否
- 是否修复：已修复
- 改进建议：按桶注入尾部说明（`bash_destructive` → "advisory only, does not trigger freeze"），并在 `bucketCount >= DEFAULT_BASH_DESTRUCTIVE_PROMPT_MAX` 时切换为收尾提示文案；补一条断言文本的用例（现无用例覆盖文案）。

### 问题 12
- 问题: `src/core/prompt-injector.ts:700-748`（`buildLowBudgetWarning`）—— 新增函数违反类型/健壮性规范：(a) `ctx?: any` 原始类型（禁止 raw 类型；调用点已有 `RuntimeCtx` 可用）；(b) `const { safeWriteAuditLog } = require('../utils/auditLog')`（:722）为函数内动态 require，而该模块**已在 :30 静态导入** `safeWriteAuditLog`；(c) 该 require 分支内 `safeWriteAuditLog(...)` **未 await**，异常会以 unhandled rejection 形式逃出 `try/catch`，"fail-open"意图失效（审计可能静默丢失）；(d) 三处 `catch {}` 为空，未按规范写 error 级日志与上下文；(e) `updateMeta({ loopBudgetWarned: true })` 失败被静默吞掉 → 一次性告警可能重复触发。
- 等级：Medium
- 符合规划：是（P4 任务 4 要求单次触发与审计，实现方式不合规）
- 是否修复：已修复
- 改进建议：改用具名类型（`ctx?: RuntimeCtx`）、删除动态 require 直接用静态导入、`await` 审计写入并把 catch 改为 `debug/error` 级日志；`updateMeta` 失败至少落一条 `warn`。附带修正 :904-911 新增块的缩进错位（见 LOW 表第 1 项）。

### 问题 13
- 问题: `src/utils/subagent-rpc.ts:655-670` —— P2 新增的冲突检查在 `spawnStageSubagent` 内使用 **4 处 `await import(...)`** 动态导入（每次 spawn 重复解析模块），且回调内出现 `describeWriteScope(policy as any)` 原始类型断言。另：新联合成员 `dispatchOutcome: "conflict_blocked"`（:688）在生产代码中**仅 1 个消费点**区分（`src/core/design-review/coordinator.ts:2320/2329`），其余 `spawnStageSubagent` 调用方按通用"未派发"分支处理，存在按未知结果重试/通用唤醒的残余风险（P2 任务 3 意图是冲突不得推进）。
- 等级：Medium
- 符合规划：是（动态导入与 `as any` 属实现方式问题，非计划缺项）
- 是否修复：已修复
- 改进建议：改为静态导入（若确有环，改用同函数内 `resolveDesignReviewWritePolicy` 同款 lazy callback 注入模式）；`policy as any` 改为显式类型收窄；对所有 `spawnStageSubagent` 调用方穷举 `StageDispatchOutcome`（`never` 兜底）确保 `conflict_blocked` 不进入通用唤醒/重试路径。

### LOW（不要求修复，建议顺手处理）

| # | 位置 | 说明 |
|---|---|---|
| 1 | `src/core/prompt-injector.ts:904-911` | P4 新增块缩进错位（`const lowBudgetWarning` 与 `const pluginPromptFull` 不同层级），纯格式 |
| 2 | `src/template/pipeline_loop.json` | 计划仅要求顶层补 `"maxLoopCycles": 5` 与两处 `*_plan.md` 收窄，实际把全文对象字面量整体展开（+63/-19），语义等价但改动面远超计划（最小干预原则），污染 blame |
| 3 | `src/types.ts:23` | 删除 `StageExecutor*` 的 `import type` 块（纯清理）；已核实这些名字仍在 `:28-39` 的 `export type { … } from "./core/stage-executor/contracts"` 内重导出，**公共 API 面无破坏** |
| 4 | `src/types.ts`（`ViolationItem`） | `guardSource` 字段被插在 `/** Unix timestamp … */` 文档注释与 `timestamp` 之间，注释错挂 |
| 5 | `src/core/verify-advance.ts:222`、`src/constants.ts`（`DEFAULT_BASH_DESTRUCTIVE_PROMPT_MAX`） | 陈旧注释："Max cycles from meta with default 3"（默认已为 5）；"Reserved for Phase 7"（P7 `violation-tracker.ts:77` 已接线） |
| 6 | `src/core/flow-state.ts`（`buildDecisionMenu(meta, blockedReason?, config?)`） | 第三参可选（计划为两参），若调用方遗漏 config 会静默忽略 config；当前仅菜单调用点传入，属潜在陷阱 |
| 7 | `src/core/flow-state.ts`（rewind 段） | `gate ∈ {completed, awaiting_human}` 分支在 `deriveReworkLoopGate` 已排除终态后**不可达**（死守卫） |
| 8 | `src/core/tool-guard.ts`（`checkBashFileTargets`） | 在逐目标循环内重复调用 `getStageDeliverableExemptions`（N 个目标 N 次推导），可提到循环外 |
| 9 | `src/core/stage-executor/terminal.ts`（`budgetLimitOf`） | 保留未使用形参并以 `void config;` 抑制告警，建议直接去掉形参 |
| 10 | `src/core/tool-guard.ts:295-303` | 豁免命中走 `return { status: "continue", exempted: true }`，同时跳过了后续 stage 写白名单分支；计划只授权"跳过只读拦截"，建议补注释说明或仅在读判定处短路 |
| 11 | `src/__tests__/integration/design-review-handoff-recovery.test.ts` | 全量首跑 `a duplicate terminal … duplicate_ignored` 失败（3980/1），单文件复跑与全量二跑均绿 → 与 commit doc "flaky 白名单仅 `pipeline-meta-transaction.test.ts` 一条"不符，白名单不完整（无功能影响，建议补白名单或定位计时器抖动） |

## 对 develop 阶段 ledger 的显式裁定

| ledger 项 | 裁定 |
|---|---|
| ① `effectiveMax` 签名放宽 / `VerifyAdvanceCtx.config` 必填的"运行时防御"理由 | **部分不成立**：见问题 4，`pipeline_verify` 工具路径的 config 兜底被类型断言伪装成必填而实际 `undefined`，需改实现而非维持必填 |
| ② `remainingRounds` 审计省略 `c0Used` 属"等价" | **不成立**：见问题 9，仅 `max_loop_cycles` 冻结点巧合一致 |
| ③ G1 glob 探针局限 | 认可为已知局限，本次不作为缺陷（问题 8 另指出探针路径本身无意义） |
| ⑤ `pipeline-start.ts` 死代码 | 本次未复现为独立缺陷，保留观察 |
| ⑪ verify 保留基（reserved）放弃语义 / P8 延迟上限 | **裁定为待修复**：见问题 10 |

## 结论
- 结论：**不通过**
- 待修复清单：问题 1、2、3（High）+ 问题 4–13（Medium），共 13 项；问题 1/2/3 分别对应附录 B 新增事件名契约与 P6 owner 补弹硬约束，建议优先修复以避免 plan 验收条目（附录 B 事件二分表、Phase 6 现场回归"子会话冻结 → owner 补弹一次且仅一次"）再次不成立
- 验证复现命令：`bun run build && bun run typecheck && bun run test`（评审实测：build ✓ / typecheck ✓ / test 3981 pass 与偶发 1 flaky 并存）；针对问题 1/2/4 的定点复现：`rg -n 'readonly_exempt_applied' src/core/tool-guard.ts`、`rg -n 'visit_edge_unclassified' src/`、`sed -n '79,90p' src/tools/pipeline-verify.ts`
