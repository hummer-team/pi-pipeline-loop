---
name: review
description: 代码review专家 - 针对plan的实现进行review（由 code-review-agent 执行）
userInvocable: false
---

## workflow
当你（code-review-agent）被其他 Agent 触发时，你会收到一个**任务描述**，其中通常包含待审查的文件路径或 commit 信息。

**重要**：你不需要等待用户手动输入 `@code-review-agent`，因为调用你的上级 Agent 已经为你提供了必要的上下文。
1. **解析输入**：从上级 Agent 传递的任务描述中，提取文件路径`code-review-agent {file}_commit.md`
   - 举例：`code-review-agent docs/design/04_feat_fn_ecom_fulfillment_efficiency_plan_commit.md`则文件为`04_feat_fn_ecom_fulfillment_efficiency_plan_commit.md`
2. 查看`{file}_commit.md`如果缺失`plan doc`中断review并输出"缺失plan文档请补充"，如果缺失`commit id`则获取git最近的10条commit log
3. 查看`{file}_commit.md`文档引用
   - `plan doc`，阅读理解plan
   - `commit id`,根据commit id 完成review
4. 按以下章节步骤0~8完成review

## 0. 作用域合规
- 检查 `{file}_commit.md`的commit id's改动内容是否涉及与 plan 规划无关、且与方案设计不相关的文件被意外修改？若存在则标记等级 `High`。
- 注意：如果不在commit内容的变动是历史增量修改，review时请忽略
- 新增文件是否归属已有包结构（`controller/`、`job/`、`service/`、`repository/`、`model/`、`util/`、`common/`、`dto/`）？未归入现有包则标记 `Medium`。

## 1. 类型与空值安全
- **禁止裸类型（raw type）**：泛型类必须指定类型参数（如 `List<CBDTMonitor>`，非 `List`）。
- **Optional 正确使用**：repository 返回 `Optional` 时必须用 `orElseThrow` 或 `ifPresent` 处理，禁止直接 `Optional.get()` 无检查。
- **公共方法参数非空检查**：核心 service/public 方法入口应对关键参数做 `null` 检查或使用 `@NonNull` 注解。

## 2. 回归与副作用检测
- **方法签名兼容**：修改后的 public/protected 方法签名必须与所有调用方兼容，检查 `@Override` 是否正确覆盖抽象钩子（如 `fetchEmails`、`markSuccess` 等）。
- **JPA 实体变更**：`@Entity` 类字段增删或 `@Column` 约束修改，需确认不影响已有 repository 查询和数据库表结构。
- **定时任务调度影响**：修改 Job 类逻辑需确认不影响 `@Scheduled` 调度周期和线程池配置（`ExecutorService` + `CountDownLatch`）。

## 3. 代码质量
- **函数过长**：单个方法超过 100 行且无强耦合理由，标记 `Medium`。
- **命名不规范**：变量/方法命名中性化、无明确业务含义，或与项目现有命名风格不一致，标记 `Low`。
- **鲁棒性**：
  - 核心逻辑无边界检查（空集合、null 值、空字符串）。
  - `catch` 块必须记录 `error` 级别日志并包含明确的输入参数和异常堆栈，禁止空 `catch` 块吞掉异常。
  - 批量处理中单条失败不得中断整个批次（需 `try-catch` 包裹单条逻辑，记录后继续）。
- **代码重复**：违反 DRY 原则，模板方法抽象基类已有的逻辑子类不应重复实现。
- **外部调用规范**：出站 HTTP 必须通过 `DestinationAccessor` / `HttpClientAccessor`，禁止直接 `new HttpClient()`。

## 4. 日志规范
- **框架统一**：使用 Lombok `@Slf4j` 注解（或 `LoggerFactory.getLogger`），禁止 `System.out.println` / `System.err.println`。
- **日志级别**：
  - 方法入口/出口与核心业务流程 → `info`
  - 中间过程数据 → `debug`
  - 异常 → `error`
- **日志门控**：`debug` / `info` 级别必须检查等级是否开启后再输出（`if (log.isDebugEnabled())`），避免不必要的字符串拼接。
- **日志内容**：关键日志必须包含上下文信息（job 名称、记录 ID、关键参数），异常日志必须包含错误堆栈。

## 5. 配置安全
- 禁止在代码中硬编码密钥、密码、Token 等敏感信息。
- 运行时配置从 `APP_CONFIG_CBDT` 表（`AppConfigRepository`）读取，不得写入 `application.properties` 静态配置。
- 加密密钥（如 `EMAILID_ENCRYPTION_SECRET`）缺失时必须在日志中记录 `error` 并抛出明确异常，不得静默降级返回空值。
- BTP Destination 名称必须通过 `DestinationsEnum` 枚举引用，禁止直接拼接字符串。
## 6. 输出格式
### 问题/等级/改进建议
1. 问题等级定义
   - **Blocker**: 
     - 没有实现plan定义的phase
     - 内存泄漏、OOM
   - **High**：
     - 未完全遵循plan文档定义的Task,如：跳过步骤，缺失where子句功能
   - **Medium**:
     - 不影响核心功能正常运行，仅局部场景体验变差、代码健壮性不足，无线上故障风险
   - **LOW**
     - 仅格式、命名、风格、可读性问题，不改变程序行为、无任何故障风险
2. **Blocker**,**High**的问题标记为`待修复`,**Medium**,**LOW**的问题不需要修复
### Review结果输出目录`docs/review`
1. 文件命名格式：`code_review_{file}_plan.md`
   - 举例：`docs/review/code_review_01_e2e_flow_bug_v1_plan.md` 
2. **必须遵循***文件内容模板,其他如`类型安全`,`回归与副作用检测`有问题则安模板输出，无问题则在`Summary`简明扼要总结review范围,**模板**:
   ```
   # Summary
   - <plan文件路径> 如：`docs/bug/01_e2e_flow_bug_v1_plan.md`
   - <简明扼要总结review范围>
   
   ## Review发现以下问题
   ### 问题 1
   - 问题: xx.ts:45-50 代码实现不全,未修复x
   - 等级：Blocker
   - 符合规划：否
   - 是否修复：待修复
   - 改进建议：再次根据规划实施 phase x
   ```
## 6. **完成review**，必须调用 `compact` 工具**来压缩本次会话的上下文，如下命令：
    - `/compact save code review context`
## 7. not commit review doc
1. 所有review相关文档，模板local存储不需要commit
## 8. 根据条件触发subagent
1. 如果review结果存在`Blocker`或`High`的问题，使用 `task` 工具启动独立的修复子 agent，参数设置：
   - `subagent_type`: "code-review-withfix-agent"
   - `prompt`: `code-review-withfix-agent <code review file>`
   - 举例：`subagent_type: "code-review-withfix-agent"`, `prompt: "code-review-withfix-agent docs/review/code_review_04_feat_fn_ecom_fulfillment_efficiency_plan.md"`
