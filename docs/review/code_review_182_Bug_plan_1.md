# Summary

- plan 文件：`docs/design/182_Bug_plan.md`
- 需求基线：`docs/design/182_Bug.md`（Round 1–4，9 条最终决议）
- commit 记录：`docs/design/182_Bug_plan_commit.md`
- dev commit：`7c83fbe`(P0) `611d96e`(P1) `db11201`(P2) `ea08d0f`(P3) `42f87c7`(P4) `c7dfc80`(P5) `d34689e`(P6) `1be05ea`(P7)
- 本次 review 范围：
  1. `git diff 7c83fbe~1..1be05ea` 全量（22 文件 / +1290 −38）逐项对照 plan Phase 0–7 的任务、验收与单测目标；
  2. 越界改动检查（是否修改了 plan 未列文件）；
  3. TS 编码规范（`@.opencode/references/code_spec.md`）合规性；
  4. 回归验证：`bun run typecheck` 通过、`bun test` 2416 pass / 0 fail（基线 1964 + 452 新增，满足「≥+25 用例」）；
  5. 关键路径实证：以脚本复现「注册留痕」链路，确认 Phase 2 缺陷（见问题 2）。
- 结论：**8 个 Phase 的「代码骨架」均已落地，但存在 3 处 Blocker 级「计划任务未实现/实现错位」、2 处 High 级证据闭环破口，Phase 4 与 Phase 2 的验收目标当前不成立**。构建与测试全绿，但部分新增测试为「吞断言」的无效用例，掩盖了 Phase 2 缺陷。
- 越界改动：未发现修改 plan 未列文件（`src/commands/pipeline-resume.ts`、`pipeline-start.ts`、`flow-state.ts`、`agent-settled.ts`、`session-starter.ts`、`stage-advancer.ts`、`tool-guard.ts`、`index.ts`、`command-args.ts`、`git-protect.ts`、`subagents-introspect.ts`、`guide.md` 均在 plan「All Phase 文件变更汇总」清单内；`package.json` 未动）。

---

## Review发现以下问题

### 问题 1

- 问题：`src/utils/subagent-rpc.ts:891-928` 代码实现不全，Phase 4 任务 3「同 stage 避让解锁 + nameProbe 次级证据 + 防自锁细则」完全未实现。`maybeDeferSpawnForLiveTwin` 仍为 `scanActiveSpawnEvidence(..., { excludeStage: stage })`（第 901-905 行）且 `if (!hit || hit.basis !== "probe_live") return false;`（第 908 行）——同 stage 同名 manual live agent 依旧不可见；无 `findLiveAgentByName` 兜底、无自身 reserved（`takeover-` / `dispatch:` 前缀）排除逻辑；`src/utils/spawn-evidence.ts` 模块头「cross-stage blind spot」注释段亦未按任务 3 补写。
- 等级：Blocker
- 符合规划：否
- 是否修复：已修复
- plan是否覆盖
  - 已覆盖：Phase 4 任务 3（含 commit 前缀 `feat(subagents-introspect,subagent-rpc,tool-guard)`）与 Phase 4 验收「事故场景回放（单测模拟）：09:58 manual review child live → auto dispatch 顺延而非双开」
  - 未覆盖：无（plan 已明确要求，属实现缺失）
- 影响：G4「twin 双开」根因只修了一半。`dispatchAfterResume` 路径由任务 4 的 name-probe 覆盖，但 `spawnStageSubagent` 的自动推进 spawn 路径（subagent-rpc.ts:510 调用点）仍存在同 stage 证据盲区——「插件 auto dispatch 对同 stage 同名 live 证据亦避让顺延」（R2-Q4 方案 A / G4 决议 6）未落地。
- 改进建议：参考 Plan Phase 4 任务 3 补全 `maybeDeferSpawnForLiveTwin` 三级证据链（跨 stage probe → 同 stage 账本 probe（排除本 dispatch 自身 reserved）→ `findLiveAgentByName`），并按任务 3 末尾补 `spawn-evidence.ts` 注释；同步补齐 plan 指定的 `subagent-rpc` G3 用例扩展。

### 问题 2

- 问题：`src/index.ts:137-156` 实现错位，Phase 2 任务 1 未按要求落点。`pipeline_shortcut_registered` 的 `safeWriteAuditLog` + `console.info` 被写进了 **`model_select` 事件处理器内部**（`src/index.ts:127` 起的 `(pi.on as any)("model_select", ...)`），而非 plan 指定的「shortcut 注册块（line 211-291）：`pi.registerShortcut` 调用后追加」。且新增的 `} else { ... registered: "false", reason: "api_unavailable" }` 实际成为 `if (meta && event?.model)` 的 else 分支（第 130 / 148 行），与 `typeof pi.registerShortcut === "function"` 判断无任何关系。
  - 实证：以脚本调用 `createPipeline(config)` + `await factory(pi)`（`registerShortcut` 为函数）后，审计文件**根本未被创建**，`pipeline_shortcut_registered` 零写入。
  - 次生缺陷：任何一次「无 meta 或无 event.model」的 `model_select` 事件都会写入 `registered: "false", reason: "api_unavailable"` —— 在 SDK 提供 `registerShortcut` 的情况下产生**假阴性**审计；同时 plan 要求的是布尔 `registered:false`，实现写成字符串 `"false"`。
- 等级：Blocker
- 符合规划：否
- 是否修复：已修复
- plan是否覆盖
  - 已覆盖：Phase 2 任务 1（「`pi.registerShortcut` 调用后追加 `safeWriteAuditLog("pipeline_shortcut_registered", ...)`；`console.info(...)`」）与 Phase 2 验收「审计日志出现 `pipeline_shortcut_registered` 事件」
  - 未覆盖：无（plan 已明确落点与时机，属实现错位）
- 影响：Phase 2 的目标「将『注册是否发生』变为可观测事实」未达成——该事件只在 `model_select` 触发时写入，而 `model_select` 在会话中可能永不发生（本次事故全天 0 命中即属此类）。事故复盘时无法用「注册留痕 vs `pipeline_shortcut_opened` 0 命中」自证 SDK 未派发按键，G2 的可观测性兜底失效。
- 改进建议：参考 Plan Phase 2 任务 1，把审计与 `console.info` 移入 `if (typeof pi.registerShortcut === "function")` 块内、`registerShortcut` 调用之后；`else` 分支改为该 if 的 else（`registered: false` 布尔值）；恢复 `model_select` 处理器为只写 `currentModel` 的原状。

### 问题 3

- 问题：Phase 3 任务 3 未实现。plan 要求「commit doc 命名规范落点：`src/constants.ts` develop/fix 交付物指引文案（`*_commit.md` 相关段）补一句英文命名约束：MUST derive from requirement doc basename (`{reqBase}_*_commit.md`), MUST NOT be derived from plan doc name」。实际 diff 中 `src/constants.ts`、`src/core/prompt-injector.ts`、`src/core/prompt-config.ts` **零改动**（`git diff --stat` 无该文件）；命名约束仅写进了 `src/template/guide.md`（模板资产，非注入提示词面）。
- 等级：Blocker
- 符合规划：否
- 是否修复：已修复
- plan是否覆盖
  - 已覆盖：Phase 3 任务 3（并见 Phase 3 commit 前缀 `docs(template,constants)`、plan「All Phase 文件变更汇总」中 `src/constants.ts` / `src/core/prompt-injector.ts` 或 `prompt-config.ts` 行）
  - 未覆盖：无（plan 已明确落点，属实现缺失）
- 影响：G3 规则 3（命名规范从 `meta.requirementDoc` 派生）在**模型实际可见的提示词面**未生效，仅存在于 guide.md 文档中；本次事故的直接诱因（`96_Feat_plan_commit.md` 由传入 plan doc 名拼接）在 prompt 层无约束，规则 3 实质未交付。
- 改进建议：参考 Plan Phase 3 任务 3，在 `src/constants.ts`（develop/fix 交付物指引段）或 `prompt-injector` / `prompt-config` 的对应文案处补英文命名约束句；同步补 `template-defaults.test.ts` 对该常量/提示句的存在性断言。

### 问题 4

- 问题：`src/index.ts:240-250` shortcut 路径的 `onStageChangedForShortcut` 使用**伪造 session 对象**（`{ session: { getMeta: () => freshMeta, updateMeta: () => freshMeta }, ui, pi, _ctx: undefined } as any`）。`dispatchAfterResume`（pipeline-start.ts:594-599）据此构造的 `session.updateMeta` 指向该 stub，而 `spawnStageSubagent` 正是通过 `opts.session.updateMeta(patch)` 写入 `activeSpawns[stage]` 账本（subagent-rpc.ts:547-552）——该写入被静默丢弃。同时 `getMeta()` 恒返回同一冻结快照，使 subagent-rpc 内部的 meta 重读（如 line 464 的 `freshMeta.activeSpawns?.[stage]` 幂等判定）永远读到旧值。
- 等级：High
- 符合规划：否
- 是否修复：已修复
- plan是否覆盖
  - 已覆盖：Phase 0 任务 2（「调用点接线（各自构造 `(m) => dispatchAfterResume(...)` 传入，全部复用 pipeline-start.ts:554 既有导出）」）+ 核心设计主线「建立『证据闭环』——manager 注册表 probe + activeSpawns 账本双证据源贯穿 spawn 避让 → advance 守卫 → dispatch 复用」
  - 未覆盖：无（plan 要求复用既有导出，实现改为伪造 session）
- 影响：shortcut 入口（本次事故的核心入口）经 `choose_stage` 派发的 agent **不进入 `activeSpawns` 账本** → tool-guard 3c 抑制、G3 顺延预检、Phase 5 advance liveness 守卫三条证据链全部看不到它，重新制造了 G4/G5 所要消灭的「证据盲区」，同名 twin 与 owner-settle 提前推进在该入口可复现。另 `as any` 强转亦偏离 plan「禁新增无注释 any」的合规声明。
- 改进建议：参考 Plan Phase 0 任务 2，改为在 shortcut handler 内部（`rctx` 作用域内）构造回调，直接传 `rctx`（`{ session: rctx.session, ui: rctx.ui, _ctx: (rctx as any)._ctx }`），复用真实 session 句柄，避免伪造对象。

### 问题 5

- 问题：Phase 0 目标「任何入口（shortcut / auto-popup / replay / command）执行 `choose_stage` 成功后，状态栏即时反映 + 自动派发」未覆盖两个真实入口：
  1. `src/core/flow-state.ts:1173-1238` `freezeAndPrompt`（熔断触发时的**自动弹出**入口）——其 opts 类型为 `{ ui?: FlowStateCtx["ui"] }`（第 1178 行），第 1234 行 `promptDecisionMenu(ctx, frozenMeta, config, opts)` 因此永不携带 `onStageChanged`；调用方（`violation-tracker.ts:63`、`loop-breaker.ts:298/372`、`loop-checker.ts:108`、`protect-ask.ts:91`、`verify-advance.ts:312/365`、`stage-advancer.ts:366/1465`、`pipeline-handoff.ts:146`）均未传。
  2. `src/core/flow-state.ts:1064-1094` `scheduleDecisionRetry` 的重弹菜单（`promptDecisionMenu(ctx, freshMeta, config)`，第 1094 行）——签名无 opts，无法透传；`agent-settled.ts:137-141` 的 interrupted→retry 链路因此丢失善后。
- 等级：High
- 符合规划：否
- 是否修复：已修复
- plan是否覆盖
  - 已覆盖：Phase 0 目标（「任何入口（shortcut / auto-popup / replay / command）」）；Phase 0 任务 2 列举了 shortcut / agent-settled re-popup / pipeline-resume / pipeline-start / session-starter replay 五处
  - 未覆盖：Plan 任务 2 未显式列出 `freezeAndPrompt` 与 `scheduleDecisionRetry` 两个入口，建议在 plan 中补齐
- 影响：熔断瞬间弹出的决策菜单中 `choose_stage` 成功后，状态栏仍显示旧 stage、不派发执行 agent —— 与用户 Goal 1 观察到的现象（「选完 develop 状态栏未更新、需手动 `@develop-agent`」）在该入口原样复现；仅在「settle 重弹」入口被修复，入口间行为不一致。
- 改进建议：参考 Phase 0 目标，为 `freezeAndPrompt` 的 opts 增加可选 `onStageChanged` 并透传至 `promptDecisionMenu`（各调用方按 Phase 0 任务 2 同法接线）；为 `scheduleDecisionRetry` 增加 opts 透传并在 `agent-settled` 重试链路注入同一回调；若判定超出本期范围，请在 plan 中显式声明范围外。

### 问题 6

- 问题：Phase 6 任务 3 未实现。plan 要求「`guide.md` 决策菜单节补『frozen-at-fix 无终态项』说明」，实际 `src/template/guide.md:1308-1317`「### 13.2 六项决策菜单」段落零改动，无任何 fix 阶段终态项被过滤的说明（全仓 grep 仅命中 §12.2 表格中 fix 行的另一处描述）。
- 等级：Medium
- 符合规划：否
- 是否修复：已修复
- plan是否覆盖
  - 已覆盖：Phase 6 任务 3
  - 未覆盖：无（plan 已明确要求，属实现缺失）
- 影响：文档与行为不一致（代码已在 `promptStageSelection` 过滤 `completed`），用户/模型据文档无法得知 frozen-at-fix 二级菜单不含终态项。
- 改进建议：参考 Plan Phase 6 任务 3，在 `guide.md` §13.2 补一句「frozen 在 fix 时二级菜单不含 completed（awaiting_human 原本不在列）」。

### 问题 7

- 问题：Phase 7 任务 1 部分未实现。plan 要求「`src/template/guide.md`：§14 命令与菜单契约（resume 菜单化、`--force-resume`）……」。实际 `--force-resume` 在 `guide.md` 中 **0 命中**；`§13.3 四入口 + 快捷键`（guide.md:1319-1327）仍为「四入口」，未把 `/pipeline-resume` 列为第 5 个菜单入口，也未说明 frozen 时 resume 弹出六项一级菜单 / 无 UI 时 fail-soft / `--force-resume` 逃生语义。
- 等级：Medium
- 符合规划：否
- 是否修复：已修复
- plan是否覆盖
  - 已覆盖：Phase 7 任务 1
  - 未覆盖：无（plan 已明确要求，属实现缺失）
- 影响：Phase 1 交付的交互契约（G1.2 / R2-Q2 决议）在用户文档面不可见；用户在快捷键失效场景（G2）下无法从文档得知 `/pipeline-resume` 已成为命令级兜底入口与 `--force-resume` 逃生开关。
- 改进建议：参考 Plan Phase 7 任务 1，在 guide.md 补齐 resume 菜单化契约与 `--force-resume` 说明，并更新入口表为「五入口」。

### 问题 8

- 问题：多处 plan 指定的单测目标缺失，且新增用例存在「吞断言」模式导致无效：
  1. Phase 6 任务 2 单测目标（`flow-state.test.ts` / `review3-fixes.test.ts`：frozen@fix 二级菜单项列表断言不含 `completed`，其它 stage 含 `completed`）——全仓无此断言（`flow-state.test.ts` 本次仅新增 onStageChanged 用例；`review3-fixes.test.ts` 在本仓库不存在）。
  2. Phase 4 单测目标：`tool-guard-suppress.test.ts` **未扩展**（无「账本空但 name-probe live → block + `spawn_suppressed basis=manual_live_probe`」用例）；`pipeline-start.test.ts` **未扩展**（无 `dispatchAfterResume` name-probe live → 0 spawn + notify 文案断言）。
  3. Phase 5 单测目标 ④（child settle → 守卫不生效）与 ⑤（双 settle 竞态 → advance 恰好一次）缺失；已实现的 ①-③ 均以 `try { expect(...) } catch { /* 可能未 flush */ }` 包裹（`agent-settled.test.ts:2358-2364/2395-2401/2429-2434`），断言失败时会被静默吞掉。
  4. Phase 2 单测目标「注册发生 → audit 写入 1 次」由 `index-registration.test.ts:452-461` 的 `try/catch → expect(true).toBe(true)` 兜底实现——该用例在 Phase 2 缺陷（审计零写入）下依然通过，属无效用例。
- 等级：Medium
- 符合规划：否
- 是否修复：已修复
- plan是否覆盖
  - 已覆盖：Phase 2 / Phase 4 / Phase 5 / Phase 6 各「单元测试目标，边界」小节
  - 未覆盖：无（plan 已逐条列出）
- 影响：plan 验收「手工路径推演（由单测断言替代）」失去替代效力；Phase 2 缺陷（问题 2）正是被吞断言的用例掩盖；Phase 4/5/6 的行为无回归护栏。
- 改进建议：参考各 Phase「单元测试目标，边界」补齐上述断言，并移除 `try/catch` 吞断言写法（审计文件读取失败应显式失败或用 `expect(...).resolves`/先确保 flush）。

### 问题 9

- 问题：`src/commands/pipeline-resume.ts:156-185` 的 `decided` 分支重复实现了 legacy dispatch 逻辑（与第 218-240 行几乎逐行重复），与 plan「按 freshMeta 判定是否还需 dispatch 兜底（**幂等**）」的实现意图不符：
  - 幂等性完全依赖 `probeAgentState(existingSpawn...)` 的 live 判定；若账本条目缺失或 probe 返回非 live，会对同一 stage 二次 `dispatchAfterResume`；
  - 该分支再次调用 `syncStageStatusBar(ui, ctx)`（第 164 行），而注释自述「status bar already synced by Phase 0 onStageChanged」，属冗余写入；
  - 非 choose_stage 决策（skip / rollback / restart）也走此分支，行为面与 plan 描述（choose_stage 善后）不完全对应。
- 等级：Medium
- 符合规划：否
- 是否修复：已修复
- plan是否覆盖
  - 已覆盖：Phase 1 任务 2（`decided → 状态栏已由 Phase 0 同步；按 freshMeta 判定是否还需 dispatch 兜底（幂等）→ return 决策结果文案`）
  - 未覆盖：无
- 影响：重复代码增加维护面；幂等保护依赖外部证据而非结构性保证，在账本写入失败（见问题 4）时可能造成重复 spawn。
- 改进建议：参考 Plan Phase 1 任务 2，抽取共享的「stage dispatch（含 probe-live 跳重）」helper 供 legacy 路径与该分支复用；去掉重复的 `syncStageStatusBar` 调用。

### 问题 10

- 问题：`src/utils/git-protect.ts:146-157` 的 gitignore 拒绝路径解析过于宽松：仅过滤「含 `the following`」与「含 `use -f`」的行，git 实际 stderr 中的 `hint: Turn this message off by running` 与 `hint: "git config advice.addIgnoredFile false"` 会一并进入 `isPathProtectedForGit` 判定；同时未剥离 git 对特殊字符路径添加的引号（`'path'`）。
- 等级：LOW
- 符合规划：是
- 是否修复：无需修复
- plan是否覆盖
  - 已覆盖：Phase 3 任务 1（「复跑被 gitignore 拒（stderr 含 `ignored`）→ ……若该 path 同时命中 `isPathProtectedForGit`」）
  - 未覆盖：无
- 影响：当前无观察到的误判（hint 行不会被 `isPathProtectedForGit` 命中），但解析健壮性不足；带引号路径可能漏判（漏拦）。
- 改进建议：参考 Plan Phase 3 任务 1 的判定语义，改为按 git 的稳定格式提取（跳过 `hint:` 前缀行、去除包裹引号）后再判定。

### 问题 11

- 问题：若干低风险实现细节与 plan 字面不完全一致：
  1. `src/utils/command-args.ts:91-93` 用 `rawArgs.includes("--force-resume")` 做子串匹配，forwardArgs 中恰好含该字面量（如引用的需求文本）会被误判为 force 并**从 forwardArgs 中删除**；不支持 `--force-resume=true` 之类变体。
  2. `src/index.ts:153` 写入 `registered: "false"`（字符串），plan Phase 2 任务 1/验收描述为布尔 `registered:false`。
  3. `src/utils/git-protect.ts:73` 正则 `/^-[a-zA-Z]*f[a-zA-Z]*$/` 会把任何以单横线开头且含 `f` 的 token 判为 force（如名为 `-foo` 的 pathspec），边界略宽。
- 等级：LOW
- 符合规划：是（主体行为符合 plan；上述为字面/边界差异）
- 是否修复：无需修复
- plan是否覆盖
  - 已覆盖：Phase 1 任务 1（flag 解析）、Phase 2 任务 1（审计字段）、Phase 3 任务 1（`hasGitAddForceFlag`）
  - 未覆盖：无
- 影响：无生产失败风险，属健壮性与字段类型一致性问题。
- 改进建议：参考 Plan 相应任务的字段/语义定义，改为按 token 精确匹配 flag、`registered` 使用布尔值；如需保留宽松匹配请补注释说明。

---

## 附：Phase 任务逐项核验表

| Phase | 任务 | 状态 | 备注 |
|-------|------|------|------|
| 0 | 1a/1b/1c `executeDecision` 善后 + DI 透传 | 完成 | `flow-state.ts:516-540`、`906-910`、`961/1009` |
| 0 | 2 调用点接线（5 处） | 部分 | index.ts 伪造 session（问题 4）；`freezeAndPrompt`/`scheduleDecisionRetry` 未覆盖（问题 5） |
| 0 | 3 `pipeline-resume` freshMeta notify | 完成 | `pipeline-resume.ts:212-213` |
| 1 | 1 `--force-resume` 解析 | 完成 | 边界见问题 11 |
| 1 | 2 frozen 分支菜单化 + fail-soft | 完成 | 幂等/重复代码见问题 9 |
| 1 | 3 文件头行为矩阵注释 | 完成 | `pipeline-resume.ts:1-19` |
| 2 | 1 注册留痕（audit + 日志） | **未达标** | 落在 `model_select` 处理器内（问题 2） |
| 2 | 2 flow-state/提示文案零改动 | 完成 | — |
| 3 | 1 `hasGitAddForceFlag` + `checkGitAdd` force 分支 | 完成 | 解析健壮性见问题 10 |
| 3 | 2 violation 计数零改动复用 | 完成 | — |
| 3 | 3 commit doc 命名落 `constants.ts`/prompt 层 | **未实现** | 问题 3 |
| 3 | 4 guide.md §git 保护 `-f` 语义 | 完成 | — |
| 4 | 1 `listRecords` + `findLiveAgentByName` | 完成 | `subagents-introspect.ts:64-97` |
| 4 | 2 tool-guard 3c 次级 name-probe | 完成 | `tool-guard.ts:709-725`（缺单测） |
| 4 | 3 subagent-rpc 同 stage 避让 + nameProbe | **未实现** | 问题 1 |
| 4 | 4 `dispatchAfterResume` name-probe | 完成 | `pipeline-start.ts:572-587`（缺单测） |
| 4 | 5 session-starter suspect 措辞 | 完成 | `session-starter.ts:233-235` |
| 5 | 1 agent-settled advance 守卫 | 完成 | `agent-settled.ts:257-294` |
| 5 | 2 verify-advance 零改动 + 事件登记 | 完成 | — |
| 6 | 1 stage-advancer fix 终态拒绝 | 完成 | `stage-advancer.ts:1261-1275` |
| 6 | 2 `promptStageSelection` 过滤 completed | 完成 | `flow-state.ts:828-839`（缺单测） |
| 6 | 3 guide.md 决策菜单节说明 | **未实现** | 问题 6 |
| 7 | 1 guide.md 契约/事件/保护/命名对账 | 部分 | `--force-resume`、resume 菜单化缺失（问题 7） |
| 7 | 2–4 template-drift + 全量回归 + G6 | 完成 | typecheck 通过；`bun test` 2416 pass / 0 fail |

## 附：TS 编码规范（code_spec.md）检查

- 类型安全：`findLiveAgentByName` 返回 `{agentId:string}|null` 显式（合规）；`onStageChanged?: (freshMeta: SessionMeta) => Promise<void>` 显式标注（合规）。
- **不合规项**：`src/index.ts:244` 新增 `as any` 伪造 session（plan「编码规则合规声明」自述「禁新增无注释 any」，该处仅 `eslint-disable` 无理由注释）；`src/core/session-starter.ts:466` 新增 `(ctx as any).pi`；`src/core/agent-settled.ts:123` 使用 `Parameters<typeof dispatchAfterResume>[0]` 强转。以上均属对内部 `any` ctx 的既有模式延续，风险低，但建议统一改为显式类型或补注释。
- 回归兼容：`executeDecision` opts 仅新增可选字段（合规）；`checkGitAdd` 无 `-f` 输入路径逐字节未变（合规，`git-protect.ts:165-167` 仅变量重命名）。
- 日志/审计：新增事件均走 `safeWriteAuditLog` / `writeAuditLog`（合规）；无新增依赖、无敏感值。

## 附：回归与产物

- `bun run typecheck`：通过（`tsc --noEmit` + `tsc --noEmit -p tsconfig.test.json`）。
- `bun test`：2416 pass / 0 fail / 6303 expect（95 文件），满足 plan「基线 1964 + 新增 ≥25」。
- 无越界文件改动；`package.json` 未修改。
