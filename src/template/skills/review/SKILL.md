---
name: review
description: Code‑Review Expert‑Review the implementation against the plan
userInvocable: false
---

## workflow
1. **解析输入**：从上级 Agent 传递的任务描述中，提取文件路径 `code-review-agent {file}_commit.md`
2. 查看 `{file}_commit.md` 如果缺失 `plan doc` 中断 review 并输出"缺失plan文档请补充"，如果缺失 `commit id` 则获取 git 最近的 10 条 commit log
3. 查看 `{file}_commit.md` 文档引用
   - `plan doc`，阅读理解 plan
   - `commit id`，根据 dev commit id 或 fix commit id 完成 review
4. 按以下步骤完成 review

### 1. 作用域合规
- 检查 `{file}_commit.md` 的 dev/fix commit id 改动内容是否涉及与 plan 规划无关的文件被意外修改？若存在则标记等级 `High`
- 注意：如果不在 commit 内容的变动是历史增量修改，review 时请忽略
- 新增文件是否是plan文档明确指定？如果非plan则标记`Medium`

### 2. 类型与空值安全
<!-- Template-TODO: 替换为项目审查规范 -->
- 以下规则为通用模板，具体以项目 `.pi/references/{stack}_code_spec.md` 为准（`{stack}` 见 develop SKILL 占位）
- **禁止裸类型（raw type）**：泛型类必须指定类型参数。
- **可空类型正确处理**：返回可能为空的值时，必须对空值做显式处理（如提前返回、默认值、断言），禁止未检查直接使用。
- **公共方法参数非空检查**：核心 public 方法入口应对关键参数做 `null`/空值检查。

### 3. 回归与副作用检测
- **方法签名兼容**：修改后的 public/protected 方法签名必须与所有调用方兼容。
<!-- Template-TODO: 替换为项目特有的回归检测规则（如 ORM 实体变更、定时任务调度影响等） -->

### 4. 代码质量
- **函数过长**：单个方法超过 100 行且无强耦合理由，标记 `Medium`。
- **命名不规范**：变量/方法命名中性化、无明确业务含义，标记 `Low`。
- **鲁棒性**：
  - 核心逻辑无边界检查（空集合、null 值、空字符串）。
  - `catch` 块必须记录 `error` 级别日志并包含明确的输入参数和异常堆栈，禁止空 `catch` 块吞掉异常。
  - 批量处理中单条失败不得中断整个批次。
- **代码重复**：违反 DRY 原则。
<!-- Template-TODO: 替换为项目特有的代码质量规则（如外部调用规范等） -->

### 5. 日志规范
<!-- Template-TODO: 替换为项目审查规范 -->
- **框架统一**：使用项目约定的日志框架，禁止直接使用标准输出流。
- **日志级别**：
  - 方法入口/出口与核心业务流程 → `info`
  - 中间过程数据 → `debug`
  - 异常 → `error`
- **日志内容**：关键日志必须包含上下文信息，异常日志必须包含错误堆栈。

### 6. 配置安全
- 禁止在代码中硬编码密钥、密码、Token 等敏感信息。
<!-- Template-TODO: 替换为项目特有的配置安全规则 -->

### 7. 输出格式
### 问题/等级/改进建议
1. 问题等级定义
   - **Blocker**:
     - 遗漏 plan 定义的 phase
     - 内存泄漏、OOM
   - **High**：
     - 未完全遵循 plan 文档定义的 Task
   - **Medium**:
     - 逻辑覆盖plan不完整
     - 实现边界不清晰，代码复杂，不易维护
     - 部分场景可能影响功能
   - **LOW**
     - 非功能问题 
     - 仅格式、命名、风格、可读性问题
2. **Blocker**,**High**,**Medium** 的问题标记为 `待修复`，**LOW** 的问题不需要修复

### Review 结果输出目录 `docs/review`
1. 文件命名格式：`code_review_{file}.md`
   - 多轮复验更新同一文件，仅保留最终结论（复验历史由 git 追溯）
   - 多轮复验多新问题则追加到review文档中
2. 报告格式参考 `@.pi/references/review_report_template.md`

### 8. not commit review doc
1. 所有 review 相关文档，模板 local 存储不需要 commit
