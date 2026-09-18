# Summary
   - Plan 文件路径：`docs/design/183_Bug_plan.md`
   - 设计文档：`docs/design/183_Bug.md`（方案 D 定稿，决策 #1-#9）
   - 复验提交：`3e05469`（Phase 0）、`2d87ac3`（Phase 1）、`0e770e2`（Phase 2）
   - 复验范围：3 个 commit 的完整 diff（4 个文件：`src/core/prompt-injector.ts`、`src/__tests__/core/prompt-injector-skills-dedup.test.ts`、`src/__tests__/core/prompt-injector.test.ts`、`src/template/guide.md`）
   - 范围合规：变更文件与 Plan「All Phase 文件变更汇总」逐项一致，未发现无关文件改动（无 High 越界）
   - 验证结果：`bun run build` 通过；`bun run typecheck` 通过；`bun test` 2452/2452 全绿（96 文件，零回归）
   - 独立结论：核心去重路径（2 块一致 → 删首留末 + 条件切除 cwd + 审计事件）实现正确且被测试覆盖；但 Plan 明确定义的 `malformed` 异常信号实际不可达，且一处 Plan 指定测试未真正触发失败路径。develop 自检报告（`code_review_183_Bug_plan_1.md`，仅 1 LOW）遗漏以下 2 项 Medium 问题。

   ## Review发现以下问题
   ### 问题 1
   - 问题: `src/core/prompt-injector.ts:1059-1081, 1165-1168` — `malformed` 分支不可达，且畸形块会中止扫描并抑制有效去重。`extractSkillPairs` 在「区间内缺 `<available_skills>` 开标签」时执行 `if (!hasOpen) return pairs;`（L1074）早退，caller 因 `pairs.length < 2` 走 no-op 且**不置 `skippedReason`**；而 `allPairsHaveOpenTag`（L1084-1096）因 `extractSkillPairs` 只 push 已通过开标签校验的对而恒返回 `true`，故 `skippedReason: "malformed"` 仅 `catch` 可达（实际不可达）。实测验证：`header+闭标签无开标签` 的畸形块 + 2 个一致有效块 → `removedPairs=0, skippedReason=undefined`，本应触发的去重被早退抑制。
   - 等级：Medium
   - 符合规划：否
    - 是否修复：已修复
    - plan是否覆盖
      - 已覆盖：Phase 0 任务 2（"区间内必须含 `<available_skills>` 开标签行，否则 `malformed`"）；Phase 1 任务 2（"`skippedReason` 置位 → warn 事件 `prompt_skills_dedup_skipped`"）；【设计】#2（"结构异常 → 原样返回，仅记 warn 审计"）
    - 改进建议：参考 Plan Phase 0 任务 2 修正提取逻辑——遇到缺开标签的结构异常时应置位 `malformed`（如让 `extractSkillPairs` 返回 `{ pairs, malformed }` 或在 caller 显式判定），使 `skippedReason: "malformed"` 与 `prompt_skills_dedup_skipped` warn 事件真正可达；同时避免畸形块 early-return 阻断其后续有效对的提取与去重。

    ### 问题 2
    - 问题: `src/__tests__/core/prompt-injector.test.ts:1711-1733` — "审计写失败" 用例未真正触发失败路径，Plan 要求的 mock 抛错覆盖缺失。该用例刻意不调用 `initAuditLog`，但 `writeAuditLog` 在 `auditDirPath` 未初始化时静默 `return`（`src/utils/auditLog.ts:92-93`），`safeWriteAuditLog` 自身再包 try/catch（L135-139），**全链路不会抛错**。因此 handler 内 `try/catch` fail-open 分支从未被执行，测试名为 "audit write failure does not block injection" 但实际未制造任何写失败。
    - 等级：Medium
    - 符合规划：否
    - 是否修复：已修复
    - plan是否覆盖
      - 已覆盖：Phase 1 单元测试目标/边界（"审计写失败（mock 抛错）→ 注入不受阻断"）
    - 改进建议：参考 Plan Phase 1 测试节，用 mock/spy 令 `safeWriteAuditLog`（或底层 `writeAuditLog`）真实抛错，断言注入仍返回且 `systemPrompt` 正确（并保留 1 块去重结果）。

    ### 问题 3
   - 问题: `src/core/prompt-injector.ts:1083-1096` — `allPairsHaveOpenTag` 为冗余死代码。`extractSkillPairs` 已在每对提取时校验开标签存在性，故其恒返回 `true`，不构成任何行为。
   - 等级：LOW
   - 符合规划：是（防御性实现，无功能影响）
   - 是否修复：无需修复
   - plan是否覆盖
     - 已覆盖：Phase 0 任务 2
   - 改进建议：可在后续清理中移除该函数及 `skillsDedup` 中的调用（L1166-1168）；若保留为防御层，建议加注释说明其与问题 1 的关系（否则读者会误以为 malformed 由它兜底）。

   ### 问题 4
   - 问题: `src/core/prompt-injector.ts:1207` — `removedBytes: prompt.length - result.length` 统计的是 UTF-16 码元数，而非字节数；Plan 类型注释与审计字段名均为「净减少字节数 / `removed_bytes`」。当 skill 描述含非 ASCII 字符（如中文）时会低估实际字节数。
   - 等级：Medium
   - 符合规划：否（语义偏差，仅影响审计元数据，无功能影响）
    - 是否修复：已修复
    - plan是否覆盖
      - 已覆盖：Phase 0 任务 1（`removedBytes: number; // 净减少字节数`）
    - 改进建议：如需真实字节数改用 `Buffer.byteLength(...)` 差值；否则建议在注释/文档中明确该字段实为字符数，避免误读。

    ### 问题 5
    - 问题: `src/template/guide.md:723-726` — 新增的 `prompt_skills_dedup` / `prompt_skills_dedup_skipped` 两行被插入 "当 `config.audit.promptSnapshot` 为 `full`（默认）时" 的快照事件表内，且紧随其后的 "每个事件均携带 `prompt_hash` 字段" 对新事件不成立（dedup 事件用 `hash_before`/`hash_after`，无 `prompt_hash`）。文档语义会误导读者以为 dedup 事件受 `promptSnapshot` 开关控制并携带 `prompt_hash`。
    - 等级：Medium
    - 符合规划：否（文档准确性瑕疵；事件名与代码逐字一致，Phase 2 验收项本身满足）
    - 是否修复：已修复
    - plan是否覆盖
      - 已覆盖：Phase 2 任务 1（在 L713-715 区域新增两行）
    - 改进建议：将两行 dedup 事件移出 promptSnapshot 条件表（或修正前言/尾句限定），并移除对 dedup 事件携带 `prompt_hash` 的隐含表述。

    ### 问题 6
    - 问题: `src/core/prompt-injector.ts:1209-1211` — `skillsDedup` 的 `catch` 未记录错误对象/上下文，直接返回 `{ ...noop, skippedReason: "malformed" }`，且 Phase 1 调用侧仅以 warn 级 `prompt_skills_dedup_skipped` 落审计，丢失错误堆栈与输入信息。与 `code_spec §3`（catch 必记 error 级上下文）存在偏差；Plan 将该日志职责委派给调用侧，但调用侧同样未携带 error 级细节。
    - 等级：Medium
    - 符合规划：部分（Plan Phase 0 任务 2 明确"纯函数不直接写日志，由 Phase 1 调用侧落审计"，但未要求 error 级上下文）
    - 是否修复：已修复
   - plan是否覆盖
     - 已覆盖：Phase 0 任务 2
   - 改进建议：可在 `SkillsDedupResult` 增加可选 `error` 字段，由调用侧以 error 级审计记录，以满足 `code_spec §3` 鲁棒性要求。
