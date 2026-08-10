---
name: plan
description: 方案规划 - 基于需求理解与澄清结果，生成完整的开发规划文档
userInvocable: false
---

## 职责边界
1. 禁止修改 任何源代码(*.ts,*.tsx)文件（当前为规划阶段，代码实现由 develop-agent 负责）
2. 仅做方案实现步骤规划

## 输入
- **需求理解结果**：来自 `design` SKILL 的澄清确认信息（需求目标、范围、方案选择）
- **源文件**：`design` 阶段读取的需求描述文件（如 `docs/design/{index}_{xxx}.md`）
  - 注意：`{index}`,`{xxx}`是占位符，实际文件名如：15_command_flow_skip.md
- **规划文件路径**：用户指定的 `_plan.md` 输出路径
  - 举例：`docs/design/01_e2e_flow_v1_plan.md`

---
## workflow

### 1. 进入条件
- 由 `feat-design-plan-agent` Subagent 在 `design` SKILL 确认 `full-und?` 后**自动触发**。
- **无需用户手动输入** `/plan` 命令。

### 2. 输入采集
- 读取 `design` 阶段`docs/design/{index}_{xxx}.md`理解结果（从需求描述文件中提取）。
- 确认用户指定的规划文件输出路径。

### 3. 生成规划文档
- 规划内容必须包含：
    - **Summary**：简明扼要描述要解决的问题。
    - **Phase {x}**：每个 Phase 包含目标、任务列表、验收标准。
    - **任务列表**：修改的文件范围、新增文件、新增接口/数据结构、重构方式、具体逻辑实现。
    - **验收标准**：每个 Phase 的 `./mvnw clean compile` + `./mvnw clean test` 验证要求。
    - **Commit 规范**：符合 Conventional Commits 规范。
      - feat(scope): new feature;fix(scope): bug fix;docs(scope): documentation changes;chore(scope): maintenance tasks;refactor(scope): code refactoring;test(scope): adding or updating tests
      - scope: scope is Core Modifications，e.g: fulfillment,kernel-picker,rfm
- 参考模板 `@.opencode/references/plan_template.md` 生成完整规划。 
- 输出到`docs/design/{index}_{xxx}_plan.md`。

### 4. 必须遵循规则
1. 设计-规划双向可追溯：规划阶段必须引用设计方案(点)。
2. 规划定稿前全量覆盖检查
3. 无原代码对照不新增机制

### 5. 输出要求
1. 言简意赅，突出重点、边界，避免冗余及与问题、方案不相关的内容。
2. **禁止输出**：开发耗时、工作量评估等。

### 6. plan review
1. 完成plan后**必须 review plan**是否完全覆盖了方案，澄清的问题,如果存在遗漏则补充完整

### 7. not commit design and plan docs
1. 设计，规划文档local存储，不需要commit

### 8. 规划文档完成后，必须
1. **必须调用 `compact` 工具**来压缩本次会话的上下文，执行如下命令：
    - `/compact save design plan context`

### 9. 用户 Review
- 等待用户 Review 规划文档。
- 用户可提出反馈，根据反馈调整规划并重新输出。
- 用户确认后，本阶段结束。

### 10. 阶段衔接
- 规划确认完成后，提示用户：
   > "规划已完成，请使用 `@develop-agent <plan文件路径>` 开始编码实现。"
- 将产出物（`_plan.md`）移交开发阶段。
