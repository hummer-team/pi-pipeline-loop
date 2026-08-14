# Summary
- `docs/design/121_PipelineFlow_plan.md`
- Review 范围：6 个 commit（276f0db、8d6eb97、798054e、f129934、d8dd376、f45dabd）对 plan Phase 0-6 的实现。核心验证：stage_advance 内嵌验证门 + nextStage 参数化、verify 引擎 glob/{requirementDoc}、8→7 阶段状态机收敛、verify.md 模板权威化、pipeline-start 可选 file、模板 skill 修正、测试全量更新。`bun run build` 零错误，`bun run test` 427 用例全部通过。作用域合规：所有改动文件均在 plan 变更清单内，无作用域外文件。

## Review发现以下问题

### 问题 1
- 问题: src/core/stage-advancer.ts:139-149 完成态 UI 行为与 plan 不符。plan Phase 0 任务 1(e) 明确要求 `targetStage === "completed"` 时调用 `ui.clearStage`，否则 `ui.transition`。实现仅在 `resolvedTarget === null` 时调用 `ui.clearStage`，否则一律 `ui.transition`。在新模板（review.nextStage="completed"）下，review→completed 时 resolvedTarget="completed"（非 null），实际走 `ui.transition` 而非 `ui.clearStage`，流水线完成时状态栏未被清除。
- 等级：Medium
- 符合规划：否
- 是否修复：已修复
- plan是否覆盖
  - 已覆盖：Phase 0 任务 1(e) 明确规定了 clearStage 触发条件
- 改进建议：参考 Plan Phase 0 任务 1(e)：将 clearStage 判定改为 `resolvedTarget === "completed"`（保留 null→completed 的兼容路径），使完成态清除状态栏

### 问题 2
- 问题: src/__tests__/core/stage-advancer.test.ts 缺少 plan Phase 0 任务 3 明确要求的 "verify.require 且验证通过（mock verify.md 存在/规则命中）→ 推进" 用例。现有 verification gate 用例仅覆盖：require=false 跳过、verify 未定义跳过、verify.md 缺失导致验证失败不推进、execFn 注入。验证门**通过后推进**的成功路径无测试覆盖。
- 等级：Medium
- 符合规划：否
- 是否修复：已修复
- plan是否覆盖
  - 已覆盖：Phase 0 任务 3 列出的 4 个用例中第 2 个（"verify.require 且验证通过（mock verify.md 存在/规则命中）→ 推进"）未实现
- 改进建议：参考 Plan Phase 0 任务 3：在临时目录预建 verify.md（含命中规则），断言验证通过后 currentStage 推进到 nextStage

### 问题 3
- 问题: src/__tests__/core/prompt-injector.test.ts 未按 plan Phase 4 任务 4 更新 Part7 断言。commit d8dd376 仅修改了 src/core/prompt-injector.ts（buildVerifyToolGuidance 文案改为 stage_advance 指引），但测试文件无任何 Part7 / VERIFICATION MODE: TOOL / stage_advance 指引相关断言，新文案无测试覆盖。
- 等级：Medium
- 符合规划：否
- 是否修复：已修复
- plan是否覆盖
  - 已覆盖：Phase 4 任务 4 "prompt-injector.test.ts 更新 Part7 断言" 未执行
- 改进建议：参考 Plan Phase 4 任务 4：在 prompt-injector.test.ts 增加 tool-mode 用例，断言 systemPrompt 包含 "本阶段验证模式为 TOOL" 与 "stage_advance"

### 问题 4
- 问题: src/template/guide.md 阶段表（第 198-206 行）各阶段"工具权限"列未同步 `stage_advance`（clarify/plan/review 显示 read, bash；develop/fix 显示 read, bash, write, edit），与 STAGE_TYPE_TOOL_DEFAULTS 已加 stage_advance 及 guide.md 3.1 全配置示例（develop/fix 含 stage_advance）不一致。plan Phase 2 任务 8 要求阶段表同步。
- 等级：Medium
- 符合规划：否
- 是否修复：待修复
- plan是否覆盖
  - 已覆盖：Phase 2 任务 8 "阶段表、交接流程、配置示例同步"
- 改进建议：参考 Plan Phase 2 任务 8：guide.md 阶段表工具列补充 stage_advance

### 问题 5
- 问题: docs/design/121_PipelineFlow_plan_commit.md 仅列 6 个 commit id，plan 共 7 个 Phase。Phase 5（模板 skill 约束 + pipelineId 头部约定）改动因 src/template 在 .gitignore 中（e0f74d0 起 untrack）无法入库，无对应 commit id，文档未注明该情况。
- 等级：LOW
- 符合规划：否
- 是否修复：不修复
- plan是否覆盖
  - 已覆盖：Phase 5 无对应 commit 记录（模板文件 gitignore 所致），可视为"未覆盖"但为仓库既有约定
- 改进建议：建议重新设计方案或补充说明：Phase 5 模板改动以磁盘文件为准，commit 列表无法承载
