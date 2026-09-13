# Summary
- Plan 文件：`docs/design/176_Feat_plan.md`（Phase 0–4）；跟踪文件 `docs/design/176_Feat_plan_commit.md`（dev commit id = `5bcdc20`,`edddb9e`,`151a0ae`,`3b18f6c`,`0ae0678`,`cd42b83`；fix commit id = `38ac894`）。
- 审查范围：第 2 轮复核（round-1 报告的 2 High + 2 Medium 逐项复验）。对象 = `docs/review/code_review_176_Feat_plan_1.md`。方法 = 阅读 fix diff 与最终源码 + **独立源码级实证**（生产 `precheckRequiredFiles`/`precheckClarifyAwaitAnswer`/`loadVerifyContractAnchors`/`deriveClarifyForwardArgs`/`generateVerifyFiles`/`diffAndMergeRules` 跑真实 v6 模板与反例；**临时副本红绿判别**：复制 `src` 到 `/tmp` 后禁用 agent-settled 接线并重跑守护测试）+ `bun run build`/`typecheck`/`test` 全量验收。
- 范围合规：`38ac894` 变更 6 文件（3 源码 + 3 测试），全部落在 round-1 4 项修复范围内；`package.json`/`.opencode/`/`dist/`（生成物）零源码 diff；无越界。
- 实测验收：`bun run build` 0 错；`bun run typecheck` 0 错；`bun test` **3 次运行均 2174 pass / 0 fail（89 files）**（较 round-1 2169 增加 5 条新用例，与 fix 新增一致）。
- 独立结论：**round-1 的 4 项问题全部真实闭合**（High-1 precheck groups 穿透、High-2 扁平 fileContentPattern 数据丢失保护、Medium-3 agent-settled fail-open 集成红绿、Medium-4 锚点 issue 解耦）。**新发现 1 项 Medium**：High-2 选择「恢复保护」后未同步更新 plan F7/Phase 2 任务 5 与 guide 行为变更清单/merge 表，导致 plan 文档仍保留 F7↔Phase 4 任务 4 矛盾、guide 对扁平存量文件的 init 行为描述不完整；另有 2 项 LOW 观察项。

## Review发现以下问题

### 问题 1
- 问题：`docs/design/176_Feat_plan.md:16`（F7）与 `:115`（Phase 2 任务 5）仍规定 `diffAndMergeRules` 的 `hasCustom` 仅由 `existing.groups?.length > 0` 触发；但 `38ac894` 在 `src/core/verify-generator.ts:477-482` 增加了 `(existing.fileContentPattern?.length ?? 0) > 0`，即**扁平 `fileContentPattern` 也触发保护**。plan 文档未同步更新，round-1 报告要求的「二选一并写入 plan」只落地了代码与测试，未落地 plan；F7↔Phase 4 任务 4 的矛盾在 plan 层面仍然存在。同时 `src/template/guide.md:895` 的 merge 表把扁平自定义保护描述为「自定义规则（expectOutput 等）」，遗漏 `fileContentPattern`；`:1060` 行为变更清单仅称「含自定义 `groups` 的文件受 `exists_custom` 保护」，与实际「任何扁平 `fileContentPattern` 亦受保护」不一致——存量旧模板均含 `fileContentPattern`，走「Re-run verify generation」路径将被 `exists_custom` 跳过而不会 merge（仅「Force overwrite」可得新模板）。
- 等级：Medium
- 符合规划：否
- 是否修复：已修复（fix commit 36ff47e：plan F7/Phase 2 任务 5 与 guide §9.4 merge 表/§10 行为变更清单同步补齐扁平 fileContentPattern 保护描述，plan 文档与实现语义一致）
- plan是否覆盖
  - 已覆盖：Phase 2 任务 5（groups-only `hasCustom`）；Phase 4 任务 4（148 白名单替代保护等价绿）
  - 未覆盖：Plan 未同步——修复选择了 Phase 4 任务 4 的「保护」方向，但未回写 F7/Phase 2 任务 5，plan 内部矛盾未在文档层闭合；guide 行为变更清单/merge 表未补 `fileContentPattern` 行。建议重新设计方案：在 plan F7 与 Phase 2 任务 5 注明「扁平 `fileContentPattern` 亦纳入 `hasCustom` 保护（防 init merge 数据丢失）」，并同步 guide `§9.4.2` 表与行为变更清单。
- 改进建议：参考 round-1 问题 2 建议「二选一并写入 plan」——补齐 plan 文本与 guide；否则 plan 与实现长期不一致，后续维护者会按 F7 误删保护逻辑。

### 问题 2（LOW，无需修复）
- 问题：`src/__tests__/core/agent-settled.test.ts:1407-1466` 新增的「removing contract-unavailable wiring causes test to fail (red-green discrimination)」用例与 `:1338-1405` 首个用例 setup/断言几乎完全重复（同一 verify.md、同一报告、同一两条 audit 断言），仅少 assert notify 与 advance；该用例本身无法「自证」删接线必红，本质是重复守护用例。
- 等级：LOW
- 符合规划：是（plan Phase 2 要求集成红绿断言；重复不改变结论）
- 是否修复：无需修复（LOW）
- plan是否覆盖
  - 已覆盖：Phase 2 单元测试目标
  - 未覆盖：无
- 改进建议：合并为单条用例或提取 setup helper，避免双份维护；红绿判别已在 round-2 以临时副本实测（禁用接线 → 2 条用例转红）确证有效。

### 问题 3（LOW，无需修复）
- 问题：`src/core/auto-verifier.ts:671-684` 的 groups 预检遍历**所有**组内的 `requiredFile` 节点，未考虑组级 `when`/`scope`。若用户配置带 `when` 的条件组内含 `requiredFile`，即使 `when` 不命中（该组本应恒过）预检仍会要求其文件存在，可能造成过度 defer。当前 5 份 v6 模板的 `requiredFile` 均在无 `when` 的组内，无实际影响。
- 等级：LOW
- 符合规划：是（plan Phase 4 目标要求 168 预检等价，未定义条件组预检语义）
- 是否修复：无需修复（LOW）
- plan是否覆盖
  - 已覆盖：Phase 4 目标（168 等价）
  - 未覆盖：无
- 改进建议：如后续支持「条件组 + requiredFile」，预检可先判定组 `when`（与 `group-verifier` 同源），或改为直接复用组引擎求值 `requiredFile` 节点。

## 独立实证明细（本轮）

| 复验对象 | 独立证据 | 结论 |
|---|---|---|
| **High-1** v6 precheck（生产 `precheckRequiredFiles`） | 真实 `review_spec/verify.md` 部署到默认路径：无报告 → `{"passed":false,"missing":["docs/review/code_review_req*.md"]}`；报告 `code_review_req1.md` 存在 → `{"passed":true,"missing":[]}`（glob 具体化与继承均生效） | **已闭合** |
| **High-1** 新增用例 | `auto-verifier.test.ts` +3：groups requiredFile 缺失→false、存在→true、无 requiredFile 节点→true | 已闭合 |
| **High-2** 数据丢失（生产 `generateVerifyFiles`） | 旧式扁平 verify.md（自定义 `^# MyCustomSection`）重跑 init → `status=skipped/exists_custom`，`custom preserved=true`，`fileChanged=false`；v6 groups 模板重跑 → 同样 skipped；`diffAndMergeRules` 直接断言 `hasCustom=true` | **已闭合** |
| **High-2** 守护断言方向 | `verify-generator.test.ts` 由 round-1 的反向断言（`hasCustom=false`）改回 `hasCustom=true` / `merged=[]`，共 12 处；「init 1 merge regression」用例改为断言 `status=skipped`、`reason=exists_custom` | 已闭合（断言恢复，非反向） |
| **Medium-3** 红绿判别（临时副本） | 复制 `src` 至 `/tmp` 并 symlink `node_modules`：基线 `agent-settled.test.ts` 50 pass / 0 fail；将 `agent-settled.ts:218` 条件改为 `false &&`（禁用接线）后重跑 → **2 fail**（`contract-unavailable fail-open integration` 两条），48 pass | **已闭合（删接线必红）** |
| **Medium-3** 集成断言 | 新用例经真实 agent-settled hook：缺 `runtime: verdict` + 报告存在 → audit 含 `contract_anchor_unavailable` + `review_declaration_missing`、notify 含 "contract anchor unavailable"、不阻断后续 verify（advance 到 fix） | 已闭合 |
| **Medium-4** 锚点 issue 解耦（生产路径） | 构造「有效 `roundHeading` + verdict pattern 缺捕获组 1」：`loadVerifyContractAnchors` issues 非空但 `roundHeading` 存在；`deriveClarifyForwardArgs` → `await-answer round 1`（非 fresh）；`precheckClarifyAwaitAnswer` → `{awaiting:true,round:1}` | **已闭合** |
| 退役常量残留 | 同 round-1：源码零命中，仅 `guide.md:1061` 说明性引用 | 维持（说明性） |
| 验收门禁 | `bun run build` 0 错、`bun run typecheck` 0 错、`bun test` 3×2174 pass / 0 fail（89 files） | 通过 |
| 范围合规 | `38ac894` 6 文件（`auto-verifier.ts`/`pipeline-start.ts`/`verify-generator.ts` + 3 测试）；`package.json`/`dist`/`.opencode` 零 diff | 无越界 |

## 总体结论

- **round-1 遗留项闭合情况**：4/4 全部真实闭合。
  - High-1（precheck groups 穿透）：生产路径实测无报告拦截、有报告放行，新增 3 条用例覆盖。
  - High-2（扁平 fileContentPattern 数据丢失）：生产 `generateVerifyFiles` 实测文件不再被改写，守护断言已恢复为 `hasCustom=true`（非反向）。
  - Medium-3（agent-settled fail-open 红绿）：临时副本禁用接线后 2 条用例转红，接线真实有效。
  - Medium-4（锚点 issue 解耦）：有效 roundHeading + 其他锚点 issue 时不再降级 fresh，precheck 正常返回 awaiting。
- **本轮新发现**：**1 项 Medium（问题 1）**——已修复（fix commit 36ff47e，plan F7/Phase 2 任务 5 与 guide 同步）。**2 项 LOW（问题 2、问题 3）**，无需修复。
- **待处理**：问题 1 已修复；问题 2、问题 3 为 LOW，无需修复。round-1 的 4 项 LOW 观察项（section+glob、latest-section、guide CONTRACT_TOKENS、flaky 超时用例）状态不变，均无需修复。
- **验收门禁**：build/typecheck 0 错；bun test 2174 pass / 0 fail（89 files，3 次稳定复现），与 fix 自述一致。
- **Sub-Agent 触发**：按 code-review skill §5，存在 `待修复` 项（问题 1），应启动独立 fix 子代理 `code-review-withfix-agent docs/review/code_review_176_Feat_plan_2.md`；当前执行环境未提供 `task` 工具，未能自动触发，需上层 Agent 代为调度。
