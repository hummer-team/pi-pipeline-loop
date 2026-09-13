# 176_Feat 开发计划
> 引用需求文档：`docs/design/176_Feat.md`（含第 1-6 轮澄清与《full-und? 评估结论与最终方案决策》；本文只输出结论性开发规划，取证过程不重复）

## Summary

验证声明体系重构：**verify.md 成为唯一声明源**（声明即行为），引入 **groups 验证组**（一目标一声明、三层布尔）、**组级条件语义**（when/scope 替代 mega lookahead）、**运行时锚点属性化**（`runtime:` 两级共用，`CONTRACT_TOKENS` 与代码默认正则全部退役）、**失败按组回流** 既有 wake 闭环。

| # | 问题域 | 如何修复 | Phase |
|---|---|---|---|
| F1 | 契约 token 4 处字面拷贝（constants/verify-generator/模板/部署），byte-identical 仅靠注释维系 | verify.md 单源：代码侧正则（`CONTRACT_TOKENS`、`TEMPLATE_BUILTIN_CONTENT_PATTERNS`、lookahead、verdict alternation）退役；运行时改读 verify.md 的 `runtime:` 锚点（R1Q1-B） | 2, 3 |
| F2 | verify 无组概念：全局隐式 AND、跨规则 OR 只能塞正则 alternation、keywords 独享 mode | 新增 `groups:`（组间 AND、组内 `ruleMode`、节点内 `mode`），节点三合一 `{type, mode?, patterns[]}`，五类规则可混用（R1Q2-A/R2Q1-A/R4Q1-A） | 0, 1 |
| F3 | clarify 反例：mega lookahead 耦合轮次/方案/答，用户不可自定义 | 组级 `when` + `scope: section` 等价改写（when 不命中组恒过；命中按 h1/h2 切节逐节求值，175-G4 语义零回归）（R2Q2-A/R5Q1-A） | 1, 3 |
| F4 | 组语义与失败回流：AND 全量报/OR 任一过 | 三层求值 + `VerifyFailure.group?`，回流格式 `[group:name][ruleType] detail`，走既有 `verify_fail_wake`；熔断边界不变（R1Q4-A） | 1 |
| F5 | 运行时（轮次推导/verdict 判定）与声明解耦后失效边界 | fail-open：缺锚点→轮次推导 fresh(1)、review 走"未声明"分支；error 审计 `contract_anchor_unavailable` + 英文 notify（60s 节流）（R2Q4-A） | 2 |
| F6 | `modelRuntimeResult` 新类型（聚合 assistant 消息正则匹配，替代 keywords 分组化） | 新规则类型求值（整体聚合文本、`m` 标志）；顶层 `keywords` 保留解析、标 deprecated（R4Q5-A） | 1 |
| F7 | init/merge 与存量边界 | 不考虑存量（R1Q5）：`TEMPLATE_BUILTIN` 白名单删除；`diffAndMergeRules` 遇 `groups` 或扁平 `fileContentPattern` 即 `hasCustom=true` 保护（v6 模板重跑 init 幂等免覆盖 + 存量扁平自定义 `fileContentPattern` 防 init merge 数据丢失） | 2 |
| F8 | 文档收口 | guide.md **独立 task**：groups 全量配置参考（含 `scope` 枚举 `section`/缺省整文档、runtime 属性兼职语义与不可删警示、三层求值序、失败回流格式、行为变更清单）（R5suppl-1/R6Q2 注记） | 4 |
| F9 | 行为变更（已背书） | `## 模型确认` 节升格为 clarify verify 真实门禁（最终轮语义，只挂 full-und-confirmed 组不逐轮查）；full-und 确认双语 or 形态（R5Q2-B） | 3 |

**不需要做什么**（负面清单，R1-R6 决策排除）：不迁移存量 verify.md；不新增 `contracts:` 节点（R3Q2-B）、不做嵌套 groups（R2Q1 否 B）、不做组级 path 三级继承（R4Q4-A）、不保留 `verify: false` 属性（R5Q2-B 消灭）、`modelRuntimeResult` 不做 LLM 判定形态（R4Q5 否 B）、不改 verdict 值提取判别逻辑与 blocker 扫描（`hasOpenIssueLine` 现状保持）、不改 `verifyAttempts`/`violations` 熔断与冻结边界、不改 `completionMarker` 预检机制（config 字符串通道与 v6 门禁并存）、不改 `PIPELINE_TURN_SIGNATURES`、不动 DRIFT_CHECK_ASSETS 清单。

**编码合规**：全部实现遵循 `.opencode/references/code_spec.md`（无未注释 `any`、显式返回类型、catch 记 error 审计含上下文、函数 ≤100 行、无嵌套三元、单一定义源防 DRY 违反、注释与日志英文），并复用既有 helper（`stripYamlQuotes`、`globMatchFiles`、`verifyRequiredFiles/verifyFileContentPattern/verifyRequiredCommands/verifyRequiredGit`、`shouldEmitWithinWindow`、`safeWriteAuditLog`、`makeTestConfig/createMockCtx`）。

---

## Phase 0 — groups 声明解析（纯 parser，不接执行）

**标题**：verify-frontmatter 扩展 groups/规则节点/文件级 path

### 目标
`rules:` 支持 `path:`（文件级默认）与 `groups:`（组属性 `name/when/scope/ruleMode/runtime`，规则节点 `{type, mode?, patterns[], pattern?, path?, runtime?, cmd/expect*/git 字段}`）；旧式扁平键解析行为零改动；解析结果仅新增字段。

### 任务
1. `src/core/verify-frontmatter.ts`：新增类型 `VerifyGroupRuleNode`、`VerifyGroup`；`VerifyRules` 增 `path?: string`、`groups?: VerifyGroup[]`；规则类型枚举 `VerifyRuleNodeType = "requiredFile" | "fileContentPattern" | "requiredCommand" | "requiredGit" | "modelRuntimeResult"`（决策 R1Q2A/R2Q1A/R4Q1A）
2. 解析扩展（状态机新增段）：`rules:` 下 indent-2 的 `path:` 与 `groups:` 段；组块、`rules:` 节点块、`patterns:` 列表按缩进层级解析——拆为独立函数 `parseGroupsBlock(lines, startIdx)` / `parseGroupItem` / `parseRuleNodeItem`（各 ≤100 行；`stripYamlQuotes` 复用，pattern 引号内 `#` 不受注释处理影响）；**支持独立行 `#` 注释**（trim 后 `#` 开头跳过），行尾内联注释不支持（模板与 guide 明确"frontmatter 注释仅整行"）
3. `pattern: x` 单条糖 → parse 时归一为 `patterns: [x]`（决策 R4Q1A"parser 双兼容"）；`mode`/`ruleMode` 值校验（非 and/or → 字段回退默认 `and` + 审计 warn，与现行 invalid_mode 宽容语义区分：顶层 mode 行为不变）
4. 节点校验与丢弃审计：`type` 非法/缺失、`patterns` 空、`fileContentPattern` 节点无有效 path 来源（节点无 path 且文件级无 path）→ 丢弃该节点并记 `verify_frontmatter_parse_error`（对齐 L356-380 空项丢弃先例）；被丢弃后空组保留（恒过语义归 Phase 1 引擎）
5. `hasAnyRules` 判定纳入 groups（只有 groups 也算有规则）
6. **锚点校验前置到解析期不做**（Phase 2 loader 负责命名组校验），本 Phase 仅结构解析

### 验收
- `bun run build`、`bun run typecheck` 零错误；`bun run test` 全量通过（现有 1964 测试零破坏——groups 未被执行，旧文件行为不变）

### 单元测试目标，边界
- 新增 `src/__tests__/core/verify-groups-parser.test.ts`：v6 全形态解析（clarify/review 两模板结构逐字段断言）；pattern 糖归一；`patterns` 内联流式 `[ "a", "b" ]` 与块式两形态；整行注释跳过、引号内 `#` 不误伤；缩进边界（2/4/6/8）；非法 type 丢弃+审计断言；`hasAnyRules=groups-only`；旧式 flat frontmatter 解析结果与基线 byte 一致（红绿判别：改动 legacy 路径必红）

### Commit 遵循规范
```
feat(verify-frontmatter): phase 0 groups/rule-node schema parsing with file-level path default
```

---

## Phase 1 — groups 求值引擎与失败回流

**标题**：三层布尔求值、when/scope 逐节、modelRuntimeResult、组前缀回流

### 目标
`runVerification` 体系执行 groups：跨组 AND → 组内 ruleMode → 节点内 mode；`when` 空命中恒过、`scope: section` 逐节严格；失败明细携带组名进 wake 闭环；defer/占位符/glob 具体化链路穿透 groups。

### 任务
1. 新增 `src/utils/round-sections.ts`：`splitRoundSections(docText, headingRe): Array<{ round: number; text: string }>`（按 h1/h2 轮次标题切节，末节至 EOF；标题正则含命名组 `roundZh/roundEn` 取号）——**供组引擎与 clarify-args（Phase 2）共用，单一实现**（SOP 复用原则，R2Q2A 逐节语义）
2. 新增 `src/core/verifiers/group-verifier.ts`：`evaluateGroups(rules: VerifyRules, projectRoot, assistantMessages, execFn?, logError?, toolCtx?)` —— 组遍历求值：
   - `when` 编译（`m` 标志）无命中 → 组恒过（等价现 lookahead 空命中放行，R2Q2A）
   - `scope: section` → 对每个命中节（`splitRoundSections`）独立求值组 rules，任一节败即组败、失败 detail 含 `round N`；缺省 scope=整文档
   - 节点分派复用既有 verifier：`requiredFile`→`verifyRequiredFiles([path])`、`fileContentPattern`→按 `patterns[]` 展开 `{path,pattern}` 后 `verifyFileContentPattern` 求单条并按节点 `mode` 聚合、`requiredCommand`→`verifyRequiredCommands`、`requiredGit`→`verifyRequiredGit`
   - `and`（缺省）：全量求值不短路、全部失败项回报（R1Q4A）；`or`：首个通过节点即组过、全败回报全部失败
   - 失败项 `VerifyFailure.group = group.name`
3. `src/core/auto-verifier.ts`：
   - `VerifyFailure` 增 `group?: string`（`src/types.ts` 的 meta.verifyFailures 同步该可选字段，向后兼容）
   - `executeStructuredRules` 头部接入 `evaluateGroups`（groups failures 与既有 flat failures 并列合并；**flat 规则求值路径零改动**）；`hasStructuredRules` 判定纳入 `groups?.length`
   - `modelRuntimeResult` 求值：新函数置于 `src/core/verifiers/keyword-verifier.ts`（`verifyModelRuntimeResult(patterns, mode, assistantMessages)`，聚合 `\n` join、逐 pattern `new RegExp(p, "m")`，R4Q5A）
   - defer 遍历扩展：`deferContentPatterns` 匹配下沉 groups 节点 `patterns[]`（命中即摘除该 pattern；节点清空摘除节点；组清空则该组恒过）——保证 plan confirm 门 `PLAN_CONFIRM_MARKER_RULE` 在 groups 模板下仍生效（162 C2 语义保持）
   - 占位符守护（L445-494 `{requirementDoc}`/`{pipelineId}` unresolved）遍历扩展至 文件级 path/when/节点 path/patterns
4. `src/core/verify-path-resolver.ts`：`resolvePlaceholders`、`applyConcreteStageDocPaths`/`replaceGlobInRules` 穿透 groups（文件级 path、节点 path、patterns 内 `{pipelineId}`；plan/develop/fix/review glob 具体化）
5. 失败回流格式：`src/core/verify-advance.ts` `failureSummary` 构建（L332-334）改为 `f.group ? \`[${f.group}][${f.ruleType}] ${f.detail}\` : 原格式`；wake 消息（L374-376）与 `pipeline_verify` 结果、`prompt-injector` `{{verify_failures}}` 渲染（L387）自然透传 group 前缀；审计 `auto_verify_fail` 字段不变（防 churn）
6. legacy `keywords` 顶层通道：解析与求值保留，`verify-frontmatter.ts` 注释标记 deprecated（R4Q5A）

### 验收
- `bun run build`/`bun run typecheck` 零错误；`bun run test` 全量通过（175 Phase 6 既有"格式失败不进 violations"回归保持绿）

### 单元测试目标，边界
- 新增 `src/__tests__/core/group-verifier.test.ts`：三层布尔矩阵（组间 AND/组内 or 任一过/全败全报/节点 mode）；`when` 空命中恒过、命中逐节（**175-G4 红绿判别：round1 漏答+round2 已答必败**）；`scope` 缺省整文档；`modelRuntimeResult` 命中/未命中/m 标志跨消息；defer 摘除 plan marker 后组仍过；`[group:name][ruleType]` 前缀断言（wake 消息与 prompt 注入两处）
- 新增 `src/__tests__/utils/round-sections.test.ts`：h3 不切分、末节至 EOF、双语标题取号、正文提及 Round N 不切分
- 既有 `auto-verifier.test.ts`/`verify-integration.test.ts`：flat 路径全绿零改（兼容性证明）

### Commit 遵循规范
```
feat(verify-engine): phase 1 groups evaluation with when/scope conditionals and group-tagged wake failures
```

---

## Phase 2 — 运行时锚点装载与代码侧正则退役

**标题**：contract anchors loader、clarify/review 运行时改造、fail-open、白名单退役

### 目标
`clarify-args`/`review-conclusion` 改由部署 verify.md 的 `runtime:`/组级 `runtime` 属性提取 pattern；`CONTRACT_TOKENS`、`TEMPLATE_BUILTIN_CONTENT_PATTERNS` 及 byte-identical 契约退役；声明缺失/非法按 fail-open+可观测运行。

### 任务
1. 新增 `src/utils/contract-loader.ts`：
   - `resolveVerifyFilePath(config, stage, overrideFile?)`：verify.md 路径解析单源（提取自 `runVerification` L343-348 现逻辑，auto-verifier 改引用——消 DRY）
   - `loadVerifyContractAnchors(config, stage): Promise<{ anchors: VerifyContractAnchors; issues: string[] }>`：解析 frontmatter 后扫描——组级 `runtime: roundHeading`（校验 when 含命名组 `roundZh/roundEn`，缺则入 issues）、节点 `runtime: answerField|modelConfirm|verdict`（answerField/modelConfirm 归一 `{patterns, mode}`；verdict 收集 patterns 列表且**每条须含捕获组 1**，R3Q1 校验位）
   - `VerifyContractAnchors` 类型：四键全可选；`issues` 非空对应键视为缺失
2. `src/utils/clarify-args.ts` 改造：`deriveClarifyForwardArgs(docText, anchors)`——三 pattern 全部由 anchors 编译（命名组取号 `groups.roundZh ?? groups.roundEn`）；最新轮节提取改用 `splitRoundSections`（现"heading 至文末"语义等价保持，L83-95）；anchors 缺失键 → 调用方按 fail-open 处理（见 4）；模块头注释更新（声明源=verify.md，引用决策 R1Q1B）
3. `src/utils/review-conclusion.ts` 改造：`parseReviewConclusion(projectRoot, anchors)`——三 verdict Re 由 `anchors.verdict` patterns 编译（`i` 标志策略保持现状）；**值提取判别逻辑不动**（捕获文本映射 pass/fail 代码内置，R3Q2 缺点③解法）；`anchors.verdict` 缺失 → 返回 `{ verdict: null, ... }` 扩展语义：新增返回态 `contract-unavailable`，agent-settled 将其并入既有"未声明 reviewConclusion"分支（`review_declaration_missing` 审计 + verify+confirm 门兜底，R2Q4A"既有 undecided 分支"落点）
4. 消费方接线（anchors null/缺键 → fail-open + 可观测）：
   - `src/commands/pipeline-start.ts` L773：先 `loadVerifyContractAnchors(clarify)`；缺 `roundHeading` → `derived={kind:"fresh",args:"1"}`；issues → `ui.notify`（英文，`shouldEmitWithinWindow` 节流，指引 `/pipeline-init`）+ error 审计 `contract_anchor_unavailable {stage, missingKeys}`
   - `src/core/auto-verifier.ts` `precheckClarifyAwaitAnswer`（L718）：内部装载 anchors；不可用 → `awaiting: false` 放行至规则验证（规则引擎自会处理），并走同事件审计
   - `src/core/agent-settled.ts` L211：装载 review anchors；`contract-unavailable` → 未声明分支（见 3）；notify+审计同策略
   - `src/tools/pipeline-verify.ts` await-answer 分支随 precheck 生效，无独立改动
5. 退役与 merge 保护：
   - `src/constants.ts`：删除 `CONTRACT_TOKENS` 整段（含 L334-375 注释块）；`DEFAULT_VERIFY_FILE` 等其余保留
    - `src/core/verify-generator.ts`：删除 `TEMPLATE_BUILTIN_CONTENT_PATTERNS`；`diffAndMergeRules` 中 `hasCustom` 判定改为 `existing.groups?.length > 0` 或 `existing.fileContentPattern?.length > 0` → true（用户定制与新模板重跑 init 双重保护 + 存量扁平 `fileContentPattern` 防 init merge 数据丢失，R1Q5"init 现有逻辑"精神延续）；`buildMergedVerifyContent` 仅处理 flat 文件（groups 文件或含扁平 `fileContentPattern` 的文件因保护不进 merge）
6. `src/core/verify-config-diagnosis.ts`：新增 codes `group_missing_name`、`group_runtime_invalid`（组级 runtime 值不在枚举/无 when）、`node_runtime_invalid`（规则级 runtime 值非法）、`anchor_validation`（roundHeading 缺命名组、verdict 缺捕获组 1——detail 指明键）；`KNOWN_FRONTMATTER_KEYS` 不变（groups/path 位于 `rules:` 二级，不触顶层键检查）

### 验收
- `bun run build`/`bun run typecheck` 零错误；`bun run test` 全量通过

### 单元测试目标，边界
- 新增 `src/__tests__/utils/contract-loader.test.ts`：四键提取矩阵（组级/规则级、verdict 多形态列表）；命名组/捕获组缺失 → issues+键置空；文件缺失/frontmatter 损坏 → anchors 全空+issues；`resolveVerifyFilePath` 与 runVerification 路径解析一致性断言（单源）
- `clarify-args.test.ts` 重写注入 anchors：四态派生（fresh/await-answer/full-und?/confirmed）双语 fixture；缺锚点→fresh 由调用方测试覆盖（`pipeline-start.test` 补：notify 恰一次+审计+不阻断）
- `review-conclusion.test.ts` 适配 anchors 注入（既有 20+ 用例 fixture 化）；`contract-unavailable → agent-settled 未声明分支`集成断言（红绿判别：删 loader 接线必红）
- 删除 `src/__tests__/utils/contract-tokens.test.ts`（token 语义迁移至 loader+模板一致性测试）；`verify-generator.test` 白名单用例改造为 groups 保护用例

### Commit 遵循规范
```
refactor(contract,verify): phase 2 declaration-driven runtime anchors with fail-open and code-side regex retirement
```

---

## Phase 3 — 5 模板 v6 重写与生成侧对齐

**标题**：clarify/plan/develop/review/fix verify.md 按 v6 基线重写

### 目标
模板声明文件成为新唯一契约源：v6 形态（文件级 path + groups + runtime 属性 + scope: section），行为变更两项落地（R5Q2-B），inform/verify 一致性由模板+引擎测试锁定。

### 任务
1. 重写 5 个模板 `src/template/references/{clarify,plan,develop,review,fix}_spec/verify.md`（frontmatter 无行内注释，按 v6 基线，`docs/design/176_Feat.md` 附录为准）：
   - **clarify**：组 `round-well-formed`（`when`=双语轮次正则含 `(?<roundZh>|roundEn)`、`runtime: roundHeading`、`scope: section`、ruleMode and、rules=[方案行节点（字面内联，无 runtime）、答节点（mode or 双语、`runtime: answerField`）]）+ 组 `full-und-confirmed`（ruleMode and：full-und 双语 or 节点 + **`^##\s*模型确认|Model Confirmation` or 节点挂 `runtime: modelConfirm`**——升格真实门禁，行为变更①，R5Q2B）
   - **review**：`review-report-ready`（requiredFile + verdict or 节点挂 `runtime: verdict`（捕获组 1）+ pipelineId 节点）
   - **plan/develop/fix**：单组收敛（requiredFile 继承文件级 path + 既有内容节点原样迁移；plan 的 `^## (用户确认|User Confirmation)` 以 patterns 多形态 or 节点承载，保持 `PLAN_CONFIRM_MARKER_RULE` defer 可命中——节点 pattern 字面值与 defer 常量逐字节一致）
2. `src/core/stage-advancer.ts` `PLAN_CONFIRM_MARKER_RULE` 与新 plan 模板 pattern 一致性：新增**双向一致性断言测试**（替代旧 byte-identical 注释契约，见任务 3）
3. 一致性测试重写：`src/__tests__/core/template-defaults.test.ts` 中"模板 == 代码默认模式"断言删除（代码默认已退役）→ 新增"5 模板 parse→结构断言（组名/规则类型/runtime 键/when 命名组）→ 正负 document fixture 引擎求值"逐 stage 冒烟；plan 模板 marker pattern == `PLAN_CONFIRM_MARKER_RULE.pattern` 断言
4. 需求文档行为兼容核对：176 自身与既往需求文档将带 `full-und? 理解确认：是` 行内标记（or 第一形态），升格门禁的 `## 模型确认` 节已由 design-und 契约产出（本次 176 文档已含），无兼容问题（记录于 guide 行为变更清单）
5. 漂移清单不动（DRIFT_CHECK_ASSETS 不含 *_spec/verify.md，锚点缺失由 Phase 2 fail-open+notify 兜底——写入 loader 注释）

### 验收
- `bun run build`/`bun run typecheck` 零错误；`bun run test` 全量通过

### 单元测试目标，边界
- 模板冒烟矩阵（任务 3）逐 stage：合规交付文档 → passed；破坏任一成员（漏答/漏方案/错 pipelineId/缺模型确认节/缺轮次标题但有 full-und——**后者断言组恒过不误杀**，R4Q2 语义）→ failures 定位到 `[group:name]`
- 新 clarify 模板对真实文档回放：取 `docs/design/175_Bug.md`/`176_Feat.md` 形态构造 fixture（多轮齐备 vs 中间轮漏答）断言逐节严格
- 部署链路：`pipeline-init.test.ts` 既有"复制后文件存在"断言更新为新内容关键字（groups/when）断言

### Commit 遵循规范
```
feat(assets,verify): phase 3 v6 group-based verify.md templates with runtime anchors and model-confirm gate
```

---

## Phase 4 — guide.md 独立 task 与行为收口

**标题**：文档参考重写、行为变更清单、全量回归

### 目标
用户文档与实现终态一致：guide.md 提供 groups 声明完整参考（含 `scope` 枚举与 runtime 锚点警示），行为变更对用户可见可理解；全仓无退役残留；175/162/168/172 既有行为矩阵在新机制下等价通过。

### 任务
1. `src/template/guide.md`（独立 task，R5suppl-1/R6Q2 强制约束）：
   - §9.4.B 重写为 groups 配置完整参考：schema 字段表（文件级 `path`/`groups`/`name`/`when`/`scope`/**枚举：`section`=逐节、缺省=整文档**/`ruleMode`/节点 `type` 五枚举/`mode`/`patterns`+`pattern` 糖/`runtime` 属性）；三层布尔求值序图注；frontmatter 注释仅整行
   - runtime 属性节：两级共用、"验证+运行时兼职"语义、四键说明、命名组/捕获组要求、**警示：带 runtime 属性的节点删除即运行时降级（fail-open），不可随意删除**
   - 失败回流格式与闭环说明更新（`[group:name][ruleType] detail`，与 §9.4 诊断表、熔断职责说明衔接）；诊断新增 codes 表补入
   - 行为变更清单节：模型确认节门禁升格、full-und 双语 or、keywords deprecated、存量 verify.md 不迁移（重跑 `/pipeline-init` 获取新模板，自定义文件受 hasCustom 保护）
   - §9.4.2 merge 语义表补"含 groups → exists_custom 保护"行
2. `src/template/skills/design/SKILL.md` 复核：模型确认节 MUST 条款与 v6 门禁口径一致（175 Ph7 已写入的契约文本无需改，仅核对）；不符则最小修订
3. 全仓引用清理验证：grep `CONTRACT_TOKENS`/`TEMPLATE_BUILTIN` 零残留（源码+注释，历史 plan/决策文档除外）；dist 由 build 再生成核对
4. 回归安全网：175 G4 轮次矩阵、B7 verdict 矩阵、162 confirm defer、168 pipelineId、148 白名单替代保护、172 await-answer 全部既有测试按新机制等价绿（红即回修，禁止改断言就绿）

### 验收
- `bun run build`/`bun run test` 全量通过；guide.md 覆盖上表全部条目且无开发时量/工作量表述

### 单元测试目标，边界
- 无新增代码路径；`template-defaults.test.ts` 对 guide.md 关键锚（groups 参考节存在、scope 枚举出现、runtime 警示存在）做内容断言（红绿判别：删章节必红）

### Commit 遵循规范
```
docs(assets,guide): phase 4 groups configuration reference with scope enum and runtime anchor warnings
```

---

## All Phase 文件变更汇总

| 文件 | 变更类型 | Phase |
|------|---------|-------|
| `src/core/verify-frontmatter.ts` | 修改（VerifyGroup/VerifyGroupRuleNode 类型 + groups/path 解析 + 注释支持 + deprecated 标注） | 0 |
| `src/utils/round-sections.ts` | **新增**（轮次切节共享工具，引擎与运行时共用） | 1 |
| `src/core/verifiers/group-verifier.ts` | **新增**（三层布尔求值 + when/scope） | 1 |
| `src/core/verifiers/keyword-verifier.ts` | 修改（新增 `verifyModelRuntimeResult`） | 1 |
| `src/core/auto-verifier.ts` | 修改（executeStructuredRules 接组引擎、group 字段、defer/占位符/glob 穿透、precheckClarifyAwaitAnswer 装载 anchors、resolveVerifyFilePath 提取引用） | 1, 2 |
| `src/core/verify-path-resolver.ts` | 修改（groups 遍历：占位符/glob 具体化） | 1 |
| `src/core/verify-advance.ts` | 修改（failureSummary 组前缀） | 1 |
| `src/core/prompt-injector.ts` | 修改（`{{verify_failures}}` 组前缀透传） | 1 |
| `src/types.ts` | 修改（VerifyFailure 相关/meta.verifyFailures `group?: string`、VerifyRules 结构 re-export 核对） | 1 |
| `src/utils/contract-loader.ts` | **新增**（anchors 扫描/校验/fail-open issues + 路径解析单源） | 2 |
| `src/utils/clarify-args.ts` | 修改（anchors 参数化、命名组取号、section 复用） | 2 |
| `src/utils/review-conclusion.ts` | 修改（anchors 参数化、contract-unavailable 态） | 2 |
| `src/constants.ts` | 修改（**删除 CONTRACT_TOKENS**） | 2 |
| `src/core/verify-generator.ts` | 修改（**删除 TEMPLATE_BUILTIN_CONTENT_PATTERNS**；groups→hasCustom 保护） | 2 |
| `src/core/verify-config-diagnosis.ts` | 修改（groups 结构诊断 codes + 锚点校验诊断） | 2 |
| `src/commands/pipeline-start.ts` | 修改（anchors 装载 + fail-open fresh + notify/审计） | 2 |
| `src/core/agent-settled.ts` | 修改（verdict anchors 接线、contract-unavailable → 未声明分支） | 2 |
| `src/template/references/*_spec/verify.md` ×5 | 重写（v6 基线；模型确认节门禁升格） | 3 |
| `src/core/stage-advancer.ts` | 核对（PLAN_CONFIRM_MARKER_RULE 与新模板一致性断言接入测试，代码值不变则不改） | 3 |
| `src/template/guide.md` | 修改（§9.4.B groups 参考重写 + 行为变更清单）【独立 task】 | 4 |
| `src/template/skills/design/SKILL.md` | 核对（确认节口径，最小修订） | 4 |
| `src/__tests__/…` | 新增 verify-groups-parser / group-verifier / round-sections / contract-loader 4 文件；重写 clarify-args / review-conclusion / template-defaults / verify-generator(白名单→保护) / pipeline-start(notify) / pipeline-init(内容断言) / verify-integration；删除 contract-tokens.test.ts | 0-4 |

---

## 决策↔Phase 双向覆盖核对

R1Q1B（声明即行为）→Ph2+3 | R1Q2A/R2Q1A（单层 groups 四类混用、跨组 AND）→Ph0+1 | R1Q4A（全量报/组前缀/熔断不变）→Ph1 | R1Q5（存量不考虑、init 现有逻辑）→Ph2(hasCustom 保护)+3 | R2Q2A/R5Q1A（when+scope 逐节严格）→Ph1+3 | R2Q3 系·R3Q1（命名组契约）→Ph0/1(校验位)+2 | R3Q2B（contracts 删除、节点属性化）→Ph0+2 | R3Q1 注记（一 verify.md 一 stage、跨文件=规则级覆写）→Ph0+1 | R4Q1A（节点三合一+双层 mode+糖）→Ph0 | R4Q4A（两级 path）→Ph0+1 | R4Q5A（modelRuntimeResult 正则、keywords deprecated）→Ph1 | R5Q2B（模型确认升格、verify:false 消灭）→Ph3 | R5suppl-1/R6Q2（guide 独立 task+scope 枚举）→Ph4 | R6Q1A（`runtime:` 单键两级）→Ph0+2 | 负面清单→Summary 排除项。**全覆盖，无缺项。**
