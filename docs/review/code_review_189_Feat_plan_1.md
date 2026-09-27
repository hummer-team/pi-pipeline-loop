# Summary
   - **Plan 文件**: `docs/design/189_Feat_plan.md`（commit 依据 `docs/design/189_Feat_plan_commit.md`：Phase 0 `4b31d4d` / Phase 1 `e2d317c` / Phase 2 `2bf3426`）
   - **Review 范围**: 循环依赖解耦（DI handler registry）+ 3 个巨型测试文件拆分的实现质量与计划覆盖度；范围合规、拆分零语义变更完整性校验、Phase 0 测试目标落地核查、TS 编码规范。
   - **主会话独立验证**: `bun run build` / `typecheck` 零错误；全量 `bun test` **2608 pass / 0 fail**（114 文件）= 基线 2598 + 净新增 10；产物级证据 `dist/utils/subagent-rpc.js` 零 `require("../core/`；工作树干净。
   - **核心结论**: 解耦方案落地正确、拆分完全无损（describe/it 标题逐条比对三个文件集全部一致）；但 Phase 0 存在 2 个与计划不符的待修复项（类型回退 + 计划测试缺项）。

   ## 通过项（要点）

   | 检查项 | 结论 |
   |---|---|
   | 范围合规 | ✅ 3 commit 共 22 文件，全部落在计划「文件变更汇总」清单内，无计划外改动 |
   | A 组运行时环消除 | ✅ `subagent-rpc.ts` 对 core 仅剩 :26 `import type`（编译期擦除）；guard 测试区分 type-only，B/C 组良性环未受误伤 |
   | DI 注册与时序 | ✅ `FixExecutorCompletedCtx` + `set/peek` 注册点齐备；生命周期回调内 `clearActiveSpawn → await handler → cleanup` 时序与原实现逐行一致；未注册静默跳过有注释 |
   | 组合根接线 | ✅ `index.ts` 在 `createPipeline` 返回工厂函数体开头注册（非模块装载副作用），`index-registration.test.ts` 有 `__peek` 非空守护 |
   | Issue 8 不回退 | ✅ `verifyCtx` 保留 `_ctx`/`runtimeCtx` 透传（计划明确要求，实测在位） |
   | A–F 迁移卫生 | ✅ `fix-executor-completion.test.ts` beforeEach 注册 handler / afterEach 置 null（吸收 7584e76 mock 泄漏教训），6 用例标题与断言原样 |
   | 拆分完整性 | ✅ agent-settled / confirm-gate describe 与 it 标题新旧集合完全一致；tool-guard 除外层 `createToolGuard` 按计划 1→6 复制外，26 内层 describe 与全部 it 标题逐条一致（比对已正确排除既有 `tool-guard-suppress.test.ts`） |
   | 行数验收 | ✅ 三个原巨型文件降至 665/699/688 行，全部拆分产物 ≤1000 行 |
   | DRY（Skill 规则 4） | ✅ `createMockEventBus` 上移 `helpers.ts:254`，`subagent-rpc.test.ts` 局部定义删除、两处改引 helpers 版本 |
   | 编码规范 | ✅ 新生产文件英文 TSDoc 完整、无 console、审计走 `safeWriteAuditLog`、命名业务语义化、无尾空白 |

   ## Review 发现以下问题

   ### 问题 1
   - 问题: `src/core/fix-executor-completion.ts:118、:123` 将原实现的 `verifyCtx as Parameters<typeof autoAdvanceAfterVerify>[1]` 与 `emptySharedResult as Parameters<typeof autoAdvanceAfterVerify>[5]` 结构化类型断言**降级为 `as any` + eslint-disable**。违反 Phase 0 任务 1 明确要求（「改为显式 `VerifyAdvanceCtx` 兼容形状……不新导出无关符号」）与「编码规范遵从」节（「无 `any` 新增」）。`as any` 失去对 `autoAdvanceAfterVerify` 参数形状漂移的编译期守护，与本次治理「架构不变量固化」的主旨相悖
   - 等级：Medium
   - 符合规划：否
   - 是否修复：**已修复**（引入 `AutoAdvanceCtxParam = Parameters<typeof autoAdvanceAfterVerify>[1]` 与 `AutoAdvanceResultParam = Parameters<typeof autoAdvanceAfterVerify>[5]` 本地 type alias；`verifyCtx.pi` 用 `AutoAdvanceCtxParam["pi"]` 承接；调用点改用 `verifyCtx as AutoAdvanceCtxParam` 与 `emptySharedResult as AutoAdvanceResultParam`，并移除两处 `eslint-disable` 注释。`bun run typecheck` 零错误；产物 `dist/core/fix-executor-completion.js` 零 `as any`）
   - plan是否覆盖
     - 已覆盖：Phase 0 任务 1（显式类型承接指引）、编码规范遵从（无 any 新增）
     - 未覆盖：无
   - 改进建议：参考 Plan Phase 0 任务 1——恢复 `Parameters<typeof autoAdvanceAfterVerify>[n]` 断言或按计划用 verify-advance 已导出的 `VerifyAdvanceCtx` 兼容形状承接

   ### 问题 2
   - 问题: `src/__tests__/utils/subagent-rpc.test.ts` 缺计划「单元测试目标」明确列举的事件驱动 dispatch 用例：① handler 注册后 fix+completed 事件 → handler 收到 `(pi, config, {ui, session, runtimeCtx})` 入参形状断言；② review+completed / fix+failed → 不调用；③ **未注册（handler=null）→ 静默不抛错且 `clearActiveSpawn`/`cleanup` 正常执行**。现仅注册 API CRUD 三例。缓解项：A–F 经事件总线端到端覆盖 ② 的近似路径与 fix 主链路，但「DI 透传入参形状」与「未注册降级路径」两个面**无直接守护**——与 189_Bugt 第 1 轮问题 1（`extraArgs` 漏传因缺 round-trip 测试而漏检）同族风险
   - 等级：Medium
   - 符合规划：否
   - 是否修复：**已修复**（新增 4 个 dispatch 用例：① handler registered + fix+completed → 断言 spy handler 收到 `(pi, config, ctx)` 且 `ctx.{ui,session,runtimeCtx}` 与入参一致；② review+completed → spy 未调用（stage mismatch）；③ fix+failed → spy 未调用（event mismatch）；④ handler=null + fix+completed → 无异常抛出且 `clearActiveSpawn` 正常执行（断言 `activeSpawns.fix` 已被清空）。`afterEach` 统一 `setFixExecutorCompletedHandler(null)` 防止跨用例泄漏；全量 `bun test` 2612 pass / 0 fail（基线 2608 + 净新增 4））
   - plan是否覆盖
     - 已覆盖：Phase 0「单元测试目标」`subagent-rpc.test.ts（修改）` 条目逐条列举了上述三类
     - 未覆盖：无
   - 改进建议：参考 Plan Phase 0 单元测试目标——补 spy 型 dispatch 用例（注册 handler 断言收到 ctx 三字段；handler=null 时事件仍正常 clearActiveSpawn/cleanup）

   ### 问题 3
   - 问题: `fix-executor-completion.ts:105` `notify = ctx.ui?.notify ?? noop`——原实现 `ui` 为必传参（同源传两次），`ui` 缺失时会 TypeError → fail-open 写 `fix_unfreeze_error` 审计；现缺失时静默 noop 继续推进。计划目标为「行为逐字节不变」，此为边缘场景的语义偏移（新行为更优：无审计噪音、主流程不受 UI 缺失阻断，但脱离计划表述）
   - 等级：LOW
   - 符合规划：部分（签名合并是计划要求的，noop 兜底是计划未言明的增益）
   - 是否修复：无需修复
   - plan是否覆盖
     - 已覆盖：Phase 0 任务 1 签名合并 + 「函数内 `notify = ctx.ui?.notify ?? noop`」——**计划原文即如此规定**，实现与计划一致，与「逐字节不变」表述的张力属计划自身
     - 未覆盖：无
   - 改进建议：无需处理（知会即可）

   ### 问题 4
   - 问题: 计划「验收」节用例算式「约 7–8 例：直接调用式 3 / 注册点 3 / 静态守护 1 / 组合根 1」与「单元测试目标」节实际枚举（直接调用式 5 项 / 注册点 3 / 静态守护 1 / 组合根 1 = 10）自相矛盾；实现按枚举落地，净新增实测 10（2608=2598+10），多覆盖非缺覆盖
   - 等级：LOW
   - 符合规划：是（实现跟随计划详表；算式为计划方笔误）
   - 是否修复：无需修复
   - plan是否覆盖
     - 已覆盖：Phase 0 验收与单元测试目标两节（互相矛盾处以枚举清单为准）
     - 未覆盖：无
   - 改进建议：无需处理（知会规划会话后续修文即可）

   ## 结论
   - Blocker: 0 ｜ High: 0 ｜ **Medium: 2（均已修复 ✅）** ｜ LOW: 2（无需修复，知会）
   - 治理主体（解环 + DI + 拆分零损失 + 守护测试 + 产物级证据）全部达成且质量高；两个 Medium（类型回退 + 计划测试缺项）已在本轮修复中闭环：
     - 类型回退恢复 `Parameters<typeof autoAdvanceAfterVerify>[n]` 显式形状承接（含 `AutoAdvanceCtxParam["pi"]` 单字段承接），`dist/core/fix-executor-completion.js` 零 `as any`；
     - dispatch 用例补齐三类计划目标场景（含 handler=null 静默降级 + clearActiveSpawn 正常执行），全量 2612 pass / 0 fail（基线 2608 + 净新增 4）。
   - 按 SKILL 第 5 节：To-Fix 全部已闭环，无需进一步 code-review-withfix 介入。
