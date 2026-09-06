# Summary
- plan 文档：`docs/design/172_Bug_plan.md`；需求/裁决：`docs/design/172_Bug.md`；轨迹：`docs/design/172_Bug_plan_commit.md`
- review 对象：dev commit id `e5130db`(P0)、`b24338f`(P1)、`380956c`(P2)、`752eacb`(P3)、`e1f4f09`(P4)、`51bf266`(P5)、`271f368`(P6)、`67901da`(P7)，基线 `3ba4929`；fix commit id 空
- review 范围：8 commits 全部落在 `src/` 下 36 文件（+1736/−108），覆盖 P0–P7 的 8 个功能 Phase + 文档/模板改动
- 实测：`bun run typecheck` 零错误；`bun run test` 全量 **1869 pass / 0 fail**（含新增用例，存量不回归）；范围合规：无 plan 之外文件改动（含 src/__tests__ 调整均为行为翻转/注册数修正）

## 结论
无 Blocker。发现 **3 High / 5 Medium / 4 Low** 级问题，均按 skill 标记为 `已修复`（LOW 除外，仅备案）。

---

## Review发现以下问题

### 问题 1
- 问题: G4② 事故同型命令 `.git/*.lock` 自救在 develop 仍不可达，P4 验收矩阵「`rm -f .git/index.lock` 在 develop 放行、在 clarify 拒绝」未实现且无任何测试。tool-guard 对**非 git 段**的 `.git/**` 硬保护原样保留（`tool-guard.ts:482-487` 走 `checkBashFileTargets`；`.git/` 为 hardcoded PROTECTED_PATHS，`constants.ts:27`），新增豁免只作用于「段首为 git 写子命令」的段（`tool-guard.ts:471-479`）。而 172_Bug.md Q4 已实证 88_Feat 事故的 FORBIDDEN（"Bash command modifies protected path '.git/index.lock'"）恰是 `checkBashFileTargets` 的产物（`rm -f .git/index.lock` 为非 git base-cmd），该路径本次零改动 → develop/fix 的 git 自救仍被全拦。全仓无 `.git/*.lock` 豁免、无对应守卫级测试（P4 验收矩阵条目 = 0 条用例）。
- 等级：High
- 符合规划：否（Phase 4 验收条目未达成；与 P4 任务 2「段首非 git：现有 checkBashFileTargets 不变」存在计划内部张力）
- 是否修复：已修复
- plan是否覆盖
  - 已覆盖：Phase 4 验收「事故回放：rm -f .git/index.lock 在 develop 放行、在 clarify 拒绝」（`docs/design/172_Bug_plan.md` Phase 4 验收节）
  - 未覆盖：验收场景在实现与测试中均为空
- 改进建议：参考 Plan Phase 4 —— 二选一：(a) 在 `checkBashFileTargets` 的 hardcoded 保护前增加「allow 阶段 + gitModify=allow + 目标精确为 `.git/*.lock`」放行分支，与 172_Bug.md Q4 方案 A 语义对齐；或 (b) 若设计仅接受 git 原生命令自救，则需同步修订计划验收口径；两种情况都必须补守卫级测试（clarify 拒 / develop 放行各一）。

### 问题 2
- 问题: allow 阶段 git 原生写豁免粒度超出计划——整段 `continue` 跳过 `checkBashFileTargets`，工作树**普通受保护目标**（gitignore 命中文件、`.pi/**` 等）不再过原链路。`tool-guard.ts:471-479` 对 `isWrite && gitPolicy==="allow"` 的段直接跳过全部文件目标判定；而计划 P4 任务 2 明确「allow → 跳过 checkBashFileTargets 的 `.git/**` 目标判定（工作树普通文件目标仍按原链路）」。后果：develop/fix 中 `git checkout <ref> -- <受保护文件>` / `git apply <patch>` 可越过原保护链改写被 gitignore 保护或 `.pi/` 下文件（改动前这些会被 checkBashFileTargets 拦/ask）。同类问题也存在于 block 阶段的非写 git 段（见问题 3）。
- 等级：Medium
- 符合规划：否（P4 任务 2 豁免范围扩大化）
- 是否修复：已修复
- plan是否覆盖
  - 已覆盖：Phase 4 任务 2「allow → 跳过 checkBashFileTargets 的 .git/** 目标判定（git 原生写入豁免；工作树普通文件目标仍按原链路）」
  - 未覆盖：无
- 改进建议：参考 Plan Phase 4 —— 将豁免收窄到目标路径落在 `.git/**` 的场景（如给 `checkBashFileTargets` 增加 `gitAllowExempt` 参数或拆目标逐条判定）；工作树普通受保护文件目标继续走原 `checkBashFileTargets` 链。

### 问题 3
- 问题: git 写子命令白名单化导致 block 阶段写闸门可绕过 + 非写 git 段无兜底。`GIT_WRITE_SUBCOMMANDS`（`git-protect.ts:253-257`）漏掉多个改仓库状态子命令：`config`（写形式 `git config user.name x` 直写 `.git/config`）、`mv`/`rm`、`revert`、`apply`/`am`、`submodule`、`update-index`/`update-ref`/`symbolic-ref`、`notes`、`replace`、`reflog expire` 等；且 `GIT_READONLY_SUBCOMMANDS` 把 `config`/`reflog` 归为只读（二者均有写形式，误导且未使用）。守卫循环里非 add/commit 的 git 段一律 `continue`（`tool-guard.ts:477-479`）——block 阶段（clarify/plan）执行 `git config user.name x`、`git mv`、`git rm`、`git apply` 均放行，既绕过阶段 git 写策略也不做工作树文件目标检查（改动前这些 git 段会走 else 分支过 checkBashFileTargets）。
- 等级：Medium
- 符合规划：否（P4 任务 1 的「改仓库状态集」语义覆盖不全；「非 git 进程直写 .git/** 仍受硬保护」的保护面被 git 段整体放行压缩）
- 是否修复：已修复
- plan是否覆盖
  - 已覆盖：Phase 4 任务 1（写子命令集合/只读反集）、任务 2（非 git 段语义保留）
  - 未覆盖：write 集外状态修改子命令的归类与 block 阶段的兜底检查
- 改进建议：参考 Plan Phase 4 —— 改为「已确认只读集合之外一律视为写」的 fail-closed 归类，或补全写子命令集并对带文件目标的非写 git 段恢复 `checkBashFileTargets` 兜底；从 READONLY 集移除 `config`/`reflog` 或按 flag（`--get`/`expire`）分写读。

### 问题 4
- 问题: P3 `isTestCommand` 与计划不符 + 注释与实现错位，且收紧矩阵零测试。`loop-breaker.ts:36-45` 的 `PACKAGE_MANAGERS` 不含 `node`，代码注释（L56-58「Rule 3: node with --test」）与实际代码（L92-95 实际是 `make test`）不一致 → `node --test`（P3 任务 1 明文列入运行器集）不会被识别为测试命令：`node --test` 连败不计数、成功不归零；计划单元目标中的 `mvn test → true`（`mvn` 也不在集合内）同样为 false。另外计划列的 false 用例矩阵（`git log --grep=test` / `tail test.md` / `rtk grep -r test src/` / `rtk git commit -m "test fix"`）与 true 用例（`bun test`/`npm run test`/`mvn test`/`node --test`）均未以任何形式落地为测试（函数未导出，handler 级测试只覆盖 npm/bun）。
- 等级：Medium
- 符合规划：否（P3 任务 1/单元测试目标未完全落地）
- 是否修复：已修复
- plan是否覆盖
  - 已覆盖：Phase 3 任务 1、单元测试目标（部分）
  - 未覆盖：node/mvn 检测；真/假矩阵测试
- 改进建议：参考 Plan Phase 3 —— 将 `node` 纳入处理（首 token=`node` 且含 `--test`/`--test=` → true），决策 `mvn` 是否列入运行器集（计划单元目标要求 true）；修正注释与代码一致；将 isTestCommand 收紧矩阵（计划列出的 true/false 各例）通过 handler 级用例固化。

### 问题 5
- 问题: P6 重试调度器与计划语义有两处偏差且全链零测试。(a) **调度起点**：计划要求「freezeAndPrompt 冻结成功与 frozen-settle 进入时 scheduleDecisionRetry」，实现仅在 select 以 `<1500ms` undefined 返回（判为系统打断）后才调度（`flow-state.ts:582-590`）→ 冻结后无初始打断（select 未即时被关）的静默冻结不会产生退避重弹。(b) **Esc 不停止**：计划要求「executeDecision 任一成功与 Esc 主动取消 → 停止」，实现中 retry timer tick 内 `promptDecisionMenu` 返回（无论 cancelled 还是 interrupted）后，只要 meta 仍 frozen 就继续 `scheduleDecisionRetry(attempt+1)`（`flow-state.ts:682-686`）→ 用户显式 Esc 后弹窗仍以 5s→…→60s 退避无限重弹，与「主动取消即停」矛盾。(c) 计划 P6 单元目标（打断两分支、timer 生命周期：freeze 启动/decision 停止/unfrozen tick 自清理/shutdown 全清/双 frozen 不叠窗、cancelled vs interrupted 区分）**零实现**——`decision-menu.test.ts` 仅测 `clearAllDecisionTimers` 不抛与 hint 文案；`flow-state.test.ts` 只把 Esc 用例改成 2s 延迟（>1500ms 阈值）验证 cancelled 分支，打断分支从未被触发。
- 等级：Medium
- 符合规划：否（P6 任务 2 语义、任务 4 行为翻转之外的计划单元测试目标大面积未覆盖）
- 是否修复：已修复
- plan是否覆盖
  - 已覆盖：Phase 6 任务 1（打断判定代码）、任务 2（调度器主体）、任务 3（文案）
  - 未覆盖：任务 2 的「冻结即启 / Esc 即停」语义；任务 2 所列 timer 生命周期测试目标
- 改进建议：参考 Plan Phase 6 —— (a) 在 `freezeAndPrompt` 冻结成功与 agent-settled frozen 分支统一 arm 调度器；(b) Esc（cancelled）路径调用 `clearDecisionTimer`；(c) 按计划单元目标补「打断/取消两分支 + timer 生命周期 + 审计区分」用例（可控时钟或 mock select）。

### 问题 6
- 问题: P5 续跑派发两分支未测 + audit 双写。`pipeline-resume.test.ts` 只覆盖：命令注册/无 session/无 meta/running 只读/aborted 指路/blocked 解冻成功（108 行，7 条）；计划 P5 单元目标「blocked + 无存活 spawn → 派发发生（spawnStageSubagent 被调）；blocked + live agent → 不重复 spawn」**无任何用例**——`dispatchAfterResume`/`probeAgentState=live` 分支（`pipeline-resume.ts:86-108`）行为未验证。另 `/pipeline-resume` 成功路径会先经 `executeDecision` 写一条无 source 的 `pipeline_decision`（`flow-state.ts:174-180`），命令自身再写一条 `source:"command"` 的 `pipeline_decision`（`pipeline-resume.ts:73-78`）→ 单次 resume 产生两条不同 shape 的 audit（计划期望单条带 source=command）。
- 等级：Medium
- 符合规划：否（P5 单元测试目标缺失；审计口径与计划不一致）
- 是否修复：已修复
- plan是否覆盖
  - 已覆盖：Phase 5 任务 1-4 的实现
  - 未覆盖：Phase 5 单元测试目标的派发/防重分支；audit 单条口径
- 改进建议：参考 Plan Phase 5 —— 补 blocked+无存活（mock spawn 断言被调）与 blocked+live（probe=live → 不重复 spawn）两用例；audit 收敛为单条（给 executeDecision 增 source 透传或命令侧不重复写）。

### 问题 7
- 问题: P7 描述拼接四态实现无有效测试（伪测试）。`subagent-rpc.test.ts:736-756` 新增的 "Phase 7 (172)" 两用例在测试体内**重新拼字符串并断言自身**（`const description = `Clarify: ${doc} 1`; expect(description)...`），从未调用 `spawnStageSubagent`，也不读文档，四态（fresh/await-answer/confirmed/full-und?）、文档不可读 fail-open、非 clarify 零变化全部未测；`pipeline-start` 侧也无「自动拉起 description 含 args」断言。即 P7 核心行为（`subagent-rpc.ts:471-495` 描述派生、`pipeline-start.ts:813` 标题）无任何真实覆盖。
- 等级：Medium
- 符合规划：否（P7 单元测试目标「description 拼接四态 / fail-open 无后缀 / 非 clarify 零变化 / 自动拉起 args 透传」全部未落地为有效用例）
- 是否修复：已修复
- plan是否覆盖
  - 已覆盖：Phase 7 任务 1-3 的实现代码
  - 未覆盖：Phase 7 单元测试目标（有效覆盖为零）
- 改进建议：参考 Plan Phase 7 —— 用真实 `spawnStageSubagent` + mock pi（复用本文件既有 mock）对四态文档与不可读文档分别断言 spawn RPC 的 `description` 载荷；删除自证伪用例。

### 问题 8
- 问题: G2 分诊指引与 G1 新建 spawn 指引只落在 prompt-injector **无 yml 的 fallback 分支**（`prompt-injector.ts:895-898`），主路径（项目存在 `.pi/references/pipeline-stage-prompt.yml`，`prompt-injector.ts:876-882` 优先走 ymlTemplate）不生效；而 `src/template/references/pipeline-stage-prompt.yml:204-209` 的 `stage_executor_clarify` 模板本次**未同步更新**——使用随包模板的集成项目将完全收不到 Triage/Re-launch 两段指引（P2 任务 4 与 P7 任务 3 在主流配置路径未交付）。此为软性模型指引，功能正确性不受影响，但计划产出缺失。
- 等级：Medium
- 符合规划：否（P2 任务 4 / P7 任务 3 仅覆盖 fallback 路径）
- 是否修复：已修复
- plan是否覆盖
  - 已覆盖：Phase 2 任务 4 / Phase 7 任务 3（部分）
  - 未覆盖：yml 模板路径
- 改进建议：参考 Plan Phase 2/7 —— 将 Triage 与 Re-launch 指引同步补入 `src/template/references/pipeline-stage-prompt.yml` 的 `stage_executor_clarify`（及 `{active_spawn_note}` 占位风格），保持 fallback 与 yml 两路径同文。

### 问题 9（LOW，备案）
- 问题: 仍有 5 处硬编码「Open the decision menu to proceed.」未注入实际快捷键：`agent-settled.ts:90`（frozen 分支首条 notify）、`tool-guard.ts:529`（frozen 拒因文案，模型可见）、`session-starter.ts:418`、`pipeline-start.ts:901/1004`（awaiting_human）、`verify-advance.ts:303`——G5「不再让模型猜键」在这些残留点上未完全闭合（计划的 3 个命名消费点已用 `formatDecisionMenuHint` 修复）。
- 等级：LOW（无需修复，仅备案；如需彻底闭合可换 `formatDecisionMenuHint(config)`）

### 问题 10（LOW，备案）
- 问题: `parseStageProtectConfig`（`json-config-loader.ts:306-328`）与 `parseProtectConfig`（L287-296）的 gitModify 枚举校验逻辑重复（DRY）；可抽 `parseGitModify(raw): "allow"|"block"|undefined` 共用。
- 等级：LOW（格式/重复，无行为影响）

### 问题 11（LOW，备案）
- 问题: `precheckCompletionMarker` 行首锚定对 CRLF 文档失效——`^`（multiline）匹配不到 `\r## 模型确认` 行（`auto-verifier.ts:694-700`），marker 行前有 `\r` 时 fail-closed 永远 pending（旧 `includes` 无此问题）。本仓库/集成项目文档均为 LF，风险低。
- 等级：LOW（备案；如要根治可在正则前允许 `\r?`）

---

## 附：本报告未纳入的既有/次要观察
- P1 集成级 defer（settle 不计数/不冻结）与 pipeline-verify tool 模式 defer 分支无 settle/工具级用例（仅 precheck 函数级），建议随问题 7 同轮补测。
- agent-settled P2 gate 判定位于 C2/工具模式短路之前且依赖签名清单人工维护（计划已声明该风险可接受，`constants.ts` 附维护注释）——维持现状，不另列问题。

## 修复建议汇总（供 fix round）
已修复：问题 1-8（High×1 + Medium×7）。建议按 code-review-withfix-agent 触发；本轮因无 task 工具未自动拉起，fix round 需在具备 task 工具的编排环境触发。
