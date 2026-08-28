---
name: plan
description: Solution Planning‑ Generate complete development planning documents based on requirement understanding and clarification results
userInvocable: false
---

## 流程边界
1. 禁止修改任何源代码文件
2. 仅做方案实现步骤规划

## 输入
- **需求理解结果**：必须是有明确的方案决策信息(需求目标、范围、方案选择)，不能有模糊的，未确定的方案新进入plan阶段
- **源文件**：`design`阶段读取的需求、澄清描述文件（如 `docs/design/{index}_{xxx}.md`）
  - 注意：`{index}`、`{xxx}` 是占位符，如：15_command_flow_skip.md

## 必须遵循规则
1. 设计-规划双向可追溯：规划阶段必须引用设计方案（点）。
2. 规划定稿前全量覆盖检查
3. 不能超越问题澄清、方案决策的范围

---
## workflow

### 1. 进入条件
- 在 `design` SKILL 确认 `full-und?` 后进入本阶段。

### 2. 输入采集
- 读取`docs/design/{index}_{xxx}.md` 理解结果（从需求描述文件中提取）。
- 确认用户指定的规划文件输出路径。

### 3. 生成规划文档
- 规划内容必须包含：
    - **Summary**：简明扼要描述要解决的问题。
    - **Phase {x}**：每个 Phase 包含目标、任务列表、验收标准。
    - **任务列表**：修改的文件范围、新增文件、新增接口/数据结构、重构方式、具体逻辑实现。
    - **验收标准**：每个 Phase 的构建与测试验证要求（以项目实际技术栈为准）。
    - **Commit 规范**：符合 Conventional Commits 规范，如：
      - feat(scope): new feature; fix(scope): bug fix; docs(scope): documentation changes; chore(scope): maintenance tasks; refactor(scope): code refactoring; test(scope): adding or updating tests
      - scope: scope is Core Modifications, e.g: fulfillment, kernel-picker, rfm
- 参考模板 `@.pi/references/plan_template.md` 生成完整规划。
- **规划文件路径**：用户指定的 `_plan.md` 输出路径
  - 举例：`docs/design/01_e2e_flow_v1_plan.md`

### 4. 输出要求
1. 言简意赅，突出重点、边界，避免冗余及与问题、方案不相关的内容。
2. **禁止输出**：开发耗时、工作量评估等。

### 5. plan review
1. 完成 plan 后**必须 review plan** 是否完全覆盖了方案、澄清的问题，如果存在遗漏则补充完整

### 6. not commit design and plan docs
1. 设计、规划文档 local 存储，不需要 commit

### 7. confirm 确认门（Phase 3 — 162）

插件在 verify 通过后提供第二道确认门，由 `stages.plan.confirm.mode` 配置控制：

- **auto 模式**：插件自动写双语标记（`## 用户确认：确认无误` + `## User Confirmation: Confirmed`），无 TUI 对话框，直接推进。
- **manual 模式**：verify 通过后弹出 TUI 英文确认对话框：
  - `Approve & Advance` → 写双语标记，推进到 develop
  - `Reject & Rework (back to clarify)` → 路由回 clarify 重新澄清
  - `Cancel` → 停留在 plan，等待后续操作
- **smart 模式**：Agent 自评复杂度：
  - 复杂：在规划文档写 `## 智能确认：复杂`，然后调用 `stage_advance({ needConfirm: true })` 触发确认门
  - 非复杂：直接调用 `stage_advance()` 自动推进（audit `confirm_smart_skip`）

**标记规则**：confirm 标记（`## 用户确认` 或 `## User Confirmation`）由插件自动写入，agent 无需手动添加。

---
## 交付项
- **必须** 规划文档
- **必须** 实现步骤
