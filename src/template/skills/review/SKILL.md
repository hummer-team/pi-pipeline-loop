---
name: review
description: Code‑Review Expert‑Review the implementation against the plan
userInvocable: false
---

## workflow
1. **解析输入**：从上级 Agent 传递的任务描述中，提取文件路径 `code-review-agent {file}_commit.md`
   - 举例：`code-review-agent docs/design/04_feat_fn_ecom_fulfillment_efficiency_plan_commit.md` 则文件为 `04_feat_fn_ecom_fulfillment_efficiency_plan_commit.md`
2. 查看 `{file}_commit.md` 如果缺失 `plan doc` 中断 review 并输出"缺失plan文档请补充"，如果缺失 `commit id` 则获取 git 最近的 10 条 commit log
3. 查看 `{file}_commit.md` 文档引用
   - `plan doc`，阅读理解 plan
   - `commit id`，根据 dev commit id 或 fix commit id 完成 review
4. 按以下步骤 1~10 完成 review

### 1. 作用域合规
- 检查 `{file}_commit.md` 的 dev/fix commit id 改动内容是否涉及与 plan 规划无关的文件被意外修改？若存在则标记等级 `High`。
- 注意：如果不在 commit 内容的变动是历史增量修改，review 时请忽略
- 新增文件是否归属已有包结构？未归入现有包则标记 `Medium`。

### 2. 类型与空值安全
<!-- Template-TODO: 替换为项目审查规范 -->
- 以下规则为通用模板，具体以项目 `.pi/references/{stack}_code_spec.md` 为准（`{stack}` 见 develop SKILL 占位）。
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
     - 没有实现 plan 定义的 phase
     - 内存泄漏、OOM
   - **High**：
     - 未完全遵循 plan 文档定义的 Task
   - **Medium**:
     - 不影响核心功能正常运行，仅局部场景体验变差
   - **LOW**
     - 仅格式、命名、风格、可读性问题
2. **Blocker**,**High**,**Medium** 的问题标记为 `待修复`，**LOW** 的问题不需要修复

### Review 结果输出目录 `docs/review`
1. 文件命名格式：`code_review_{file}.md`
   - 多轮复验更新同一文件，仅保留最终结论（复验历史由 git 追溯）
2. **必须遵循**文件内容模板：
   ```
   # Summary
   - <plan文件路径>
   - <简明扼要总结review范围>

   ## Review发现以下问题
   ### 问题 1
   - 问题: xx.ts:45-50 代码实现不全
   - 等级：Blocker
   - 符合规划：否
   - 是否修复：待修复
   - 改进建议：再次根据规划实施 phase x
   ```

### 8. not commit review doc
1. 所有 review 相关文档，模板 local 存储不需要 commit

### 9. 结论标记
- 输出格式模板（步骤 7）末尾须补"结论：通过/不通过"：
  ```
  ## 结论
  - 结论：通过（或 不通过）
  ```

### 10. 声明式交接
- 完成审查后**必须**声明审查结论（"通过"或"不通过"），由插件据此路由：
  - `fail`（不通过）→ 自动进入 fix 修复阶段
  - `pass`（通过）→ 进入 confirm 门由人工确认

---
## 交付项
- **必须** 代码审查
- **必须** 审查报告（包含"结论：通过"或"结论：不通过"标记行）
