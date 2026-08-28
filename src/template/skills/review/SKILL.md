---
name: review
description: Code‑Review Expert‑Review the implementation against the plan
userInvocable: false
---

## workflow
当你被其他 Agent 触发时，你会收到一个**任务描述**，其中通常包含待审查的文件路径或 commit 信息。

1. **解析输入**：从上级 Agent 传递的任务描述中，提取文件路径 `code-review-agent {file}_commit.md`
   - 举例：`code-review-agent docs/design/04_feat_fn_ecom_fulfillment_efficiency_plan_commit.md` 则文件为 `04_feat_fn_ecom_fulfillment_efficiency_plan_commit.md`
2. 查看 `{file}_commit.md` 如果缺失 `plan doc` 中断 review 并输出"缺失plan文档请补充"，如果缺失 `commit id` 则获取 git 最近的 10 条 commit log
3. 查看 `{file}_commit.md` 文档引用
   - `plan doc`，阅读理解 plan
   - `commit id`，根据 dev commit id 或 fix commit id 完成 review
4. 按以下章节步骤 0~7 完成 review

## 0. 作用域合规
- 检查 `{file}_commit.md` 的 dev/fix commit id 改动内容是否涉及与 plan 规划无关的文件被意外修改？若存在则标记等级 `High`。
- 注意：如果不在 commit 内容的变动是历史增量修改，review 时请忽略
- 新增文件是否归属已有包结构？未归入现有包则标记 `Medium`。

## 1. 类型与空值安全
<!-- Template-TODO: 替换为项目审查规范 -->
- **禁止裸类型（raw type）**：泛型类必须指定类型参数。
- **Optional 正确使用**：返回 `Optional` 时必须用 `orElseThrow` 或 `ifPresent` 处理，禁止直接 `Optional.get()` 无检查。
- **公共方法参数非空检查**：核心 service/public 方法入口应对关键参数做 `null` 检查或使用 `@NonNull` 注解。

## 2. 回归与副作用检测
- **方法签名兼容**：修改后的 public/protected 方法签名必须与所有调用方兼容。
<!-- Template-TODO: 替换为项目特有的回归检测规则（如 JPA 实体变更、定时任务调度影响等） -->

## 3. 代码质量
- **函数过长**：单个方法超过 100 行且无强耦合理由，标记 `Medium`。
- **命名不规范**：变量/方法命名中性化、无明确业务含义，标记 `Low`。
- **鲁棒性**：
  - 核心逻辑无边界检查（空集合、null 值、空字符串）。
  - `catch` 块必须记录 `error` 级别日志并包含明确的输入参数和异常堆栈，禁止空 `catch` 块吞掉异常。
  - 批量处理中单条失败不得中断整个批次。
- **代码重复**：违反 DRY 原则。
<!-- Template-TODO: 替换为项目特有的代码质量规则（如外部调用规范等） -->

## 4. 日志规范
<!-- Template-TODO: 替换为项目审查规范 -->
- **框架统一**：使用项目约定的日志框架，禁止 `System.out.println` / `console.log`。
- **日志级别**：
  - 方法入口/出口与核心业务流程 → `info`
  - 中间过程数据 → `debug`
  - 异常 → `error`
- **日志内容**：关键日志必须包含上下文信息，异常日志必须包含错误堆栈。

## 5. 配置安全
- 禁止在代码中硬编码密钥、密码、Token 等敏感信息。
<!-- Template-TODO: 替换为项目特有的配置安全规则 -->

## 6. 输出格式
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
1. 文件命名格式：`code_review_{file}_plan.md`
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

## 7. not commit review doc
1. 所有 review 相关文档，模板 local 存储不需要 commit

## 8. 输出格式补充
- §6 输出格式模板末尾补"结论：通过/不通过"：
  ```
  ## 结论
  - 结论：通过（或 不通过）
  ```

## 9. confirm 确认门（Phase 3 — 162）

verify 通过后，confirm 门提供第二道人工/智能确认（由 `stages.review.confirm.mode` 配置）：

- **auto 模式**：verify 通过后自动推进到 completed，无 TUI 对话框。
- **manual 模式**：verify 通过后弹出 TUI 英文确认对话框：
  - `Approve & Complete` → 写确认标记，推进到 completed
  - `Reject & Send to Fix` → 路由到 fix 阶段修复
  - `Cancel` → 停留在 review，等待后续操作
- **smart 模式**：Agent 自评复杂度：
  - 复杂：在审查报告写 `## 智能确认：复杂`，然后调用推进工具并声明 `needConfirm: true` 触发确认门
  - 非复杂：直接调用推进工具自动推进到 completed（audit `confirm_smart_skip`）

**与 verify 的关系**：verify 管报告结论（`结论：通过`），confirm 门管人对代码质量的最终认可。两者独立。

---
## 交付项
- **必须** 代码审查
- **必须** 审查报告（包含"结论：通过"或"结论：不通过"标记行）
