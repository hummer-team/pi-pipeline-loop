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

## 2. 运行 pipeline-init 初始化

安装插件后，使用 `/pipeline-init` 命令自动创建项目所需的目录结构和模板文件。

### 2.1 创建目录并复制模板

```text
/pipeline-init 0
```

该命令执行以下操作：
1. 在项目根目录创建 `.pi/` 目录
2. 复制模板文件到 `.pi/` 下对应子目录：
   - `.pi/agents/{clarify,plan,develop,review,fix}/` — 各阶段 agent 定义文件
   - `.pi/skills/{clarify,plan,develop,review,fix}/` — 各阶段 skill 指令文件
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
/pipeline-init 1
```

该命令根据 `pipeline_loop.json` 中各阶段配置的 `skillPath` 字段，解析 `.pi/skills/` 下对应的 SKILL.md 文件，提取 `**必须**`/`**Must**` 交付项标记，自动生成 `.pi/references/{stage}_spec/verify.md` 验证规则文件。

**前置条件**：需先执行 `/pipeline-init 0` 创建目录结构。如果 `.pi/skills` 目录不存在，命令会跳过并提示先执行 dir 步骤。

### 2.3 不传参数（全部执行）

```text
/pipeline-init
```

先执行 dir 复制，再执行 verify 生成。

---

## 3. 配置 pipeline_loop.json

初始化后，项目根目录会生成 `pipeline_loop.json` 模板。根据项目需求调整配置：

```json
{
  "stages": {
    "clarify":    { "nextStage": "plan" },
    "plan":       { "nextStage": "develop" },
    "develop":    { "nextStage": "review" },
    "review":     { "nextStage": "completed" },
    "fix":        { "nextStage": "review" },
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
- `output.pipelineStage`：是否在 TUI 状态栏显示阶段转换（默认 true）
- `protect`：文件保护配置（详见 3.2 节）
  - `gitignore`：是否解析 `.gitignore` 动态保护（默认 true）
  - `paths`：追加硬编码保护路径（与内置 `.pi/`、`AGENTS.md`、`.git/` 合并）
  - `allow`：仅放开 gitignore 动态保护的**编辑**权限（git add/commit 仍拦截）

### 3.1 全配置版示例

以下是包含所有可用字段的完整配置示例（含逐字段注释）：

```jsonc
{
  // ── 顶层字段 ──
  "maxLoops": 3,                    // 单阶段最大测试失败重试次数
  "maxLoopCycles": 3,               // 流水线循环周期上限（review/fix 回环计数）
  "auditDir": ".pi/audit",          // 审计日志目录
  "domainDir": ".pi/domains",       // 业务域定义目录
  "llmExtract": false,              // 是否启用 LLM 辅助提取交付项（需模型配置）
  "output": {
    "pipelineStage": true            // 是否在 TUI 状态栏显示当前阶段（默认 true）
  },
  "protect": {
    "gitignore": true,               // 默认 true：解析 .gitignore 动态保护
    "paths": ["dist/"],              // 追加硬编码保护（与内置 .pi/、AGENTS.md、.git/ 合并）
    "allow": ["docs/design/", "src/template/"]  // 仅放开编辑；git add/commit 仍拦截
  },

  // ── 阶段配置 ──
  "stages": {
    "clarify": {
      "skillPath": "design/SKILL.md",  // skill 文件路径（相对于 .pi/skills/）
      "nextStage": "plan",
      "verify": {
        "require": true,               // 启用自动验证
        "verifyFile": "verify.md",     // 验证文件名（默认 verify.md）
        "mode": "tool"                 // 验证触发方式: "hook"(agent_settled) | "tool"(stage_advance 内嵌验证门)
      }
    },
    "plan": {
      "skillPath": "plan/SKILL.md",
      "nextStage": "develop",
      "verify": { "require": true, "mode": "tool" }
    },
    "develop": {
      "skillPath": "develop/SKILL.md",
      "nextStage": "review",
      "allowedTools": ["read", "bash", "write", "edit", "stage_advance"],
      "allowedBashPrefixes": ["bun", "npm", "git", "ls", "echo"],
      "verify": { "require": true, "mode": "tool" }
    },
    "review": {
      "skillPath": "review/SKILL.md",
      "nextStage": "completed",        // 默认进入 completed；有 fail 时 agent 调 stage_advance(nextStage:"fix")
      "verify": { "require": true, "mode": "tool" }
    },
    "fix": {
      "skillPath": "fix/SKILL.md",
      "nextStage": "review",           // fix→review 质量环
      "allowedTools": ["read", "bash", "write", "edit", "stage_advance"],
      "allowedBashPrefixes": ["bun", "npm", "git", "ls", "echo"],
      "verify": { "require": true, "mode": "tool" }
    },
    "awaiting_human": { "nextStage": null },
    "completed":  { "nextStage": null }
  }
}
```

> **注意**：`skillPath` 字段决定 verify 生成时扫描哪个 skill 文件。clarify 阶段使用 `design/SKILL.md`（需求澄清与理解确认）。

### 3.2 保护文件（protect）配置

插件提供三层文件保护机制，防止 Agent 在 develop/fix 阶段误修改关键文件：

**保护层级**（优先级从高到低）：
1. **硬编码保护**：`.pi/`、`AGENTS.md`、`.git/` — 始终受保护，无法通过 `allow` 放开
2. **动态保护**：解析项目 `.gitignore` 文件，匹配的路径受保护（支持嵌套 `.gitignore`、`**` 通配、`!` 取反）
3. **Allow 例外**：仅放开 gitignore 动态保护的**编辑**权限（如 `docs/design/`、`src/template/`）
   - ⚠️ `allow` **不放开** git add/commit 操作
   - ⚠️ `allow` **不影响**硬编码保护路径

**拦截反馈机制**：
- 拦截返回 `{ block: true, reason: "FORBIDDEN: ..." }`，reason 自动反馈给模型
- TUI 显示 `notify` 提示（门控 `output.pipelineStage`，默认开启）
- develop/fix 阶段的 Loop Status 动态展示 allow 列表与受保护路径（事前告知）

**拦截不中断流程**：
- 仅 block 当次工具调用并反馈 reason
- **不冻结 pipeline**、不计入 loop 失败计数
- 模型改道继续推进当前 stage

**运维指引**：
- 若 gitignore 中被保护的文件/目录需要模型编辑，将其加入 `allow`
- 例如：`"allow": ["docs/design/", "src/template/"]` 允许编辑设计文档和模板文件
- 但 git add/commit 仍会拦截这些路径（gitignore 中的路径本不应提交）

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

## 5. 7 阶段流转说明

流水线阶段序列：

```text
clarify → plan → develop → review → completed
                    ↑         ↓
                    └── fix ←─┘
```

| 阶段 | 目标 | 工具权限 |
|------|------|---------|
| **clarify** | 分析需求文档，识别歧义，提出澄清问题；获得用户 full-und? 确认后完成 | read, bash, stage_advance |
| **plan** | 将澄清后的需求拆解为可执行的开发规划文档 | read, bash, stage_advance |
| **develop** | 按规划编写代码，运行测试，产出 _commit.md | read, bash, write, edit, stage_advance |
| **review** | 审查代码质量，产出 code review 报告；通过→completed，有fail→fix | read, bash, stage_advance |
| **fix** | 根据审查反馈修复问题，产出 _commit.md；修复后回到 review | read, bash, write, edit, stage_advance |
| **awaiting_human** | 流水线冻结，等待人工介入（仅用于兜底） | read（受限） |
| **completed** | 终端状态，流水线结束 | 无 |

**阶段交接流程**：验证模式为 `tool` 时，Agent 完成工作后调用 `stage_advance` 工具宣告阶段完成，其内部执行验证门，通过后自动进入下一阶段。

**循环机制**（review/fix 质量环）：
- review 报告有 fail → `stage_advance(nextStage:"fix")` → 修复后回到 review
- review 报告通过 → `stage_advance` → 默认进入 completed
- `loopCycleCount` 跟踪 review/fix 回环次数 → 达到 `maxLoopCycles` → 流水线终止

---

## 6. 辅助命令

### pipeline_status

```text
/pipeline-status
```

查看当前流水线状态：当前阶段、循环次数、验证结果、保护路径等。

### pipeline-init

```text
/pipeline-init [0|1]
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
- 重新开始流水线（运行 /pipeline_start REQUIREMENT.md 开启新流水线），或手动修改会话元数据恢复

### 7.2 loop-breaker 导致 terminated

**现象**：流水线在 develop → review → fix 之间循环达到上限后终止。

**解决**：
- 检查测试失败原因，修复根本问题
- 调高 `maxLoops` 或 `maxLoopCycles` 配置
- 使用 /pipeline_start REQUIREMENT.md 重新开始流水线

### 7.3 受保护路径写入被拒

**现象**：Agent 在 develop/fix 阶段尝试修改受保护路径时报错 `FORBIDDEN`。受保护路径包括：
- 内置硬编码路径：`.pi/`、`.git/`、`AGENTS.md`
- `.gitignore` 中匹配的动态路径

**解决**：
- 内置硬编码路径无法放开，请在非循环阶段（clarify/plan/review）修改
- 动态保护路径如需编辑，将其加入 `protect.allow` 配置：
  ```jsonc
  "protect": {
    "allow": ["docs/design/", "src/template/"]
  }
  ```
- 注意：`allow` 仅放开编辑权限，git add/commit 仍会拦截

### 7.4 需要执行未授权的 bash 命令

**现象**：Agent 尝试执行的命令不在 `allowedBashPrefixes` 白名单中。

**解决**：
- Agent 调用 `request_bash_permission` 请求临时授权
- 用户在聊天中批准后，该命令前缀在当前会话中始终可用
- 若需永久允许，将命令前缀加入 `pipeline_loop.json` 的 `allowedBashPrefixes`

### 7.5 git add / git commit 被拦截

**现象**：Agent 执行 `git add` 或 `git commit` 时报错 `FORBIDDEN`。

**拦截机制**：
- `git add`：使用 `git add --dry-run` 预览将被暂存的文件，命中保护路径则拦截
- `git commit`：检查 `git diff --cached`（staged 文件）；若带 `-a`/`--all` 还检查 unstaged 文件

**解决**：
- ⚠️ `allow` **不放开** git 通道 — gitignore 中的路径本不应提交
- 若确需将 gitignore 中的文件纳入版本管理，先在 `.gitignore` 中移除对应条目
- 即使使用 `git add -f`（force）也会被 dry-run 拦截
- 内置硬编码路径（`.pi/`、`AGENTS.md`、`.git/`）始终不可提交
