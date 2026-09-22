# Summary
- Plan file: `docs/design/187_Bug_plan.md`
- Commit file: `docs/design/187_Bug_plan_commit.md`
- Commits reviewed (verified against real `git show` diffs, independent of round-1):
  - Phase 0 `4424963` — remove shortcut registration block + `DEFAULT_DECISION_SHORTCUT` + template key
  - Phase 1 `68a9121` — remove `decisionShortcutKey` types/config parsing, rewrite hint to `/pipeline-resume`
  - Phase 2 `b76d4f4` — delete shortcut tests, update hint assertions, clean fixtures
  - Phase 3 `992a576` — stage-consistency guard in `consumePendingSpawns`
  - Phase 4 `87c4e3f` — `pendingSpawns: {}` cleanup at restart / buildStartMeta / buildResumeMeta
- Verification run (independently reproduced):
  - `bun run typecheck` → zero errors (`tsc --noEmit` + `tsc --noEmit -p tsconfig.test.json`)
  - `bun run test` → **2530 pass / 0 fail** (100 files), no regressions
- Scope compliance: all changed files fall inside the plan's file-change table, except
  `src/__tests__/core/review1-fixes.test.ts` (legitimately required by Phase 2 task 7) and a
  source line in `src/commands/pipeline-start.ts` (see Issue 3). Phase 0 additionally touched
  `src/core/flow-state.ts` + `src/core/json-config-loader.ts` (not in Phase 0's file list), but this
  was unavoidable to keep `bun run build` green after deleting the constant — the plan's Phase 0
  table was itself incomplete; not treated as a violation.
- Plan coverage: Phase 0, 1, 2, 4 tasks fully implemented. Phase 3 task is implemented but the
  prescribed guard condition was altered (see Issue 1). Shortcut cleanup is complete in code/tests
  but **incomplete in shipped template documentation** (see Issue 2).

## Review发现以下问题

### 问题 1
- 问题: `src/utils/subagent-rpc.ts:794-805` — Phase 3 的 stage 一致性 guard 与 Plan 规定的条件不一致，被额外条件削弱。Plan Phase 3 任务 1（及 `187_Bug.md` Q3 决策方案 B：「消费时 stage 必须匹配」）明确要求：
  `if (stage !== currentStage) { clearPendingSpawn(...); await safeWriteAuditLog("pending_spawn_discarded", ...); continue; }`
  实现却写成 `if (stage !== currentStage && entry.requestedAt < (fresh.stageStartTime ?? 0))`。后果：
  1. 当 `fresh.stageStartTime` 缺失时，`?? 0` 使 `requestedAt < 0` 恒为 false，guard **完全失效**（Plan 版本仍会清理）。
  2. 同一 pipeline 内的 stage 跳转 / 迟到 child 路由场景：pending entry 若在当前 stage 开始**之后**写入（`requestedAt >= stageStartTime`），跨 stage spawn **仍会发生** —— 这正是 `187_Bug.md` Q3 方案 C 的已知缺点（方案 B 正是为消除它而选），也是审计日志事件 1（clarify settle 时 spawn review/fix）的同类根因。Phase 4 只清理「跨 run 残留」，Phase 3 本应覆盖「同 run stage 跳转」，现被削弱为仅覆盖跨 run 场景。
  3. 测试用例 1 被改写为带 `requestedAt < stageStartTime` 前置条件，未覆盖 Plan 要求的「纯 stage mismatch（`stage !== currentStage`）」用例；`requestedAt >= stageStartTime` 的跨 stage 场景无任何测试，因此 Plan 的测试目标未被真正验证。
- 等级：High
- 符合规划：否
- 是否修复：已修复（commit `7536c2d`）
- plan是否覆盖
  - 已覆盖：Phase 3 任务 1（含给出的精确代码块）+ `187_Bug.md` Q3 决策方案 B
- 改进建议：参考 Plan Phase 3 任务 1，将 guard 条件还原为 `if (stage !== currentStage)`（保留 `clearPendingSpawn` + `pending_spawn_discarded`/`reason=stale_stage_mismatch` audit），并补充一条 `requestedAt >= stageStartTime` 的纯 stage-mismatch 测试用例以锁定 Plan 语义。

### 问题 2
- 问题: `src/template/guide.md:170, 1259, 1343, 1357-1368, 1431` — 随插件发布的模板文档仍完整记录已删除的快捷键功能：配置示例 `"decisionShortcutKey": "ctrl+enter"`（L170）、入口表「快捷键 | ctrl+enter（可配置）| index.ts shortcut」（L1343）、架构树「快捷键（ctrl+enter）」（L1431），以及整节 §13.3.2「快捷键护栏」（L1357-1368，含 `registerShortcut`、`ctrl+shift+u`、冲突告警说明）。`187_Bug.md` Goal 1 要求「把该功能删除，包括配置，测试，代码注释」，实现已清理源码/类型/模板 JSON/测试，但遗留用户可见文档；配置解析层现会 ignore 该键，照抄文档示例将得到静默无效配置，误导用户。
- 等级：Medium
- 符合规划：否（Goal 1 未端到端达成）
- 是否修复：已修复（commit `feab79e`）
- plan是否覆盖
  - 未覆盖：Plan「All Phase 文件变更汇总」未列出 `src/template/guide.md`（Plan 未覆盖，建议补充删除/改写该文件的对应章节）
- 改进建议：参考 Plan Phase 0 任务 3 / Goal 1，删除 `guide.md` 中 §13.3.2 整节及配置示例、入口表、架构树中的快捷键条目（可替换为 `/pipeline-resume` 说明）。

### 问题 3
- 问题: `src/commands/pipeline-start.ts:1008` — 该源码变更落在 `test(shortcut): phase 2` 提交 `b76d4f4` 中，与提交类型/Plan Phase 2 文件表（仅测试文件）不符。根因是 Plan Phase 1 任务 3 的 `formatDecisionMenuHint` call-site 清单遗漏了此处（`handleAbortedPipeline` 的 `awaiting_human` 分支），Phase 2 才补齐。功能正确，仅提交范围与 Plan 不一致。
- 等级：Low
- 符合规划：部分符合（功能属 Goal 1/2 收尾，但 Plan 未把该行列入 Phase 1 call-site 清单）
- 是否修复：无需修复（LOW）
- plan是否覆盖
  - 未覆盖：Plan Phase 1 任务 3 call-site 清单遗漏该行
- 改进建议：后续如需严格对齐，可在 Plan 的 call-site 清单中补齐该行，或将此类源码收尾归入对应 fix 提交。

### 问题 4
- 问题: `src/__tests__/index-registration.test.ts:5-7, 27, 40-42, 49` — 删除 shortcut 测试后遗留死代码：`import { mkdir, rm, readFile, writeFile } from "node:fs/promises"`、`import { join } from "node:path"`、`import { tmpdir } from "node:os"` 均已无任何使用（文件内 `.join(` 为 `Array.prototype.join`）；`registeredShortcuts` 数组与 `registerShortcut` mock 方法亦不再被引用。Plan Phase 2 任务 1 仅要求删除 shortcut 测试用例，未要求保留 mock 脚手架，但清理不彻底。
- 等级：Low
- 符合规划：符合（Plan 未要求删除 mock 辅助代码）
- 是否修复：无需修复（LOW）
- plan是否覆盖
  - 已覆盖：Phase 2 任务 1
- 改进建议：可一并移除上述未使用的 import 与 mock 辅助成员，保持测试文件整洁。

### 问题 5
- 问题: 风格类遗留（无行为影响）：
  - `src/index.ts:206-209` — 删除快捷键注册块后残留连续空行（3 个空行）。
  - `src/__tests__/core/phase1-owner-gate.test.ts:300` — 注释 `// ─── Test 7: Three texts contain configured key name ───` 已过时（现测试不再校验 configured key）。
  - `src/core/stage-advancer.ts:576` — 注释改写后语义略绕：「The previous text pointed at the `/pipeline-resume` command (formerly a decision shortcut)」与后文「The deterministic re-entry path is `/pipeline-resume`」重复指向同一路径，建议改写为「此前文案指向已删除的快捷键」。
- 等级：Low
- 符合规划：符合
- 是否修复：无需修复（LOW）
- plan是否覆盖
  - 已覆盖：Phase 0 任务 1 / Phase 1 任务 4
- 改进建议：清理多余空行并修正过时注释。

### 问题 6
- 问题: 与 Plan 的细微偏差（无功能风险）：
  - `src/commands/pipeline-start.ts:323` — `buildStartMeta` 由私有函数改为 `export`（Plan Phase 4 未要求变更可见性，仅为新增测试直接调用）。`buildResumeMeta` 早有类似导出先例，可接受。
  - `src/utils/subagent-rpc.ts:802` — audit 字段 `requestedAt: String(entry.requestedAt)` 与 Plan 示例中的 number 类型不一致（`entry.requestedAt`）。
- 等级：Low
- 符合规划：部分符合（偏离 Plan 示例但不影响功能）
- 是否修复：无需修复（LOW）
- plan是否覆盖
  - 已覆盖：Phase 4 任务 2 / Phase 3 任务 1
- 改进建议：如需严格对齐 Plan，可保留 number 类型；`buildStartMeta` 导出建议补充 TSDoc 说明其为测试可见性。

---

## 结论
- Phase 0 / 1 / 2 / 4：任务实现完整，验收（typecheck/build/test 全绿）通过。
- Phase 3：guard 已落地但条件被削弱（问题 1，High，To-Fix），未完全符合 Plan 规定；测试亦随之未覆盖 Plan 要求的纯 stage-mismatch 场景。
- 快捷键清理：源码/测试侧端到端完成，但模板文档 `guide.md` 仍描述已删除功能（问题 2，Medium，To-Fix）。
- 存在 **High ×1 + Medium ×1** 的 `待修复` 问题，需触发 `code-review-withfix-agent` 修复。
