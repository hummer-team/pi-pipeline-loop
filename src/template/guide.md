# pi-pipeline 使用指南

> **适用版本**：`@earendil-works/pi-pipeline@0.1.0`
> 本指南帮助你从零开始完成 pi-pipeline 插件的项目初始化、配置、启动和日常使用。

---

## 1. 安装插件

```bash
# npm
npm install @earendil-works/pi-pipeline

# 或 Bun
bun add @earendil-works/pi-pipeline
```

**运行环境要求**：Node.js >= 18 或 Bun >= 1.0，pi agent SDK `@earendil-works/pi-coding-agent` ^0.80.10。

在 pi agent 的扩展配置中注册插件：

```json
{
  "extensions": [
    {
      "name": "pi-pipeline",
      "module": "@earendil-works/pi-pipeline",
      "factory": "createPipelineFromJson",
      "args": ["./pipeline_loop.json"]
    }
  ]
}
```

---

## 2. 运行 pipeline_init 初始化

安装插件后，使用 `/pipeline_init` 命令自动创建项目所需的目录结构和模板文件。

### 2.1 创建目录并复制模板

```text
/pipeline_init 0
```

该命令执行以下操作：
1. 在项目根目录创建 `.pi/` 目录
2. 复制模板文件到 `.pi/` 下对应子目录：
   - `.pi/agents/{clarify,design,plan,develop,review,fix}/` — 各阶段 agent 定义文件
   - `.pi/skills/{design,plan,develop,review,fix}/` — 各阶段 skill 指令文件
   - `.pi/references/` — 模板引用文件（SOP、反模式、验证提示词等）
   - `.pi/domains/` — 业务域定义模板
3. 复制 `pipeline_loop.json` 到项目根目录
4. 复制 `guide.md` 到 `.pi/` 目录

**多次执行提示**：如果 `.pi/` 目录已存在模板文件，命令会弹出交互选项：
1. **强制覆盖** — 覆盖所有已存在文件（含 guide.md）
2. **跳过已存在文件** — 不覆盖已有文件（guide.md 例外，始终覆盖）
3. **重新执行 verify 生成** — 按跳过策略复制后追加执行 verify 生成
4. **cancel** — 中止操作

无 UI 模式（如 CI/CD）下默认走 skip 策略。

### 2.2 生成 verify.md 文件

```text
/pipeline_init 1
```

该命令根据 `.pi/skills/` 下各阶段的 SKILL.md 内容，自动生成 `.pi/references/{stage}_spec/verify.md` 验证规则文件。

**前置条件**：需先执行 `/pipeline_init 0` 创建目录结构。如果 `.pi/skills` 目录不存在，命令会跳过并提示先执行 dir 步骤。

### 2.3 不传参数（全部执行）

```text
/pipeline_init
```

先执行 dir 复制，再执行 verify 生成。

---

## 3. 配置 pipeline_loop.json

初始化后，项目根目录会生成 `pipeline_loop.json` 模板。根据项目需求调整配置：

```json
{
  "stages": {
    "clarify":    { "nextStage": "design" },
    "design":     { "nextStage": "plan" },
    "plan":       { "nextStage": "develop" },
    "develop":    { "nextStage": "review" },
    "review":     { "nextStage": "fix" },
    "fix":        { "nextStage": "develop" },
    "awaiting_human": { "nextStage": null },
    "completed":  { "nextStage": null }
  }
}
```

**关键字段说明**：
- `stages.{stage}.require`：设为 `false` 则该阶段使用默认空配置（相当于从流水线中移除）
- `stages.{stage}.nextStage`：下一阶段名称，`null` 为终端
- `stages.{stage}.model`：可选，该阶段使用的模型覆盖
- `stages.{stage}.verify.require`：是否启用自动验证
- `maxLoops`：单阶段最大测试失败重试次数（默认 3）
- `maxLoopCycles`：流水线循环周期上限（默认 3）

---

## 4. 启动 pipeline_start

编写需求文档后，使用 `/pipeline_start` 命令启动流水线：

```text
/pipeline_start REQUIREMENT.md
```

启动后插件执行：
1. 读取需求文档内容
2. 生成唯一 `pipelineId`
3. 设置 `currentStage = "clarify"`
4. 进入 clarify 阶段，需求文档内容自动注入到 Agent 的 systemPrompt

---

## 5. 8 阶段流转说明

流水线阶段序列：

```text
clarify → design → plan → develop → review → fix → awaiting_human → completed
```

| 阶段 | 目标 | 工具权限 |
|------|------|---------|
| **clarify** | 分析需求文档，识别歧义，提出澄清问题 | read, bash |
| **design** | 基于澄清结果，设计技术方案 | read, bash |
| **plan** | 将方案拆解为可执行的开发步骤 | read, bash |
| **develop** | 按计划编写代码，运行测试 | read, bash, write, edit |
| **review** | 审查代码质量和最佳实践 | read, bash |
| **fix** | 根据审查反馈修复问题 | read, bash, write, edit |
| **awaiting_human** | 流水线冻结，等待人工介入 | read（受限） |
| **completed** | 终端状态，流水线结束 | 无 |

**阶段交接流程**：每个阶段完成后，Agent 依次调用：
1. `generate_stage_summary` — 生成阶段摘要
2. `validate_summary` — 验证摘要（人工审批）
3. `pipeline_handoff` — 交接至下一阶段

**循环机制**（develop/fix 阶段）：
- 测试失败 → `loopCount += 1` → 达到 `maxLoops` → 流水线 `terminated`
- `fix → develop` 回环 → `loopCycleCount += 1` → 达到 `maxLoopCycles` → 拒绝交接

---

## 6. 辅助命令

### pipeline_status

```text
/pipeline-status
```

查看当前流水线状态：当前阶段、循环次数、验证结果、保护路径等。

### pipeline_init

```text
/pipeline_init [0|1]
```

- `0`：创建目录并复制模板
- `1`：生成 verify.md 文件
- 不传参数：全部执行（先 dir 后 verify）

---

## 7. 常见问题与恢复

### 7.1 流水线卡在 awaiting_human

**现象**：所有工具调用被阻止，Agent 无法执行操作。

**解决**：
- 查看审计日志（`.pi/audit/audit.log`）了解冻结原因
- 通过 `/pipeline-restart` 重新开始，或手动修改会话元数据恢复

### 7.2 loop-breaker 导致 terminated

**现象**：流水线在 develop → review → fix 之间循环达到上限后终止。

**解决**：
- 检查测试失败原因，修复根本问题
- 调高 `maxLoops` 或 `maxLoopCycles` 配置
- 使用 `/pipeline-restart` 重新开始流水线

### 7.3 受保护路径写入被拒

**现象**：Agent 在 develop/fix 阶段尝试修改 `.pi/`、`.git/` 或 `AGENTS.md` 时报错 `FORBIDDEN`。

**解决**：
- 在非循环阶段（clarify/design/plan/review）修改保护路径下的文件
- 或调整 Agent 的任务指令，避免在循环中触及保护路径

### 7.4 需要执行未授权的 bash 命令

**现象**：Agent 尝试执行的命令不在 `allowedBashPrefixes` 白名单中。

**解决**：
- Agent 调用 `request_bash_permission` 请求临时授权
- 用户在聊天中批准后，该命令前缀在当前会话中始终可用
- 若需永久允许，将命令前缀加入 `pipeline_loop.json` 的 `allowedBashPrefixes`
