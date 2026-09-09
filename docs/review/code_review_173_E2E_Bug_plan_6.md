# Summary
- Plan 文件：`docs/design/173_E2E_Bug_plan.md`（C1-C17，P0-P6）；需求 `docs/design/173_E2E_Bug.md`；跟踪文件 `docs/design/173_E2E_Bug_plan_commit.md`
- 审查范围：第 6 轮（fix-loop 关账后独立终验），复核对象 = 前序 fix 全链 `d679ef9..HEAD`（dev 9 枚 + fix 5 枚 + 收口 docs `ebd5a80`）与 round-5「收敛关账」声明本身。不采信历轮汇总，全部以 git 对象、worktree 独立检出、mutation 回滚实验与源码阅读为证据。
- 实测复核：HEAD `ebd5a80` `bun run typecheck` 0 错、`bun run build` 0 错、`bun test` **2011 pass / 0 fail / 5146 expect / 82 files**。计数链逐格独立检出实测：5d4d54b=1901、73da6ad=1933、2a724fe=1933、ae6cf4d=1948、5f1d4c8=1964、31f6391=1964、a541d76=1991、0881206=2008、28eb93f/HEAD=2011 —— 与跟踪表逐行吻合（唯一 flaky：subagent-rpc "returns ok:false on timeout" 满载 5s 超时，单跑 31/0 全绿，属 3.4 备案项）。
- 范围合规：`d679ef9..HEAD` 变更面仅 `src/`、`docs/`、`AGENTS.md`；package.json / bun.lock / .opencode / dist/ 零改动；无新依赖；`origin/main..HEAD` = 4 未 push；工作树干净。
- 独立结论：round 5 宣称修复的 **D2 正向断言（Case 4b）与 C10① blocked 命令层接线（Case 4c）真实有效**（mutation 回滚产品代码必红），compact 断言强度、注释 5→6、簿记修正亦全部落地；但发现 **2 项此前历轮均未捕获的 Medium 级残留**（见问题 1/2），round-5 报告"问题 2 awaiting_human 分支已覆盖"的声明经 mutation 证伪；C6 工具面 no-meta guard 测试矩阵存在未交付格。

## Review发现以下问题

### 问题 1
- 问题：round 5 声称 Case 4d "awaiting_human + ui.select → 命令层接线已覆盖（pipeline-start.ts:1020-1037）"，但该测试**并未真实驱动 awaiting_human 专属分支**：
  1. 夹具（`src/__tests__/core/pipeline-start.test.ts:861-901`）同时设 `currentStage:"awaiting_human"`（:866）与 `flowState:"blocked"`（:868）。产品代码 `pipeline-start.ts:983-1037` 的判定顺序为 `flowState==="running"`（:983）→ `flowState==="blocked"`（:994）→ `flowState==="aborted"`（:1014）→ `currentStage==="awaiting_human"`（:1020）。夹具命中 :994 **blocked** 分支后即 return，`selectCalls=1` 由 blocked 分支的 promptDecisionMenu 产生 —— 与 Case 4c 是同一代码路径。
  2. **Mutation 实证**（worktree 检出 HEAD 后注入）：把 :1020-1037 awaiting_human 专属分支整体回滚为纯文字拒绝 → Case 4d **依然全绿**（4 pass / 0 fail）；把 :994-1011 blocked 分支回滚为纯文字拒绝 → Case 4c **与** Case 4d **双双变红**。即 Case 4d 的保护对象是 blocked 分支，不是它名义上的 awaiting_human 分支。
  3. 附带语义缺陷：真实 awaiting_human 会话若以 `flowState` 未设/`running` 形态存在（stage 推进到 awaiting_human 但未 freeze），execute 会命中 :983 running-reject（scratch 实测：返回 `Pipeline "p-aw3" already running at stage "awaiting_human" (running)`、selectCalls=0），**弹不出菜单**；只有 `flowState:"blocked"` 形态（dormancy.test:71 同款）才经 blocked 分支获得菜单。:1020-1037 专属分支在当前 FlowState 三值（running/blocked/aborted）类型域内是否可达存疑（前三分支均先 return），存在死代码或分支顺序缺陷两种可能，需产品侧裁定。
- 等级：Medium
- 符合规划：否（round-5 问题 2 的修复声明与实际覆盖不符；plan Phase 3 §3.3-① 的 awaiting_human 命令层接线缺真实用例）
- 是否修复：**已修复**（commit 927740c）
  - **产品侧裁定**：基于代码事实追踪，awaiting_human 可以 flowState="running" 形态存在（stage-advancer 转换到 awaiting_human 时不设置 flowState，pipeline-quit.test:123-134 测试用例证实 awaiting_human + flowState="running" 为合法形态）。因此 :1020-1037 专属分支**应可达**，原分支顺序为缺陷（option ①）。
  - **修复方案**：重排分支顺序为 aborted → awaiting_human → running → blocked。aborted 优先（因其有特殊处理逻辑 handleAbortedWithMode），awaiting_human 在 running/blocked 之前检查（确保 flowState="running" + currentStage="awaiting_human" 能命中 awaiting_human 分支而非 running-reject）。
  - **测试补齐**：Case 4d 改用 flowState="running" + currentStage="awaiting_human"（真实驱动专属分支，断言 selectCalls=1）；新增 Case 4d-alt 用 flowState="blocked" + currentStage="awaiting_human"（保留原覆盖，验证两形态均提示菜单）。
- plan是否覆盖
  - 已覆盖：`173_E2E_Bug_plan.md` Phase 3 §3.3-①（blocked/awaiting_human → owner 就地 promptDecisionMenu）
  - 未覆盖：无（属测试断言/夹具设计与分支可达性问题）
- 改进建议：按 plan Phase 3：①要么将 awaiting_human 判定前置到 blocked 分支之前并补一个 `flowState:"running"`（或 flowState 未设）+ `currentStage:"awaiting_human"` 的命令层用例，使其真实走 :1020-1037 并断言 select 恰 1 次；②要么向产品侧确认 awaiting_human 会话恒以 `flowState:"blocked"` 持久化（此时 :1020-1037 为不可达冗余代码，应删除或加注释），并在报告中修正 round-5"两分支均覆盖"的不实表述。当前实现下真实 awaiting_human（flowState=running）经 /pipeline-start 无法获得菜单，需一并给出产品裁定。

### 问题 2
- 问题：C6（Phase 2a）"无 meta ctx 逐一调用 7 工具 + 5 钩子 + shortcut"守卫矩阵**只部分交付**：`dormancy.test.ts:112-188` 仅覆盖 2 个工具（pipeline-state :151、loop-checker :158）+ 5 钩子（prompt-injector/tool-guard/agent-settled/loop-breaker/session-shutdown）+ meta 未写断言；stage-advancer 的 dormant 引导另在 stage-advancer.test.ts:68 与 phase1-audit-events.test.ts:110 覆盖（completed→dormant）。但 `generate-summary`（src/tools/generate-summary.ts:144-147）、`validate-summary`（:58-61）、`pipeline-handoff`（:62-65）、`pipeline-verify`（:87-90）四处的 no-meta/dormant 引导分支（`!rawMeta || isDormant(rawMeta) => { message: "No active pipeline..." }`）**全库无任何直接测试驱动**（grep `No active pipeline` 仅命中 dormancy / phase1-audit / stage-advancer / pipeline-quit / pipeline-resume；四个工具各自 test 文件均以 active meta 调用，无 `getMeta:()=>undefined`、无 aborted/completed 夹具）。plan Phase 2a 测试点"无 meta ctx 逐一调用 7 工具 + 5 钩子 + shortcut：零异常、引导语/静默、meta 未被写、violations 未增（≥5 参数化）"对该 4 工具格未达，历轮 round 1-5 均未直接复核该面，属残留测试欠交。
- 等级：Medium
- 符合规划：否（plan Phase 2a 测试点清单 7 工具逐一调用项未完全交付）
- 是否修复：**已修复**（commit 927740c）
  - 在 `dormancy.test.ts` 的 C6 no-meta defensive guards describe 块中为 4 工具各补 1 例：
    - generate-summary: `getMeta:()=>undefined` → execute → message 含 "No active pipeline"
    - validate-summary: 同上
    - pipeline-handoff: 同上
    - pipeline-verify: 同上
  - 纯测试补齐，零产品代码改动，符合收敛轮最小干预原则
- plan是否覆盖
  - 已覆盖：`173_E2E_Bug_plan.md` Phase 2a 测试点（无 meta ctx 逐一调用 7 工具 + 5 钩子 + shortcut）
  - 未覆盖：无
- 改进建议：按 plan Phase 2a：在 `dormancy.test.ts`（或四工具各自 test 文件）为 generate-summary / validate-summary / pipeline-handoff / pipeline-verify 各补 1 例 `ctx.session.getMeta:()=>undefined`（及可选的 completed/aborted dormant 形态）→ `tool.execute(...)` → 断言返回 `message` 含 "No active pipeline" 且未写 meta、未抛异常。纯测试补齐，零产品代码改动，符合收敛轮最小干预原则。

## 复核通过项（第 5 轮修复 + 收口增量，逐项 mutation 实证）

| 项目 | 证据 | 结论 |
|---|---|---|
| 问题 1（D2 自证假阳性清除 + 正向断言） | review4-④c 夹具 pipelineId 改中性 `pipe-old-001`、断言改 `not inherited`+`Choose stage`（review4-fixes.test.ts:474-499）；Case 4b completed+有效 file → success + superseded message（pipeline-start.test.ts:790-816）。**Mutation：回滚 pipeline-start.ts:977-978 D2 放行 → Case 4b 必红** | 已修复且必红 |
| 问题 2（C10① blocked 命令层接线） | Case 4c/4d blocked+ui.select → select 恰 1 次 + success（pipeline-start.test.ts:818-901）。**Mutation：回滚 :994-1011 → 4c/4d 全红** | blocked 分支已修复且必红（awaiting_human 专属分支问题见问题 1） |
| 问题 3（簿记：9aff103/fda6c20 游离 id 修正） | 跟踪文件 dev/fix id 行 = 链上真实 commit（全部 `git merge-base --is-ancestor` 验证）；游离对象 0adbcde/9aff103/fda6c20 均不再被引用；ebd5a80 未自登记属预期（docs 收口自身无需自指） | 已修复 |
| 问题 4（DORMANT_KEEP_PROTECTION 豁免） | 豁免登记完备（跟踪文件 Exemption Registry 单行：rationale + decision）；常量无运行时注入面、默认 false、需源码+rebuild 才启用；review4 有存在性钉（:368-403）+ tool-guard 消费分支实现存在（tool-guard.ts:379-392） | 豁免理由成立、登记完备 |
| 问题 5（compact 断言强度） | review4-⑤b mock isIdle/compact/getContextUsage 后断言 `meta.terminalCompact` 置位（review4-fixes.test.ts:538-574）。**Mutation：删除 choose_stage→completed 的 maybeCompactOnPipelineCompleted 调用（flow-state.ts:490-494）→ ⑤b 必红** | 已修复且必红 |
| 问题 6（注释 5→6） | flow-state.ts:119-125 buildDecisionMenu 注释已为 "blocked / awaiting_human → 6 items (.../choose_stage)"（28eb93f 落地） | 已修复 |
| 计数表 Fix-r2 "0 rewrites/1964"、Fix-r5 "+3/2011" | 31f6391 独立检出 = 1964/0/80 files（build 后）；HEAD = 2011/0/5146/82；P5 5f1d4c8=1964（净增量归属正确） | 账实一致 |
| Exemption/注释/范围 | 工作树干净、ahead 4、protected assets 零 diff、无新依赖 | 符合纪律 |

## 总体结论

- **是否有 Blocker/High**：否。
- **是否有待修复 Medium**：否（2 项均已于 commit 927740c 修复）。
  - 问题 1（awaiting_human 专属分支可达性）：已修复。产品侧裁定 awaiting_human 可 flowState="running" 形态存在（stage-advancer 不设置 flowState，pipeline-quit.test 证实），原分支顺序为缺陷。修复：重排分支顺序 aborted → awaiting_human → running → blocked，补 Case 4d（flowState="running"）+ Case 4d-alt（flowState="blocked"）真实驱动专属分支。
  - 问题 2（C6 四工具 no-meta guard 测试欠交）：已修复。dormancy.test.ts 为 generate-summary / validate-summary / pipeline-handoff / pipeline-verify 各补 1 例 no-meta guard 测试，Phase 2a 测试点 7 工具格全部交付。
- **关账裁定**：**成立**。Round 6 发现的 2 项 Medium 均已修复，测试计数 2011 → 2016（+5），typecheck/build 0 错，范围合规（无新依赖、protected assets 零 diff）。fix-loop 收敛完成，无残留待修复项。
- **计数验证**：HEAD `927740c` `bun run typecheck` 0 错、`bun run build` 0 错、`bun test` **2016 pass / 0 fail / 5153 expect / 82 files**。
- 前置就绪（Phase 6 E2E 复验）：插件仓库侧 build/typecheck/test 全绿基线就绪（2016/0/5153/82）；P6 业务侧 C12 手工修正单与 E2E 六场景仍为 `⏳ Pending`，需用户在业务项目执行（含 🔴-1 签认），与本仓库代码侧关账解耦。

