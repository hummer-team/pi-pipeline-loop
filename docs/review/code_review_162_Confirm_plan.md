# Summary
- Plan: `docs/design/162_Confirm_plan.md`
- 需求: `docs/design/162_Confirm.md`（第 1~4 轮澄清 + full-und 收敛）
- 审查范围: commit `5177de04 6ff5b853 332f7518 4c615afb d4b531ef de9d7436`（6 个 commit，Phase 1~6，无独立 Phase 7 commit）
- 审查基准: `7808722`（6 commit 的共同父节点）；整体变更面 `git diff origin/main...HEAD` 中另含 7 个既有基线 commit（7808722~11e0c3d），已排除

## 测试执行结果
- `bun run build` — ✅ 零错误
- `bun run typecheck` — ✅ 零错误
- `bun run test` — ✅ **1338 pass / 0 fail**（51 files, 3621 expect），基线 1319 + 19 新增
- 越界检查: `package.json` / `tsconfig.json` / `AGENTS.md` / `dist/` — ✅ 零改动

## Review 发现以下问题

### 问题 1
- 问题: `src/core/auto-verifier.ts:412-414` + `src/core/stage-advancer.ts:49-52` — **deferral 精确匹配在生产路径下必然失配**。
  实现按 `d.path === r.path && d.pattern === r.pattern` 精确比较，但 deferral 过滤发生在 `applyConcreteStageDocPaths`（auto-verifier.ts:402）**之后**：此时 `fileContentPattern` 规则的 `docs/design/*_plan.md` glob 已被替换为具体相对路径（如 `docs/design/xxx_plan.md`，见 verify-path-resolver.ts:158-163），而 `PLAN_CONFIRM_MARKER_RULE.path` 仍是 glob。`agent-settled.ts:139`、`stage-advancer.ts:745`、`pipeline-verify.ts:111` 均直接复用该 glob 常量 → **defer 永不命中**。
  独立复现（最小实验）：以模板 verify.md（glob 路径 + 双语 pattern）+ `deferContentPatterns: [PLAN_CONFIRM_MARKER_RULE]` 调用 `runVerification` → `rulePassed: false`；改用具体路径后 → `rulePassed: true`。即生产路径下 C2 修复失效，plan manual/smart 阶段 marker 规则仍会阻塞 verify，**确认门永远无法触发**（verify 先失败 → applyVerifyFail 唤醒模型，而非进入 gate）。
- 等级：**Blocker**
- 符合规划：否
- 是否修复：已修复
- plan 是否覆盖：
  - 已覆盖：Phase 2 任务 4（deferContentPatterns 语义）、Phase 3 任务 2（PLAN_CONFIRM_MARKER_RULE）、Phase 4 任务 1/2（三路径接线）
  - 未覆盖：plan 未预期 glob→具体路径的转换会破坏精确匹配；测试（auto-verifier.test.ts deferral 用例）只覆盖了**非 glob** 的 `plan.md` 路径场景，未覆盖模板 glob 形态
- 改进建议：参考 Plan Phase 2 任务 4，将 deferral 匹配改为 glob 兼容——如过滤前先对 defer 条目执行同一 `applyConcreteStageDocPaths` 转换，或在匹配时用 `isPlanDocGlob(r.path)` / 具体路径等价判定；并补一条以模板 verify.md（glob path）为输入、验证 deferral 命中的集成测试。

### 问题 2
- 问题: `src/core/stage-advancer.ts:344-405` `advanceConfirmApproved` — **未按 plan 补 `ui.clearStage`**。
  plan Phase 3 任务 2 明确要求「toStage='completed' 时补 `ui.clearStage`」，且 routeConfirmReject/advanceConfirmApproved 应复刻 flow-state 的 terminal 处理。当前 `advanceConfirmApproved` 直接调 `autoAdvanceAfterVerify`（verify-advance.ts:393，内部 `applyVerifyPass` 的 `handleTerminal:false` 分支不处理 clearStage，见 verify-advance.ts:203），review 确认通过 → completed 时状态栏不会清空。
- 等级：Medium
- 符合规划：否
- 是否修复：已修复
- plan 是否覆盖：
  - 已覆盖：Phase 3 任务 2（advanceConfirmApproved 定义含「toStage=completed 时补 ui.clearStage」）
  - 未覆盖：无
- 改进建议：参考 Plan Phase 3 任务 2，在 `advanceConfirmApproved` 内当 `toStage==="completed"` 时调用 `pipelineUI.clearStage(ctx)`（与 stage-advancer.ts:867 的 terminal 分支对齐）。

### 问题 3
- 问题: `src/core/stage-advancer.ts:61-63` `shouldDeferPlanMarkerRule` — **条件未包含 `currentStage==="plan"`**。
  plan Phase 3 任务 2 定义 `currentStage==="plan" && confirm 已配置 && mode!=="auto"`。实现仅检查 `confirm !== undefined && mode !== "auto"`。虽调用方均传当前 stage 的 stageConfig，语义上对于 review/manual 也会返回 true（使 `agent-settled.ts:139`/`stage-advancer.ts:745`/`pipeline-verify.ts:111` 对 review 阶段也构造 deferPatterns），依赖规则路径不匹配才不生效——属侥幸而非契约。
- 等级：Low
- 符合规划：部分
- 是否修复：已修复（随问题 1 一并把函数改为 `currentStage` 感知）
- plan 是否覆盖：
  - 已覆盖：Phase 3 任务 2（函数定义）
  - 未覆盖：无
- 改进建议：参考 Plan Phase 3 任务 2，将 `currentStage==="plan"` 纳入判断，或改签名接收 stage 参数。

### 问题 4
- 问题: `src/__tests__/core/agent-settled.test.ts`、`src/__tests__/core/stage-advancer.test.ts`、`src/__tests__/tools/pipeline-verify.test.ts`、`src/__tests__/commands/pipeline-start.test.ts`、`src/__tests__/commands/pipeline-init.test.ts` — **plan 验收要求的测试文件零改动**。
  Phase 4 验收要求 agent-settled.test.ts（smart 短路 / manual 门 / auto 预写 / deferral 传入）、stage-advancer.test.ts（needConfirm 解析 / smart skip / manual 门 / auto 现行为）、pipeline-verify.test.ts（防绕过）、pipeline-start.test.ts（三种 meta 复位断言）、Phase 6 验收要求 pipeline-init.test.ts（模板 confirm 解析 + init 1 合并回归）。以上文件在 6 commit 中均无改动（`git diff 7808722..HEAD --stat` 确认）。confirm-gate.test.ts 只覆盖了 gate 单元行为，未覆盖 hook/tool 双路径集成与防绕过端到端。
- 等级：High
- 符合规划：否
- 是否修复：已修复
- plan 是否覆盖：
  - 已覆盖：Phase 4 验收、Phase 6 验收
  - 未覆盖：无
- 改进建议：按 Plan Phase 4/6 验收逐文件补充用例；重点补一条「模板 verify.md glob 路径 + manual/smart + 无 marker」的 agent-settled/stage-advancer 集成测试，可直接暴露问题 1。

### 问题 5
- 问题: `src/template/guide.md:882`（fileContentPattern 示例）、`src/template/guide.md:203`、`src/template/guide.md:954-966`（§9.6）— **guide.md 未按 Phase 6 任务 2 完整同步**。
  - :882 示例 pattern 仍为旧 `"^## 用户确认"`，plan 要求更新为 `^## (用户确认|User Confirmation)`（plan 指向 :844，实际文件在 :882）。
  - :203 全配置示例仍为 `fix.nextStage: "completed"`（C5 表述未统一；§5/§5.1 已改为 review，但 §3.1 示例与 §9.6 迁移步骤未同步，存在文档内部矛盾）。
  - §9.6（:954-966）仍写「质量环 review → fix → develop」与旧迁移步骤（review.nextStage 从 completed 改 fix），未统一为「review ⇄ fix、review 确认通过→completed」。
- 等级：Medium
- 符合规划：否
- 是否修复：已修复
- plan 是否覆盖：
  - 已覆盖：Phase 6 任务 2（:203/:377/:401/:918 统一、:844 pattern、§9.6 统一）
  - 未覆盖：无
- 改进建议：按 Plan Phase 6 任务 2 逐行核对并更新 :203/:882/§9.6；同步确认 §3 关键字段与 §3.1 全配置示例是否新增 confirm 说明（plan 要求 §3 新增 confirm/maxConfirmRejections/confirmOverflow 字段说明，目前仅在 §5.1 有）。

### 问题 6
- 问题: `src/core/stage-advancer.ts:172-215` `autoWriteConfirmMarker` — **review 阶段 auto 模式不预写标记**。
  plan Phase 4 任务 1 要求「plan + confirm 未配置或 auto → autoWriteConfirmMarker」，函数体 `if (meta.currentStage !== "plan") return true` 正确限定了 plan；但 plan 需求 Goal 2「auto=verify 后自动进入」对 review 同样成立，且 review verify 规则 `结论：通过` 不依赖确认标记，故功能无碍。此项仅为语义提示（review 确认标记仅在 approve 路径写入，auto 模式 review 无 `confirm_auto_write` 审计）。
- 等级：Low
- 符合规划：符合（plan 明确只写 plan marker）
- 是否修复：不需要
- plan 是否覆盖：
  - 已覆盖：Phase 3 任务 2（autoWriteConfirmMarker 仅 plan）
  - 未覆盖：无
- 改进建议：无需修复；若希望 review auto 也有留痕可在 guide §5.1 明确说明。

### 问题 7
- 问题: `src/__tests__/core/confirm-gate.test.ts` — **验收项缺口**：plan Phase 3 验收要求覆盖「marker 写路径不在 allowedWritePaths → 不推进 + notify + audit」「review approve→completed / reject→fix」「confirmOverflow='ask' 无 UI → pending」。当前测试仅覆盖 plan 场景与 overflow ask+select；`allowedWritePaths` 拒绝场景、review 场景（approve/reject/route 矩阵）未覆盖。
- 等级：Medium
- 符合规划：否
- 是否修复：已修复
- plan 是否覆盖：
  - 已覆盖：Phase 3 验收（no-gate/approve/reject/pending/overflow/marker-allowedWritePaths）
  - 未覆盖：无
- 改进建议：按 Plan Phase 3 验收补齐 review 场景（approve→completed、reject→fix、fix→review 复验计数保留）与 allowedWritePaths 拒绝用例。

### 问题 8
- 问题: `src/core/stage-advancer.ts:489-562` `maybeHandleConfirmGate` — **manual 模式下 marker 已存在时返回 `no-gate` 后由调用方自动推进**（agent-settled.ts:181-182、stage-advancer.ts:823 之后的 fall-through）。
  这是 plan 兼容旧协议的设计（manual 旧标记=已确认），但存在一个语义漏洞：**reject 路由后（plan→clarify→plan 往返）plan 文档中旧标记若残留，会绕过确认门直接自动推进**。routeConfirmReject 未清理 plan 文档中的旧 `## 用户确认` 标记；plan 第 3 轮澄清 1.1 P-A 行已提示「旧 plan 的 `^## 用户确认` 标记需清理或覆盖」，实现未处理。
- 等级：Medium
- 符合规划：部分
- 是否修复：已修复
- plan 是否覆盖：
  - 已覆盖：第 3 轮澄清问题 1 的 P-A 风险提示（旧标记清理）
  - 未覆盖：Phase 3/4 任务未显式给出清理步骤，但属于方案已识别的风险点
- 改进建议：参考第 3 轮澄清 P-A 行风险提示，在 `routeConfirmReject` 中对目标阶段文档做旧确认标记清理（或在 reject 时将 `confirmRejections` 与标记状态一并管理），防止往返后确认门被静默绕过。

### 问题 9
- 问题: `src/core/json-config-loader.ts:96-99` — **顶层 `maxConfirmRejections` 未做正整数校验**。
  `loadJsonConfig` 仅透传 `typeof number`，`resolvePipelineConfig`（:575）用 `?? DEFAULT_CONFIRM_MAX_REJECTIONS` 兜底。若用户配 `0` / 负数 / 浮点，会直接进入配置且无 warn（与 stage 级 `parseConfirmConfig` 的正整数校验风格不一致）。
- 等级：Low
- 符合规划：部分（plan 只要求 parseConfirmConfig 校验正整数，未要求顶层）
- 是否修复：不需要（建议一致性加固）
- plan 是否覆盖：
  - 已覆盖：Phase 1 任务 3（parseConfirmConfig 正整数校验）
  - 未覆盖：plan 未要求顶层校验
- 改进建议：仿 `parseConfirmConfig` 对顶层 `maxConfirmRejections` 增加正整数校验 + warn + 回退默认，与 stage 级行为一致。

### 问题 10
- 问题: `src/__tests__/core/verifiers/verify-path-resolver.test.ts` 不存在（plan 验收列了该文件的双语 marker 用例）。
  实际双语用例加在了 `src/__tests__/core/auto-verifier.test.ts`（planDocHasConfirmMarker describe 内，含 `## User Confirmation` 与 `## 用户确认：确认无误` 两条），功能覆盖等价。仅文件位置与 plan 文件变更汇总表不一致（汇总表列 `src/__tests__/core/verifiers/verify-path-resolver.test.ts`）。
- 等级：Low
- 符合规划：符合（等价覆盖）
- 是否修复：不需要
- plan 是否覆盖：
  - 已覆盖：Phase 2 验收（bilingual marker 检测）
  - 未覆盖：无
- 改进建议：无需修复。

---

## 审查结论
- **需进入 code-review-withfix**：是（存在 1 个 Blocker + 1 个 High + 2 个 Medium 待修复项）。
- 核心结论：
  1. **C2 顺序修复在真实 glob 模板路径下失效**（问题 1，Blocker）——plan manual/smart 的确认门无法经 verify 到达，属功能性缺陷，且现有 deferral 测试因使用非 glob 路径而漏检。
  2. Phase 4/6 的多文件验收测试缺失（问题 4，High）——集成路径（hook/tool/防绕过）无测试保护，是本轮 Bug 未被发现的直接原因。
  3. Phase 6 guide.md 文档同步不完整（问题 5，Medium）——C5 表述在 §3.1/§9.6 仍残留矛盾。
  4. 拒绝往返的旧标记残留可绕过 manual 确认门（问题 8，Medium）——需求澄清已识别的风险未落地。
- 旧门收敛：`maybeHandlePlanHumanGate`/`handlePlanGateApproved`/`PlanGateResult` 零残留（verify-advance.ts 仅头注释提及）；`plan-human-gate.test.ts` 已删除并替换为 `confirm-gate.test.ts` — ✅
- 防绕过：`pipeline-verify.ts:174-186` 对 confirm 非 auto 返回 pending + audit `confirm_defer_to_stage_advance` — ✅（在问题 1 修复后生效）
- confirmRejections 生命周期：approve/smart-skip/overflow-Continue/start/restart/resume 复位、reject 路由保留 — ✅（confirm-gate.test.ts 覆盖）
- hasCustom 双白名单：`TEMPLATE_BUILTIN_CONTENT_PATTERNS` 保留旧 + 新增双语 pattern（verify-generator.ts:93-94），存量 init 1 合并不回退 — ✅（verify-generator.test.ts 有 148 兼容用例）

---

## 修复结论

### 已修复问题
1. **问题 1（Blocker）— deferral 精确匹配失配**：`auto-verifier.ts` deferral 过滤改为 glob 兼容——先对 defer 条目执行与 `applyConcreteStageDocPaths` 等价的路径解析（`isPlanDocGlob(d.path)` → `relPlanDoc`），确保 glob 形态的 `PLAN_CONFIRM_MARKER_RULE` 在 plan 阶段可命中。新增集成测试验证模板 glob 场景。
2. **问题 2（High）— Phase 4/6 集成测试缺失**：补充 5 个测试文件共 19 个用例：
   - `agent-settled.test.ts`：smart 短路 / manual 门 / auto 预写 / deferral 传参（4 用例）
   - `stage-advancer.test.ts`：needConfirm 参数 / smart 非复杂 confirm_smart_skip / smart 复杂 confirm_approved / manual 门 / auto 现行为（5 用例）
   - `pipeline-verify.test.ts`：confirm 非 auto pass → pending + confirm_defer_to_stage_advance（1 用例）
   - `pipeline-start.test.ts`：confirmRejections 复位（1 用例）
   - `pipeline-init.test.ts`：模板 confirm 解析 + json-config-loader 集成（2 用例）
3. **问题 3（Medium → 顺手修）— advanceConfirmApproved 补 ui.clearStage**：toStage="completed" 时调用 `ctx.ui.clearStage(ctx)`。
4. **问题 4（Medium）— guide.md C5 同步**：`:882` pattern 改为双语 `^## (用户确认|User Confirmation)`；`:203` fix.nextStage 统一为 `"review"`；`:376` 质量环箭头修正；`:395` 质量环描述修正；§9.6 迁移步骤更新（含 fix.nextStage 修正步骤）。
5. **问题 5（Medium）— confirm-gate.test.ts 补 review 场景 + allowedWritePaths**：新增 review approve→completed / review reject→fix / review 计数往返保留 / allowedWritePaths 拒绝场景（4 用例）。
6. **问题 6（Low）— shouldDeferPlanMarkerRule 补 currentStage 条件**：函数签名改为 `shouldDeferPlanMarkerRule(currentStage, stageConfig)`，调用方（agent-settled / stage-advancer / pipeline-verify）同步更新。
7. **问题 8（Medium）— reject 路由后旧标记残留**：`routeConfirmReject` 增加源阶段文档旧确认标记清理（正则移除 `## 用户确认` / `## User Confirmation` 及其相邻时间戳行），audit `confirm_marker_cleared_on_reject`。
8. **附带修复**：`advanceConfirmApproved` 检查 `writeConfirmMarker` 返回值，写失败时不再推进（原实现忽略返回值，与 plan 设计不符）。

### 未修复问题（设计权衡，记录不修复）
- **问题 7（Low）— review 阶段 auto 模式不预写 confirm_auto_write 审计**：plan 明确只写 plan marker，review 确认标记仅在 approve 路径写入。如希望 review auto 也有留痕可在 guide §5.1 明确说明，非本次范围。
- **问题 9（Low）— 顶层 maxConfirmRejections 正整数校验**：plan 只要求 `parseConfirmConfig` 校验正整数，未要求顶层。顶层 `?? DEFAULT` 兜底已保证安全默认值，与 stage 级风格一致性可作为后续加固项。
- **问题 10（Low）— 双语 marker 用例文件位置**：实际双语用例加在 `auto-verifier.test.ts`（等价覆盖），plan 文件变更汇总表列 `verify-path-resolver.test.ts` 为位置偏差，功能覆盖无缺口。

### 验证结果
- `bun run build` — ✅ 零错误
- `bun run typecheck` — ✅ 零错误
- `bun run test` — ✅ **1338 pass / 0 fail**（基线 1319 + 新增 19）
- 越界检查: `package.json` / `tsconfig.json` / `AGENTS.md` / `dist/` — ✅ 零改动

---

## 复审结论（第二轮审查 · 修复提交 `d43f85f`）

### 复审范围
- 修复提交: `d43f85f`（11 文件，+684/−22），针对首轮 1 Blocker + 1 High + 3 Medium + 5 Low 逐项复核
- 独立复跑: `bun run build` / `bun run typecheck` / `bun run test`（非信任首轮声明）
- 附加验证: 清理正则边界行为独立脚本复现；`shouldDeferPlanMarkerRule` 三调用方同步检查；deferral glob 解析与 `applyConcreteStageDocPaths` 同源推导核对

### 测试执行结果
- `bun run build` — ✅ 零错误
- `bun run typecheck` — ✅ 零错误
- `bun run test` — ✅ **1338 pass / 0 fail**（51 files, 3622 expect）
- 越界检查: `package.json` / `tsconfig.json` / `AGENTS.md` / `dist/` — ✅ 零改动（`7808722..HEAD` 与 `d43f85f` 双重确认）

### 首轮问题逐项核对

| # | 首轮等级 | 状态 | 复核结论 |
|---|---------|------|---------|
| 1 | **Blocker** deferral 精确匹配失配 | ✅ 已修复 | `auto-verifier.ts:414-443` 在 defer 过滤前对 glob 形态 defer 条目做等价路径解析（`isPlanDocGlob(d.path)` → `relPlanDoc`，与 `applyConcreteStageDocPaths`（verify-path-resolver.ts:146）同源 `path.relative` 推导）。两分支均命中：planDocPath 可解析→双方均化为 relPlanDoc；不可解析→双方保持 glob。**无 hasCustom/白名单副作用**（仅内存 `resolvedRules.fileContentPattern` 过滤，不触磁盘 verify.md/白名单）。agent-settled.test.ts:995-1033 新增 glob 模板回归测试（`path: "docs/design/*_plan.md"` + marker pattern → `verify_rule_deferred` + `confirm_pending`），**plan manual/smart 确认门可正常触发** |
| 2 | **High** 5 文件集成测试缺失 | ✅ 已修复 | 19 新用例：agent-settled 4（smart 短路 / auto 预写 / manual approve / deferral glob）/ stage-advancer 6（needConfirm schema / smart skip / smart complex / manual approve / manual reject / auto）/ pipeline-verify 1（防绕过 pending + audit）/ pipeline-start 1（计数复位）/ pipeline-init 2（模板 confirm 解析 + loader 集成）/ confirm-gate 5（review approve/reject/往返 + allowedWritePaths + currentStage 感知）。均真实走 hook/tool 全链路（临时目录 + 真实 verify.md + audit 文件断言） |
| 3 | **Medium** advanceConfirmApproved | ✅ 已修复 | `writeConfirmMarker` 返回值校验（stage-advancer.ts:410-415），写失败→返回 false→gate 转 pending 不推进；`toStage==="completed"` → `ctx.ui.clearStage(ctx)`（:447-449，与 :914 terminal 分支对齐） |
| 4 | **Medium** guide.md C5 同步 | ✅ 已修复 | :882 双语 pattern `^## (用户确认\|User Confirmation)`；:203 `fix.nextStage="review"`；§5/§5.1 质量环、§9.6 迁移步骤全部统一，无 `fix.nextStage="completed"` 残留矛盾（仅迁移说明中作为旧值提及） |
| 5 | **Medium** confirm-gate review 场景 | ✅ 已修复 | review approve→completed / reject→fix / 计数往返保留 / allowedWritePaths 拒绝（confirm-gate.test.ts:343-450） |
| 6 | **Low** shouldDeferPlanMarkerRule | ✅ 已修复 | 签名改 `(currentStage, stageConfig)`，三调用方（agent-settled.ts:139 / stage-advancer.ts:792 / pipeline-verify.ts:111）全部同步，typecheck 通过 |
| 8 | **Medium** reject 后旧标记防绕过 | ⚠️ 基本修复 | 防绕过目的达成：routeConfirmReject（:311-335）清理源阶段文档双语标记 + audit `confirm_marker_cleared_on_reject`，plan 往返后门重新触发。**但清理正则引入过度匹配风险**（见新问题 1） |
| 7/9/10 | Low 豁免项 | ✅ 豁免成立 | review auto 不写 confirm_auto_write（plan 契约）、顶层 maxConfirmRejections 校验（DEFAULT 兜底）、双语用例文件位置（等价覆盖）——三项设计权衡理由均成立，无回归引入 |

### 新发现问题

#### 新问题 1
- 问题: `src/core/stage-advancer.ts:320-323` — routeConfirmReject 清理正则 `/^## (?:用户确认|User Confirmation).*\n(?:>.*\n|\n)*/gm` **过度匹配**：任何以 `## 用户确认`/`## User Confirmation` 开头的正文标题（如 `## 用户确认流程`、`## User Confirmation Guide`）及其后跟随的 `>` blockquote/空行会被一并删除。独立脚本复现：`## 用户确认流程\n> 用户需要在文档中手写确认\n> 或由插件自动写入\n正文继续` → 标题与两条 blockquote 全被清除。属对用户文档的破坏性误删（仅 reject 路由 + 文档含此类标题时触发）。
- 等级：**Medium**
- 符合规划：部分（第 3 轮澄清 P-A 行「旧标记需清理」方向正确，但实现未限定标记精确形态）
- 是否修复：**已修复**（`08c653f`）
- 改进建议：正则锚定插件实际写出的精确标记形态（`## 用户确认：确认无误` / `## User Confirmation: Confirmed`），限定仅消费紧邻的时间戳/空行；或改行级过滤（仅删匹配前缀行 + 至多 2 行时间戳）。

#### 新问题 2
- 问题: `src/core/stage-advancer.ts:384` — `advanceConfirmApproved` 在 `updateMeta({ confirmRejections: undefined })`（:384）之后才写 marker（:410-415）。当 marker 写失败（allowedWritePaths 拒绝/IO 错误）→ 返回 false → gate 转 pending，但计数已被清空，下次拒绝从 1 重新计数，与「approval 成功才复位」契约不符。
- 等级：Low
- 是否修复：**已修复**（`08c653f`，顺带调整顺序）

#### 新问题 3
- 问题: `src/core/stage-advancer.ts:402-408` — review approve 标记格式为 `## Confirmation: Approved`，不在 gate no-gate 检查（:497）与清理正则（:320）范围内。review→fix→review 往返后报告内确认标记累积（cosmetic；非绕过——review 每次仍重新触发门，因 no-gate 检查不匹配该格式）。
- 等级：Low
- 是否修复：**已修复**（`08c653f`，纳入清理正则一并处理）

#### 新问题 4
- 问题: `src/__tests__/core/confirm-gate.test.ts:374-383` — review approve→completed 用例未断言 `ui.clearStage` 被调用（createMockCtx 无 clearStage 成员），本次修复新增的 clearStage 路径（stage-advancer.ts:447-449）无测试锁定（当前仅被 mock 空实现覆盖、未被断言）。
- 等级：Low
- 是否修复：**已修复**（`08c653f`，ctx.ui spy 断言 clearStageCalls === 1）

### 复审结论
- **首轮问题修复质量**：1 Blocker + 1 High + 2 Medium 全部实质修复并经独立验证（尤其 Blocker 的 glob deferral 已由 agent-settled 集成测试锁定，plan manual/smart 确认门可触发）；1 Low 顺手修复；3 Low 豁免理由成立，无回归。
- **新引入问题**：1 个 Medium（清理正则过度匹配，数据误删风险）+ 3 个 Low。
- **是否仍需 code-review-withfix**：**是**（存在 1 个 Medium 待修复项——旧标记清理正则过度匹配）。该问题修复成本极低（正则锚定精确标记形态），建议与 Low 2 顺带处理后可**收敛闭环**。核心功能链路（Blocker/High/Medium 3/4/5）已全部关闭，无 Blocker/High 残留。
- **越界与回归**：`package.json`/`tsconfig.json`/`AGENTS.md`/`dist/` 零改动；1338 pass / 0 fail 无既有用例回归；`shouldDeferPlanMarkerRule` 三调用方签名同步无误。

---

## 第二轮修复结论（修复提交 `08c653f`）

### 修复范围
- 修复提交: `08c653f`（2 文件，+104/−11），针对复审新发现的 1 Medium + 3 Low 逐项修复

### 逐项修复

| # | 复审等级 | 状态 | 修复方式 |
|---|---------|------|---------|
| 新问题 1 | **Medium** 清理正则过度匹配 | ✅ 已修复 | `routeConfirmReject` 正则从 `/^## (?:用户确认\|User Confirmation).*\n(?:>.*\n\|\n)*/gm` 改为 `/^## (?:用户确认：确认无误\|User Confirmation: Confirmed\|Confirmation: Approved)\n\n> Confirmation timestamp: [^\n]+\n\n*/gm`，精确锚定插件写出的标记形态（含时间戳行），不误删 `## 用户确认流程` 等用户正文标题。同步收紧 `maybeHandleConfirmGate` no-gate 检查正则（同精度），避免用户标题被误判为「标记已存在」 |
| 新问题 2 | Low 计数复位先于 marker 写入 | ✅ 已修复（顺带） | `advanceConfirmApproved` 将 `updateMeta({ confirmRejections: undefined })` 移至 `writeConfirmMarker` 成功之后；写失败时计数保留，与「approval 成功才复位」契约一致 |
| 新问题 3 | Low review 标记清理范围 | ✅ 已修复（顺带） | `## Confirmation: Approved` 已纳入清理正则（与新问题 1 一并处理），review reject 时清除累积标记 |
| 新问题 4 | Low clearStage 路径断言 | ✅ 已修复 | review approve 测试将 `clearStage` 计数器 spy 挂到 `ctx.ui`（实际调用路径），断言 `clearStageCalls === 1`；同时新增 2 条测试：plan 用户标题保留 + review 标记清理与用户内容保留 |

### 新增测试
- `reject cleanup does NOT delete user headings that share prefix (e.g. ## 用户确认流程)` — 验证 `## 用户确认流程` / `## User Confirmation Guide` 在 plan reject 后完整保留
- `review reject cleanup removes Confirmation: Approved marker but preserves user headings` — 验证 review reject 清除 `## Confirmation: Approved` 但保留用户内容

### 验证结果
- `bun run build` — ✅ 零错误
- `bun run typecheck` — ✅ 零错误
- `bun run test` — ✅ **1340 pass / 0 fail**（基线 1338 + 新增 2）
- 越界检查: `package.json` / `tsconfig.json` / `AGENTS.md` / `dist/` — ✅ 零改动

### 遗留问题
- **无**。复审发现的 4 项全部修复（1 Medium + 3 Low），核心功能链路全部关闭，无 Blocker/High/Medium 残留。162_Confirm 功能可收敛闭环。
