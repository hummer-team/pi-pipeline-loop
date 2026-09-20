# Summary
   - `docs/design/184_Bug_plan.md`（需求：`docs/design/184_Bug.md`，决策 D1–D10）
   - 评审范围：dev commits `0f336df`(P0) / `be3f768`(P1) / `a07e01a`(P2) / `0e8dc8e`(P3) / `ddfe02b`(P4) 的全部变更（源码 + 模板/文档 + 新增测试），对照 Plan 五 Phase 任务、验收与编码规约（`.opencode/references/code_spec.md`）。
   - 复核结论：`bun run typecheck` 零错误；`bun test` 2512 pass / 0 fail（100 files）——与交付摘要一致。
   - 结论：核心 bootstrap 回退（P2）、piWorkDir 主链路（P0/P1 主体）、domainDir 三态链（P3）、模板/文档（P4）均已落地；但 D7「auditDir 收口」与 P0/P3 预留工具函数存在**计划任务未执行**（见问题 1–3），另有 1 处 `.pi` 硬编码消费方未联动（问题 4）。
   - 范围合规：未发现与 Plan 无关的越界改动；`src/commands/pipeline-status.ts`（P1 变更）虽未列入 Plan「文件变更汇总」表，但属 PROTECTED_PATHS/drift 合法消费方，判定为计划表遗漏而非越界；`git-protect.ts` 列于 Plan 表却未改动（经核实其保护判定经 `resolveProtectConfig` 间接消费，无需直改，属计划表笔误）。

   ## Review发现以下问题
   ### 问题 1
   - 问题: `src/utils/work-dir.ts:36-38` 新增的 `resolveAuditDir(config)` 在全部生产代码中**零消费**（仅被 `work-dir.test.ts` 引用）；D7 要求收口的 7 处散落兜底全部保持原样：`src/utils/auditLog.ts:58`、`src/utils/session-registry.ts:39`、`src/core/session-state.ts:83`、`src/core/loop-breaker.ts:266`、`src/core/session-starter.ts:170`、`src/tools/generate-summary.ts:150`、`src/commands/pipeline-start.ts:1175`（另 `src/core/template-residue-check.ts:65` 常量同源）。未执行「收口为单一解析函数」。
   - 等级：High
   - 符合规划：否
   - 是否修复：已修复
   - plan是否覆盖
     - 已覆盖：Plan Phase 0 任务 3（"resolveAuditDir → config.auditDir ?? `${resolvePiWorkDir(config)}/audit`"）+ D7（"7 处散落 `auditDir || ".pi/audit"` 收口为单一解析函数"）；`docs/design/184_Bug.md:192,252`
   - 改进建议：参考 Plan Phase 0 任务 3 + D7，将上述 7 处兜底替换为 `resolveAuditDir(config)`（`session-state.ts` 为 options 形态需对应适配）；若判定不落地，需回改 Plan 删除该死函数与 D7 承诺。

   ### 问题 2
   - 问题: `src/utils/work-dir.ts:70-80` 的 `resolveDomainSkillCandidates(config, domainId)` 在生产代码中**零消费**（仅 `work-dir.test.ts` 引用）。Plan Phase 0 任务 3 明确其"Phase 3 消费"，但 P3 在 `prompt-injector.ts:buildDomainSkill` 内**另行内联实现**三态链，未调用该函数；且函数实现与真实逻辑不一致（未做 `expandHomePath`、home 候选硬编码 `~/.pi/domains` 字面量）。形成死代码 + 双份真相。
   - 等级：Medium
   - 符合规划：否
   - 是否修复：已修复
   - plan是否覆盖
     - 已覆盖：Plan Phase 0 任务 3（"resolveDomainSkillCandidates ... Phase 3 消费；此处仅定义，见 Phase 3 实现"）；Plan Phase 3 任务 2（要求基于该链实现）
   - 改进建议：参考 Plan Phase 0 任务 3，令 P3 的 `buildDomainSkill` 复用 `resolveDomainSkillCandidates` + `expandHomePath`（单一真相），或删除该死函数并同步修订 Plan。

   ### 问题 3
   - 问题: `src/constants.ts:20` 新增的 `PI_PREFIX = `${CONFIG_DIR_NAME}/`` 在全部生产代码中**零引用**（`grep PI_PREFIX` 仅命中定义处）。`rewritePiPrefix`（`json-config-loader.ts`）仍写死 `` `${CONFIG_DIR_NAME}/` ``，`buildProtectedPaths`（`protect.ts`）亦写死 `` `${piWorkDir}/` ``，未达成 Plan 所述"重写与保护集共用字面量源"的 DRY 收口。
   - 等级：Medium
   - 符合规划：否
   - 是否修复：已修复
   - plan是否覆盖
     - 已覆盖：Plan Phase 0 任务 4（"`PI_PREFIX`（重写与保护集共用字面量源）"）
   - 改进建议：参考 Plan Phase 0 任务 4，在 `rewritePiPrefix` / `buildProtectedPaths` 改用 `PI_PREFIX`，或删除该常量避免死代码。

   ### 问题 4
   - 问题: `src/core/template-residue-check.ts:83-124` 的 `resolveScanTargets` 仍硬编码 `CONFIG_DIR_NAME`（`.pi`），扫描 `.pi/skills/*/SKILL.md` 与 `.pi/agents/*.md`；调用点 `pipeline-start.ts:98,167`、`pipeline-init.ts:734` 仅传 `projectRoot`，未传 `resolvePiWorkDir(config)`。当 `piWorkDir != ".pi"` 时，资产实际部署在 `{piWorkDir}/skills|agents`，扫描集为空 → `clean: true`，**Template-TODO 残留门禁被静默旁路**。与 Plan Phase 1 目标"所有生产代码中除锚点外的 `.pi` 硬编码改由 `resolvePiWorkDir(config)` 驱动"不符。
   - 等级：Medium
   - 符合规划：否
   - 是否修复：已修复
   - plan是否覆盖
     - 已覆盖：Plan Phase 1 目标（"所有生产代码中除锚点外的 `.pi` 硬编码改由 `resolvePiWorkDir(config)` 驱动"）；`184_Bug.md:259` 范围含"piWorkDir 全链路配置化"
     - 未覆盖：Plan Phase 1 任务 1–7 未枚举 `template-residue-check.ts`（`184_Bug.md` 影响面表 #11–15 亦未列入）
   - 改进建议：参考 Plan Phase 1 目标，为 `checkTemplateResidues/computeResidueFingerprint` 增加 `piWorkDir`（或 `baseDir`）参数并由调用方传 `resolvePiWorkDir(config)`；同时将该文件补入 Plan「文件变更汇总」表，或重新评估 piWorkDir 影响面清单。

   ### 问题 5
   - 问题: `src/core/json-config-loader.ts:266-276` `parsePiWorkDir` 以手写启发式替代 `path.isAbsolute`，注释称 "path.isAbsolute is not available without import"，但同文件 `json-config-loader.ts:7` 已 `import * as path from "node:path"`，注释与事实不符；Plan Phase 0 任务 2 明确要求 `!path.isAbsolute` 判定。
   - 等级：LOW
   - 符合规划：否
   - 是否修复：无需修复（建议修正注释/改用 path.isAbsolute）
   - plan是否覆盖
     - 已覆盖：Plan Phase 0 任务 2（取值约束 "`!path.isAbsolute`"）
   - 改进建议：参考 Plan Phase 0 任务 2，改用 `path.isAbsolute(raw)`（保留 Windows 形态可用 `path.win32.isAbsolute` 补充），并修正失实注释。

   ### 问题 6
   - 问题: `src/core/prompt-injector.ts:24` 仍 `import { PROTECTED_PATHS, ... }`，但该文件自本 Phase 起已改用 `buildProtectedPaths(config)`（L327），`PROTECTED_PATHS` 在文件内无任何引用（未使用导入）。
   - 等级：LOW
   - 符合规划：否
   - 是否修复：无需修复
   - plan是否覆盖
     - 已覆盖：Plan Phase 1 任务 3（保护集统一由 `buildProtectedPaths` 产出）
   - 改进建议：参考 Plan Phase 1 任务 3，移除未使用的 `PROTECTED_PATHS` 导入。

   ### 问题 7
   - 问题: `extraSkip` 计算逻辑在 `src/core/prompt-injector.ts:333-336` 与 `src/core/tool-guard.ts:361-364` 完全重复（`piWorkDir !== ".pi" ? new Set([piWorkDir.split("/").pop()!]) : undefined`），违反 DRY（code_spec §3/§6）。
   - 等级：LOW
   - 符合规划：否
   - 是否修复：无需修复
   - plan是否覆盖
     - 未覆盖：Plan 未指定该重复逻辑的收口位置（建议补入 Plan Phase 1 任务 4 的收口函数）
   - 改进建议：参考 Plan Phase 1 任务 4，在 `work-dir.ts` 增加 `resolveGitignoreSkipDirs(config)` 供两处共用。

   ### 问题 8
   - 问题: `src/index.ts:427-429` fallback 分支的 `if (!config.projectRoot) config.projectRoot = process.cwd();` 为死分支——`resolvePipelineConfig`（`json-config-loader.ts:679`）恒有 `json.projectRoot || process.cwd()`，`config.projectRoot` 永不为空。注释"Mark projectRoot as cwd"与实现不符。
   - 等级：LOW
   - 符合规划：否
   - 是否修复：无需修复
   - plan是否覆盖
     - 未覆盖：Plan Phase 2 任务 2 未要求该分支
   - 改进建议：删除该死分支（或改为显式 `config.projectRoot = process.cwd()` 以表达 fallback 语义）。

   ### 问题 9
   - 问题: `parsePiWorkDir` 接受尾斜杠形态（如 `"piwork/"`）：`rewritePiPrefix` 会产生 `"piwork//agents/x.md"` 双斜杠；`extraSkip = new Set([piWorkDir.split("/").pop()!])` 的 basename 退化为 `""`，gitignore 跳过失效。属边界鲁棒性不足（`config/pi` 多段形态按 Plan 取末段正确）。
   - 等级：LOW
   - 符合规划：否
   - 是否修复：无需修复
   - plan是否覆盖
     - 未覆盖：Plan 未规定尾斜杠归一化
   - 改进建议：在 `parsePiWorkDir` 归一化去除首尾 `/`（`raw.replace(/^\/+|\/+$/g, "")`）。

   ### 问题 10
   - 问题: `src/core/prompt-injector.ts:132-139` 项目级候选读取的 `catch {}` 空块无日志，与 Plan 编码规约"catch 块记 error 级日志含上下文"及 code_spec §3 不一致（home 候选 L148-152 同样为空 catch）。
   - 等级：LOW
   - 符合规划：否
   - 是否修复：无需修复
   - plan是否覆盖
     - 已覆盖：Plan 编码规约（第 15 行）
   - 改进建议：因属"预期缺失"语义，可保留 fail-open，但建议以 `debug` 级日志记录候选路径与错误信息，或显式注释豁免理由。

   ### 问题 11
   - 问题: `src/commands/pipeline-init.ts:63` 注释称 `pipeline_loop.json` "lives at project root (anchor)"，与 D4/同文件 L225、L254 的"锚点恒为 `.pi/pipeline_loop.json`"自相矛盾（陈旧注释）；另 `displayPath` 对 `pipeline_loop.json` 固定展示 `.pi/pipeline_loop.json`，而 L286-306 根目录便捷副本实际落在 `projectRoot/pipeline_loop.json`，展示与落点不完全对应。
   - 等级：LOW
   - 符合规划：否
   - 是否修复：无需修复
   - plan是否覆盖
     - 已覆盖：Plan Phase 1 任务 1（锚点特例 D4 + 根副本逻辑保持原样）
   - 改进建议：修正 L63 注释为"anchor lives at .pi/pipeline_loop.json"；根副本如需可见，可单独计入展示列表。
