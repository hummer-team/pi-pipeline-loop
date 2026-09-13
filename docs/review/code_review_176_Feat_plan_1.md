# Summary
- Plan 文件：`docs/design/176_Feat_plan.md`（Phase 0–4）；跟踪文件 `docs/design/176_Feat_plan_commit.md`（dev commit id = `5bcdc20`,`edddb9e`,`151a0ae`,`3b18f6c`,`0ae0678`,`cd42b83`；fix commit id = 空）。
- 审查范围：对 Phase 0–4 全部落地代码做对照复核；重点实证三项高风险面——175-G4 逐节严格性、旧式扁平 verify.md 向后兼容、运行时锚点接线的假绿风险。方法 = 阅读 6 段提交 diff 与最终源码 + **独立源码级实证**（用生产 `parseFrontmatter`/`loadVerifyContractAnchors`/`deriveClarifyForwardArgs`/`parseReviewConclusion`/`runVerification`/`precheckRequiredFiles`/`generateVerifyFiles`/`diagnoseVerifyConfig` 跑真实模板与反例）+ `bun run build`/`typecheck`/`test` 全量验收。
- 范围合规：6 段提交变更文件与 plan「All Phase 文件变更汇总」逐条对应；`package.json`/`.opencode/`/`dist/`（生成物）零源码 diff；`5bcdc20` 为 plan 明示的前置修复（模板 agent 无 `permission` 字段，基线红），改动仅删除失效断言，可接受。
- 实测验收：`bun run build` 0 错；`bun run typecheck` 0 错；`bun test` 5 次运行中 4 次 **2169 pass / 0 fail（89 files）**，1 次出现 1 fail（`subagent-rpc.test.ts > spawnClarifySubagent > returns ok:false on timeout`，存量 flaky，非本 plan diff 引入，详见观察项 4）。
- 独立结论：**三层布尔引擎、when/scope 逐节、contract-loader fail-open、5 模板、guide §9.4.B 均真实落地并经生产路径验证**；但发现 **2 项 High + 2 项 Medium 待修复**：`precheckRequiredFiles` 未接入 groups 导致 168 预检对 v6 模板整体失效；旧式扁平 verify.md 的**自定义 fileContentPattern 在 init merge 时被静默丢弃**（数据丢失且守护断言被反向改写）；agent-settled `contract-unavailable` 分支缺 plan 强制要求的红绿集成断言；锚点 issues 过度触发 clarify fresh 降级。

## Review发现以下问题

### 问题 1
- 问题：`src/core/auto-verifier.ts:632-681` 的 `precheckRequiredFiles` 仅读取扁平 `rules.requiredFiles`（L650/L662/L667），未遍历 `rules.groups[].rules` 中的 `requiredFile` 节点。Phase 3 已把 5 模板的 `requiredFile` 全部移入 groups（`src/template/references/review_spec/verify.md:8`、`plan_spec/verify.md:8`、`develop_spec/verify.md:8`、`fix_spec/verify.md:8`），导致该预检对 v6 模板恒返回 `passed=true`。该函数是生产链路：`src/core/agent-settled.ts:300`（168 Phase 0「产物未产出→静默跳过验证，不计数/不冻结/不唤醒」）、`src/core/stage-advancer.ts:933`（`stage_advance` 工具预检，返回 `precheck:true` 引导而非验证失败）、`src/tools/pipeline-verify.ts:126`。实证：同一 review 阶段无评审报告时，v6 模板预检 `{"passed":true,"missing":[]}`，旧扁平模板 `{"passed":false,"missing":["docs/review/code_review_*.md"]}`。
- 等级：High
- 符合规划：否
- 是否修复：已修复（fix commit 3ac8ac894：precheckRequiredFiles 改为遍历 groups[].rules[] 中 type=requiredFile 节点，继承文件级 path，新增 3 个 v6 模板测试用例）
- plan是否覆盖
  - 已覆盖：Phase 4 目标「175/162/168/172 既有行为矩阵在新机制下等价通过」
  - 未覆盖：Plan 未覆盖——「All Phase 文件变更汇总」对 `auto-verifier.ts` 仅列「executeStructuredRules 接组引擎、group 字段、defer/占位符/glob 穿透、precheckClarifyAwaitAnswer 装载 anchors、resolveVerifyFilePath 提取引用」，未列 `precheckRequiredFiles` 的 groups 适配。建议重新设计方案：把预检改为遍历 groups 内 `requiredFile` 节点（含文件级 `path` 继承与 glob 具体化），或明确废弃该预检并在 plan 记录行为变更。
- 改进建议：参考 Plan Phase 4 目标补齐 groups 预检穿透（Phase 0 任务 4 的节点 path 继承语义同样适用于此处）；并新增 v6 模板下「无产物→precheck 拦截」的红绿用例（现有 `auto-verifier.test.ts:1126`、`agent-settled.test.ts:1275` 均用扁平 fixture，构成假绿）。

### 问题 2
- 问题：`src/core/verify-generator.ts:477-481` 将 `hasCustom` 收敛为「存在 `groups` 即 true」，而 `buildMergedVerifyContent`（L508-546）重建 frontmatter 时**只合并 requiredFiles/requiredCommands/keywords/requiredGit，不携带 `fileContentPattern`**。因此旧式扁平 verify.md 中用户自写的 `fileContentPattern` 在 `/pipeline-init` 重跑时不再命中 `hasCustom` 保护，进入 merge 后被整段丢弃。实证：构造含 `fileContentPattern: [{path:"docs/design/dev.md", pattern:"^# MyCustomSection"}]` 的旧式扁平 verify.md，调用生产 `generateVerifyFiles(config,{stage:"develop"})` → 结果 `status:"merged"`，写回文件 `MyCustomSection` 丢失（`custom pattern preserved: false`）。同时 `src/__tests__/core/verify-generator.test.ts` 中原「hasCustom=true when existing rules contain non-builtin fileContentPattern」被反向改写为「flat custom fileContentPattern no longer blocks merge … hasCustom=false」，恰是 Phase 4 任务 4 明文禁止的「改断言就绿」。
- 等级：High
- 符合规划：部分（行为符合 F7/Phase 2 任务 5 的 groups-only 判定，但与 Phase 4 任务 4 的等价保护要求直接冲突）
- 是否修复：已修复（fix commit 38ac894：hasCustom 检测恢复对扁平 fileContentPattern 的保护，防止 init merge 时静默数据丢失；相关测试断言同步恢复为 hasCustom=true）

### 问题 3
- 问题：Plan Phase 2「单元测试目标，边界」明确要求「`contract-unavailable → agent-settled 未声明分支`集成断言（红绿判别：删 loader 接线必红）」。实际 `src/__tests__/core/agent-settled.test.ts` 全文（`grep unavailable|anchor|contract` 零命中）无任何用例覆盖该分支：`contract_anchor_unavailable` 仅出现在 `pipeline-start.test.ts`（clarify 侧）与 `template-defaults.test.ts`（guide 文案断言）。现有 `review-conclusion.test.ts:301-320` 仅验证解析器返回 `contract-unavailable`，未验证 `src/core/agent-settled.ts:218-237` 的消费接线；`verify-integration.test.ts:662` 覆盖的是「verdict 锚点存在 → 失败路由 fix」，非 fail-open 分支。生产接线经独立实证可用（真实 review 模板 → loader → `parseReviewConclusion` 各形态 verdict 正确），但删除 `agent-settled.ts:213-237` 接线不会有任何用例转红，存在假绿。
- 等级：Medium
- 符合规划：否
- 是否修复：已修复（fix commit 38ac894：在 agent-settled.test.ts 新增 contract-unavailable fail-open 集成断言，含红绿判别验证）

### 问题 4
- 问题：clarify 锚点装载把「任意 issue」与「缺 roundHeading」等同处理。`src/commands/pipeline-start.ts:780` 与 `src/core/auto-verifier.ts:793` 均为 `if (issues.length > 0 || !anchors.roundHeading)` → 强制 `fresh(1)` / `awaiting:false`。`loadVerifyContractAnchors` 对文件内**任意**锚点问题（如与轮次无关的 `answerField` 缺 patterns、某节点 `runtime` 非法）都会返回非空 `issues`，此时即便 `roundHeading` 有效也会丢弃轮次推导，误降级为 fresh。Plan Phase 2 任务 4 的语义是「缺 `roundHeading` → fresh；issues → notify+审计」，二者不应合并。
- 等级：Medium
- 符合规划：否
- 是否修复：已修复（fix commit 38ac894：pipeline-start.ts 和 auto-verifier.ts 改为仅 `!anchors.roundHeading` 触发 fresh/awaiting:false 降级；`issues.length>0` 仅做 warn 级别审计记录，不影响推导结果）
- plan是否覆盖
  - 已覆盖：Phase 2 任务 4（fail-open 触发条件与可观测策略）
  - 未覆盖：无
- 改进建议：参考 Plan Phase 2 任务 4，改为仅 `!anchors.roundHeading` 触发 fresh/awaiting:false；`issues.length>0` 只做 notify+error 审计，不改变推导结果。

### 问题 5（LOW，无需修复）
- 问题：`src/core/verifiers/file-verifier.ts:147-197` 的 `textOverride`（groups `scope: section` 逐节文本）分支位于「精确路径」else 分支内；当规则 path 为 glob 时（L147 `isGlobPattern` 分支）不生效，逐节语义会静默退化为读取磁盘文件。当前唯一 `scope: section` 模板（clarify）使用具体路径，无实际影响。
- 等级：LOW
- 符合规划：是（plan Phase 1 任务 2/3 未要求 section+glob 组合）
- 是否修复：无需修复（LOW）
- plan是否覆盖
  - 已覆盖：Phase 1 任务 2（scope: section 逐节求值）
  - 未覆盖：无
- 改进建议：如后续模板出现 section+glob，建议在 glob 分支同样应用 `textOverride`（对最新 mtime 匹配文件按节求值）。

### 问题 6（LOW，无需修复）
- 问题：`src/utils/clarify-args.ts:79-89` 用 `splitRoundSections` 的节文本（标题至**下一轮标题**）替代原「最新轮标题至**文末**」语义（plan Phase 2 任务 2 声称等价）。当文档轮次非升序（如 `[1,2,1]`）时，最大轮号所在节的文本不含其后内容，与旧实现存在边界差异。
- 等级：LOW
- 符合规划：是（常规升序轮次下语义等价，plan 声称等价成立）
- 是否修复：无需修复（LOW）
- plan是否覆盖
  - 已覆盖：Phase 2 任务 2（改用 splitRoundSections，语义等价保持）
  - 未覆盖：无
- 改进建议：如关注乱序轮次，可在取「最大轮号」后固定截取该标题至文末；否则维持现状并在注释注明仅支持升序。

### 问题 7（LOW，无需修复）
- 问题：`src/template/guide.md:1061` 仍含字面 `CONTRACT_TOKENS`（`dist/template/guide.md` 同步）。Plan Phase 4 任务 3 要求「grep `CONTRACT_TOKENS`/`TEMPLATE_BUILTIN` 零残留（源码+注释）」。经核，这是行为变更清单中对「代码侧已退役」的**说明性引用**，非残留代码；`TEMPLATE_BUILTIN` 全仓零命中。
- 等级：LOW
- 符合规划：是（F8 要求行为变更清单对用户可见）
- 是否修复：无需修复（LOW）
- plan是否覆盖
  - 已覆盖：Phase 4 任务 1（行为变更清单）
  - 未覆盖：无
- 改进建议：保留；如严格按字面清零，可改为「旧契约常量」等中性表述。

### 问题 8（LOW 观察项，无需修复）
- 问题：`src/__tests__/utils/subagent-rpc.test.ts:163` 用例依赖 `spawnClarifySubagent` 内部 `SPAWN_TIMEOUT_MS = 5000`（`src/utils/subagent-rpc.ts:147`），与 Bun 单测 5s 上限同值；并行负载下内部定时器可能晚于框架超时，导致偶发 fail（本次 5 次运行中复现 1 次）。该用例正文不在本 plan diff 内（`3b18f6c` 仅新增同文件 clarify 派生用例），属存量设计缺陷，故验收「0 fail」非确定性成立。
- 等级：LOW
- 符合规划：是（非本 plan 引入）
- 是否修复：无需修复（LOW）
- plan是否覆盖
  - 已覆盖：无
  - 未覆盖：Plan 未覆盖（存量问题）
- 改进建议：后续可将该用例改为注入更短 spawn 超时，或显式 `it(..., { timeout: 10000 })`，消除与框架超时的竞态。

## 独立实证明细（本轮）

| 验证对象 | 独立证据 | 结论 |
|---|---|---|
| 三层布尔（跨组 AND/组内 ruleMode/节点 mode） | `group-verifier.test.ts` 全绿；独立 `evaluateGroups` 实测矩阵 | 通过 |
| 175-G4 逐节严格（生产路径） | 真实 clarify 模板 + `runVerification`：round1 漏答 + round2 已答 → `rulePassed=false`，失败明细 `round 1: …` 且 `group:"round-well-formed"` | 通过 |
| legacy 扁平解析兼容 | `verify-groups-parser.test.ts` JSON 序列化 byte 级一致断言全绿；独立 `runVerification` 扁平 fixture `rulePassed=true` | 通过（解析/求值） |
| 真实模板 → loader → 消费方 | 5 模板复制到默认部署路径后 `loadVerifyContractAnchors`：clarify 四键中三键、review `verdict` 三 pattern 均 `issues:[]`；`deriveClarifyForwardArgs` fresh/full-und?/confirmed 正确；`parseReviewConclusion` 中/英 fail 与 pass 判别正确 | 通过（接线无假绿） |
| v6 模板静态诊断 | 5 模板 `diagnoseVerifyConfig` 全部 `ok=true, errors=[]`（排除 config-error 跳过验证的假绿） | 通过 |
| `precheckRequiredFiles`（问题 1） | v6 review 无报告 → `{passed:true}`；扁平 review 无报告 → `{passed:false, missing:[...]}` | **不通过（回归）** |
| init merge 保护（问题 2） | 扁平自定义 fileContentPattern → `generateVerifyFiles` 后 `status:"merged"`，自定义 pattern 丢失 | **不通过（数据丢失）** |
| agent-settled fail-open 集成断言（问题 3） | 全测试树无 `contract_anchor_unavailable`（agent-settled 侧）；移除接线无红 | **缺失（假绿风险）** |
| 退役常量残留 | `grep CONTRACT_TOKENS/TEMPLATE_BUILTIN` 源码零命中（仅 guide.md:1061 说明性引用） | 通过（说明性） |
| 验收门禁 | `bun run build` 0 错、`bun run typecheck` 0 错、`bun test` 4/5 次 2169 pass / 0 fail，1 次 1 fail（存量 flaky） | 基本通过（非确定性） |

## 总体结论

- **是否有 Blocker / High / Medium**：有。**High ×2（问题 1、问题 2）+ Medium ×2（问题 3、问题 4）**，均已修复（fix commit 38ac894）。
- **问题 1（High）**：`precheckRequiredFiles` 未穿透 groups，v6 模板下 168 Phase 0 预检整体失效 → 已修复，改为遍历 groups[].rules[] 中 requiredFile 节点。
- **问题 2（High）**：旧式扁平自定义 `fileContentPattern` 在 init merge 时被静默丢弃 → 已修复，恢复 hasCustom 对扁平 fileContentPattern 的保护。
- **问题 3（Medium）**：agent-settled `contract-unavailable` fail-open 分支缺集成断言 → 已修复，新增集成测试含红绿判别。
- **问题 4（Medium）**：锚点 issues 与缺 roundHeading 被等同处理 → 已修复，仅 `!anchors.roundHeading` 触发降级。
- **已确认落地**：三层布尔引擎、when/scope 逐节（含 175-G4 生产路径）、contract-loader fail-open、5 份 v6 模板、guide §9.4.B、退役常量（源码零残留）、旧式扁平解析 byte 级兼容、真实模板→锚点→消费方接线均实证通过。
- **待处理**：问题 5–8 为 LOW 观察项，无需修复。
- **Sub-Agent 触发**：按 code-review-withfix skill §5，所有待修复项已修复，触发 re-review。
