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
      "args": [".pi/pipeline_loop.json"]
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
   - `.pi/agents/*.md` — 各阶段 agent 定义文件（平铺，无子目录）
   - `.pi/skills/{clarify,plan,develop,review,fix}/` — 各阶段 skill 指令文件
    - `.pi/references/` — 模板引用文件（SOP、反模式、pipeline-stage-prompt.yml 提示词配置、verify 规则等）
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

### 2.3 检查模板预留项 + 冲突检测

```text
/pipeline-init 2
```

规则扫描 `.pi/skills/*/SKILL.md` 和 `.pi/agents/*.md` 中的 `Template-TODO` 预留标识。命中即视为模板未修改，逐文件列出 `file:line:marker` 清单。

- **全部清除**：写状态文件 `{auditDir}/template-residue-check.json`（`{passed, checkedAt, fingerprint}`），后续 `/pipeline-start` 通过指纹短路免检。
- **存在残留**：清除状态文件；`/pipeline-start` 将在启动时阻塞并要求二选（重新检查 / 取消启动）。

同时执行模型冲突/重叠检测（`init.conflictCheck` 配置控制）：检查 SKILL 内容与插件注入段是否冲突，三选一（auto-optimize / manual-optimize / skip）。LLM 不可用时降级跳过并提示。

### 2.4 不传参数（全部执行）

```text
/pipeline-init
```

先执行 dir 复制，再执行 verify 生成。

---

## 3. 配置 pipeline_loop.json

初始化后，项目根目录会生成 `pipeline_loop.json` 模板。根据项目需求调整配置：

```json
{
  "llmExtract": true,
  "output": { "pipelineStage": true },
  "stages": {
    "clarify":    { "agentPath": ".pi/agents/feat-design-plan-agent.md",
                    "skillPath": "design/SKILL.md", "nextStage": "plan",
                    "verify": { "require": true, "completionMarker": "## 模型确认" } },
    "plan":       { "agentPath": ".pi/agents/feat-design-plan-agent.md",
                    "skillPath": "plan/SKILL.md", "nextStage": "develop",
                    "verify": { "require": true } },
    "develop":    { "agentPath": ".pi/agents/develop-agent.md",
                    "skillPath": "develop/SKILL.md", "nextStage": "review",
                    "verify": { "require": true, "selfVerifySkip": true } },
    "review":     { "agentPath": ".pi/agents/code-review-agent.md",
                    "skillPath": "review/SKILL.md", "nextStage": "fix" },
    "fix":        { "agentPath": ".pi/agents/code-review-withfix-agent.md",
                    "skillPath": "fix/SKILL.md", "nextStage": "completed",
                    "verify": { "require": true, "selfVerifySkip": true } },
    "awaiting_human": { "nextStage": null },
    "completed":  { "nextStage": null }
  }
}
```

**关键字段说明**：
- `stages.{stage}.agentPath`：**必配**，agent 定义文件路径（相对于 projectRoot）。`/pipeline-start` 启动时校验所有 active stage 均已配置，缺失则阻止启动
- `stages.{stage}.require`：设为 `false` 则该阶段使用默认空配置（相当于从流水线中移除）
- `stages.{stage}.nextStage`：下一阶段名称，`null` 为终端
- `stages.{stage}.verify.require`：是否启用 hook 自动验证（agent_settled 后执行）
- `stages.{stage}.verify.completionMarker`：交互式阶段完成标记文本。配置后 agent_settled 在 hook 验证前预检该标记是否已落盘到需求文档；未落盘则跳过验证、不推进、不计 verifyAttempts（防冻结）
- `stages.{stage}.verify.selfVerifySkip`：当模型已在本 stage 工具调用中成功执行过相同 requiredCommand 时跳过重执行（仅 audit），write/edit 文件变更后失效；默认 false（develop/fix 建议开启）
- `llmExtract`：是否启用 LLM 辅助提取交付项（推荐 true，结合技术栈检测生成项目相关命令）
- `maxLoops`：单阶段最大测试失败重试次数（默认 3）
- `maxLoopCycles`：流水线循环周期上限（默认 3）
- `output.pipelineStage`：是否在 TUI 状态栏显示阶段转换（默认 true）。状态栏格式：`[ {pipelineId} • {stage} -> {nextStage} ]`（nextStage 置灰；completed 无箭头；无 meta 时回退 `Pipeline → {stage}`）
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
  "maxLoopCycles": 3,               // 流水线循环周期上限（review/fix/develop 回环计数）
  "llmExtract": true,               // 启用 LLM 辅助提取交付项（推荐开启，结合技术栈检测）
  "auditDir": ".pi/audit",          // 审计日志目录
  "domainDir": ".pi/domains",       // 业务域定义目录
  "output": {
    "pipelineStage": true            // 是否在 TUI 状态栏显示当前阶段（默认 true）
  },
  "protect": {
    "gitignore": true,               // 默认 true：解析 .gitignore 动态保护
    "paths": ["dist/"],              // 追加硬编码保护（与内置 .pi/、AGENTS.md、.git/ 合并）
    "allow": ["docs/design/", "src/template/"]  // 仅放开编辑；git add/commit 仍拦截
  },
  "decisionShortcutKey": "ctrl+enter",  // TUI 中决策确认快捷键（默认 ctrl+enter）
  // ── 阶段配置 ──
  "stages": {
    "clarify": {
      "agentPath": ".pi/agents/feat-design-plan-agent.md",  // 必配：agent 定义文件路径
      "skillPath": "design/SKILL.md",  // skill 文件路径（相对于 .pi/skills/）
      "nextStage": "plan",
      "allowedWritePaths": ["docs/", "doc/", "documentation/"],  // 默认：仅文档目录
      "verify": {
        "require": true,               // 启用 hook 自动验证
        "verifyFile": "verify.md",     // 验证文件名（默认 verify.md）
        "completionMarker": "## 模型确认"  // 交互完成标记（未落盘则跳过验证）
        // mode 默认 "hook"（agent_settled 触发）
      }
    },
    "plan": {
      "agentPath": ".pi/agents/feat-design-plan-agent.md",
      "skillPath": "plan/SKILL.md",
      "nextStage": "develop",
      "allowedWritePaths": ["docs/", "doc/", "documentation/"],
      "verify": { "require": true }
    },
     "develop": {
       "agentPath": ".pi/agents/develop-agent.md",
       "skillPath": "develop/SKILL.md",
       "nextStage": "review",
       "allowedWritePaths": ["**"],     // 默认：全放开
       "verify": { "require": true, "selfVerifySkip": true }
     },
      "review": {
        "agentPath": ".pi/agents/code-review-agent.md",
        "skillPath": "review/SKILL.md",
        "nextStage": "fix",              // review→fix 质量环（review 不通过时进入 fix）
        "allowedWritePaths": ["docs/", "doc/", "documentation/"],
        // review 默认启用 verify：`结论：(通过|不通过)` 校验结论存在（review_spec/verify.md）
        "verify": { "require": true },
      },
      "fix": {
        "agentPath": ".pi/agents/code-review-withfix-agent.md",
        "skillPath": "fix/SKILL.md",
        "nextStage": "review",            // fix 复验后回 review 复验（由 review 确认门收敛到 completed）
        "allowedWritePaths": ["**"],
        "verify": { "require": true, "selfVerifySkip": true }
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

**Bash 命令特殊放行规则 (Phase 2 / 139)**：
- fd 重定向（`2>&1`、`1>&2`、`>&2` 等）不视为写目标，不会触发 FORBIDDEN
- `/dev/*` 设备路径（`> /dev/null`、`> /dev/stderr` 等）不视为写目标
- 重定向类目标（kind=redirect）位于项目外时放行（`/dev/*`、`/tmp/*`、绝对路径重定向均放行）
- 仍受 destructive-command 检查（`> /dev/sda` 等破坏性目标由 DESTRUCTIVE_COMMAND_PATTERNS 拦截）
- file-arg 类目标（rm/mv/cp/touch/tee）保护不变（项目外仍 block）

#### 3.2.1 protect.ask 三选一对话框

配置 `protect.ask: true` 时，Agent 尝试编辑受保护路径会弹出 3 选 1 对话框（而非直接拦截）：

1. **Follow plugin default rules (default)** → 按默认规则处理（block）
2. **Allow this edit only** → 仅允许本次编辑
3. **Allow edits for this session** → 本次 + 该路径在当前会话中免询问

**触发范围**：
- Agent 工具调用（write/edit/bash 修改）受保护路径时
- `/pipeline-init 1` 对**已存在** verify.md 的 merge 覆盖写入（详见 §9.4.2）
- **首次生成**的 verify.md 不弹窗（创建不弹窗、覆盖才确认）

**降级**：Esc / 无 UI → 按默认（block）处理。每次决策都审计为 `pipeline_protect_ask` 事件。

**拦截不中断流程**：
- 仅 block 当次工具调用并反馈 reason
- **不冻结 pipeline**、不计入 loop 失败计数
- 模型改道继续推进当前 stage

**运维指引**：
- 若 gitignore 中被保护的文件/目录需要模型编辑，将其加入 `allow`
- 例如：`"allow": ["docs/design/", "src/template/"]` 允许编辑设计文档和模板文件
- 但 git add/commit 仍会拦截这些路径（gitignore 中的路径本不应提交）

### 3.3 Stage 级写白名单（allowedWritePaths）

在 `protect` 全局保护之外，插件还支持 **per-stage 写白名单**，限定各阶段可写文件范围，形成"stage 白名单 + 全局黑名单"混合模型。

**配置位置**：`stages.{stage}.allowedWritePaths`

```jsonc
{
  "stages": {
    "clarify": {
      "allowedWritePaths": ["docs/", "doc/", "documentation/"]  // 默认值
    },
    "develop": {
      "allowedWritePaths": ["**"]  // 默认值：全放开
    }
  }
}
```

**默认值**（未显式配置时自动应用）：
- `clarify` / `plan` / `review`：`["docs/", "doc/", "documentation/"]` — 仅允许写文档目录
- `develop` / `fix`：`["**"]` — 全放开，维持原有全局保护链

**语义规则**：
- `"**"`：全放开，本 stage 不做写限制（全局 protect 链照常生效）
- `[]`：完全禁写，本 stage 不允许任何写操作
- `["docs/", "src/"]`：目录前缀匹配，仅允许写这些目录下的文件
- 显式配置会**覆盖**默认值；未配置则落到 stage 类型默认值

**与全局 protect 的关系**：
- Stage 白名单命中 → **豁免**全局 gitignore 写保护（白名单即本 stage 授权）
- 硬编码保护路径（`.pi/`、`AGENTS.md`、`.git/`）**不可豁免**，即使白名单命中仍 block
- `git add` / `git commit` 仍走全局内容级保护，不受 stage 白名单影响
- 读通道（read 工具、只读 bash）不受白名单限制

**clarify/plan/review 默认行为**：
- 写范围：`docs/`、`doc/`、`documentation/`（可通过 `allowedWritePaths` 覆盖）
- Bash：仅允许只读 git 子命令（`git log`、`git status`、`git diff`、`git show`），`git add`/`git commit`/`git push` 因不匹配任何前缀天然被拒
- 可读取全项目（读不受限）
- review 启用 verify：`结论：(通过|不通过)` 由 verify.md 规则校验结论存在；结论由模型经 `stage_advance({ reviewConclusion: "fail" })` 声明后自动路由至 fix；未声明则退回 verify + confirm 门

**违规反馈**：
- 拦截返回 `{ block: true, reason: "FORBIDDEN: '<path>' not in allowed write paths for '<stage>' stage." }`
- Reason 自动包含目标路径与当前 stage，喂回模型可自解释
- 不冻结 pipeline、不计入 loop 失败计数（沿用全局保护语义）

---

## 4. 启动 pipeline-start

编写需求文档后，使用 `/pipeline-start` 命令启动流水线。**`doc_file` 为必填参数**：

```text
/pipeline-start REQUIREMENT.md
```

启动后插件执行：
1. 读取需求文档内容
2. 生成唯一 `pipelineId`
3. 设置 `currentStage = "clarify"`，并将需求文档路径写入 `meta.requirementDoc`
4. 进入 clarify 阶段，需求文档路径注入 context_reference（REQUIRED CONTEXT FILES），Agent 使用 read 工具读取需求文档内容

### 4.1 doc_file 必填语义

- **全新启动**：必须提供 `doc_file`。无文件 → 返回 `run /pipeline-start <doc_file> start pipeline loop`，**不初始化状态机**（不写 meta、不启动流水线）。
- **aborted 重启**：
  - 若已有 `meta.requirementDoc`（非空）→ 保留原值、正常 restart
  - 若 `meta.requirementDoc` 为空 → 同样返回必填提示，不静默续跑
- **running / blocked**：拒绝启动，提示使用 decision menu 处理

### 4.1b startStageMode 启动模式

`pipeline_loop.json` 顶层配置 `startStageMode` 控制 `/pipeline-start` 的启动行为：

| 模式 | 行为 | 适用场景 |
|------|------|---------|
| `"auto"`（默认） | 零交互。fresh→clarify；aborted→resume/new 矩阵（与 142 一致） | CI/自动化 |
| `"confirm"` | aborted+可 resume 时弹出一次确认「Resume at {stage}?」 | 轻量防误操作 |
| `"ask"` | TUI 四选菜单：Resume stage / New pipeline / Spec stage / Cancel | 灵活跳级启动 |

```json
{
  "startStageMode": "auto",
  "stages": { ... }
}
```

- **Spec stage**（ask 模式）：支持从任意 active stage 启动（排除 awaiting_human/completed），自动重建 `previousStage` 和 `stageVisitOrder` 阶段链。
- **自动注入**（Phase 2）：fresh/spec→clarify 成功后，通过 `pi.sendUserMessage("@<agent名> <file> 1")` 自动进入澄清流程。降级路径：无 pi SDK / 无 agentPath 时 notify 提示，不阻断启动。
- **checkVerifyFiles 起始感知**：仅校验起始 stage 及后续可达 stage 的 verify.md，spec 跳级不会因前置 stage 的 verify.md 缺失而被拦截。

### 4.2 `{requirementDoc}` 占位符解析规则

verify.md 中可使用 `{requirementDoc}` 占位符引用需求文档路径：

```yaml
rules:
  requiredFiles:
    - "{requirementDoc}"
```

- **解析时机**：验证执行前，插件用 `meta.requirementDoc` 替换占位符
- **未设置 requirementDoc** → 显式 config error（冻结流水线，detail 含补救指引：`Run /pipeline-start <doc_file> to set requirementDoc`）
- **补救**：带文件参数执行 `/pipeline-start <doc_file>` 重启流水线
- **pipeline-init 提前告警**：`/pipeline-init 1` 检测到 verify.md 含 `{requirementDoc}` 占位符时，在报告中输出 warn 行，提示必须通过 `/pipeline-start <doc_file>` 启动才能解析

---

## 5. 7 阶段流转说明

流水线阶段序列（质量环：review ⇄ fix，review 确认通过→completed）：

```text
clarify → plan → develop → review ⇄ fix → review (loop) → completed
                ↑ selfVerifySkip   ↑ confirm 门（manual）
                └── 模型自验跳过或插件兜底 ──┘
```

| 阶段 | 目标 | 工具权限 |
|------|------|---------|
| **clarify** | 分析需求文档，识别歧义，提出澄清问题；获得用户 full-und? 确认后完成。full-und? 确认标记（`## 模型确认`）落盘后由 agent_settled 自动验证推进 | read, bash, write, edit, stage_advance（写限 docs/；hook 验证 + completionMarker 预检） |
| **plan** | 将澄清后的需求拆解为可执行的开发规划文档 | read, bash, write, edit, stage_advance（写限 docs/；hook 验证 + confirm 门） |
| **develop** | 按规划编写代码，运行测试，产出 _commit.md | read, bash, write, edit, stage_advance（hook 验证 + selfVerifySkip） |
| **review** | 审查代码质量，产出 code review 报告；verify 校验 `结论：(通过|不通过)`；结论由模型经 stage_advance 声明：fail→自动转 fix，pass→confirm 门通过后→completed | read, bash, write, edit, stage_advance（写限 docs/；hook 验证 + confirm 门） |
| **fix** | 根据审查反馈修复问题，产出 _commit.md；修复后→review 复验 | read, bash, write, edit, stage_advance（hook 验证 + selfVerifySkip） |
| **awaiting_human** | 流水线冻结，等待人工介入（仅用于兜底） | read（受限） |
| **completed** | 终端状态，流水线结束 | 无 |

**阶段交接流程**：验证模式为 `hook` 时，Agent 完成工作后进入 idle 状态，插件在 `agent_settled` hook 自动执行验证，通过则自动进入下一阶段。配置了 confirm 门的阶段（plan/review），verify 通过后还需通过 confirm 门（TUI 确认对话框）才能推进。

**selfVerifySkip 语义**：develop/fix 配置 `verify.selfVerifySkip: true` 时，插件根据工具调用记录判定模型是否已在本 stage 成功执行过相同 requiredCommand（命令 token 前缀匹配，`./mvnw`/`mvnw` 归一化）。命中且 exitCode=0 则跳过重执行、仅写 audit（`method:"self_verified"`）；此后若有 write/edit 成功记录则失效强制重验。Phase 6 (139) 新增 VERIFIED_COMMANDS 协议识别——子 agent 通过 task 返回的 `VERIFIED_COMMANDS: cmd1,cmd2` 行也计入已验证命令集合。

**质量环**（review ⇄ fix → review，confirm 通过→completed）：
- review 声明 `reviewConclusion: "fail"` → 自动转 fix（不经 confirm 门）；声明 pass / 未声明 → verify + confirm 门
- review 报告有 Blocker/High/Medium → confirm 门拒绝→fix → 修复后→review 复验
- review confirm 门通过 → completed
- fix 复验通过 → review（再次 confirm 门）
- `loopCycleCount` 跟踪 review/fix 回环次数 → 达到 `maxLoopCycles` → 流水线终止

> **fix.nextStage 修正 (162)**：`fix.nextStage` 为 `"review"`，修复后回 review 复验，由 review confirm 门收敛至 completed。

### 5.1 confirm 确认门

verify 通过后，confirm 门提供第二道人工/智能确认。配置：

```json
"stages": {
  "plan": {
    "confirm": { "mode": "manual", "maxRejections": 5 }
  },
  "review": {
    "confirm": { "mode": "manual" }
  }
},
"maxConfirmRejections": 5,
"confirmOverflow": "ask"
```

**三模式行为**：

| mode | 行为 |
|------|------|
| `auto` | 插件自动写双语标记（`## 用户确认：确认无误` + `## User Confirmation: Confirmed`），verify 自然通过，无 TUI 对话框 |
| `manual` | verify 通过后弹出 TUI 英文确认对话框，用户选择 Approve & Advance / Reject & Rework / Cancel |
| `smart` | Agent 自评复杂度：复杂→写 `## 智能确认：复杂` + `stage_advance({ needConfirm: true })` 触发确认门；非复杂→`stage_advance()` 自动推进（audit `confirm_smart_skip`） |

**拒绝去向矩阵**：
- plan 拒绝 → clarify（重新澄清）
- review 拒绝 → fix（修复后回 review 复验）
- review 确认通过 → completed

**循环上限**：`confirmRejections` 独立计数（不复用 maxLoops/maxVerifyAttempts）。超限行为由 `confirmOverflow` 控制：
- `"ask"`（默认）：弹出 Continue/Terminate 选择
- `"terminate"`：直接 `flowState: "aborted"`

**计数器生命周期**：start/restart/resume 复位；plan→clarify→plan 往返保留计数；review→fix→review 往返保留计数。

**与 verify 关系**：confirm 门在 verify 之后触发。plan manual/smart 模式下，verify 的标记规则（`^## (用户确认|User Confirmation)`）通过 `deferContentPatterns` 延后，不阻塞 verify（C2 顺序修复）。`pipeline_verify` 工具对 confirm 非 auto 阶段返回 `pending`，引导 agent 调用 `stage_advance`（防绕过，audit `confirm_defer_to_stage_advance`）。

---

## 6. 辅助命令

### pipeline_status

```text
/pipeline-status
```

查看当前流水线状态：当前阶段、循环次数、验证结果、保护路径等。

### pipeline-init

```text
/pipeline-init [0|1|2]
```

- `0`：创建目录并复制模板
- `1`：仅生成 verify.md 文件
- `2`：规则预留项检查（Template-TODO）+ 模型冲突/重叠检测
- 不传参数：全部执行（先 dir 后 verify，等价 0+1）

---

## 7. 自定义提示词（pipeline-stage-prompt.yml）

本插件在各阶段向 Agent systemPrompt 注入的提示词由 `.pi/references/pipeline-stage-prompt.yml` 控制。该文件在 `/pipeline-init 0` 初始化时从插件模板复制到项目中。如需自定义提示词，编辑项目内的 `.pi/references/pipeline-stage-prompt.yml` 即可（不要直接修改插件安装目录中的模板文件）。

插件提示词追加在 pi agent 基础 systemPrompt 之后，不污染 pi agent 提示词职责。

### 7.1 文件结构

yml 顶层包含 25 个 key，分为七组：

| Key | 说明 |
|-----|------|
| `clarify` | clarify 阶段提示词模板 |
| `plan` | plan 阶段提示词模板 |
| `develop` | develop 阶段提示词模板 |
| `review` | review 阶段提示词模板 |
| `fix` | fix 阶段提示词模板 |
| `stage_executor_clarify` | clarify 阶段执行者调度段 |
| `stage_executor_plan` | plan 阶段执行者调度段 |
| `stage_executor_develop` | develop 阶段执行者调度段 |
| `stage_executor_review` | review 阶段执行者调度段 |
| `stage_executor_fix` | fix 阶段执行者调度段 |
| `stage_deliverable_develop` | develop 阶段插件默认交付项（verify 规则层 + 注入层） |
| `stage_deliverable_review` | review 阶段插件默认交付项 |
| `stage_deliverable_fix` | fix 阶段插件默认交付项 |
| `verify_clarify` | clarify 阶段执行验证时的 modelPrompt |
| `verify_plan` | plan 阶段执行验证时的 modelPrompt |
| `verify_develop` | develop 阶段执行验证时的 modelPrompt |
| `verify_review` | review 阶段执行验证时的 modelPrompt |
| `verify_fix` | fix 阶段执行验证时的 modelPrompt |
| `verify_extract_clarify` | clarify 阶段生成 verify.md 时 LLM 提取交付项提示词 |
| `verify_extract_plan` | plan 阶段生成 verify.md 时 LLM 提取交付项提示词 |
| `verify_extract_develop` | develop 阶段生成 verify.md 时 LLM 提取交付项提示词 |
| `verify_extract_review` | review 阶段生成 verify.md 时 LLM 提取交付项提示词 |
| `verify_extract_fix` | fix 阶段生成 verify.md 时 LLM 提取交付项提示词 |
| `verify_extract` | 全局提取提示词回退默认（当 per-stage verify_extract_{stage} 为空时使用） |
| `conflict_check_prompt` | SKILL vs Plugin 冲突检测的全局提示词（支持 per-stage 变体 `conflict_check_prompt_{stage}`） |

Stage key 的 value 为空或缺失时，插件自动使用内置默认提示词。verify_{stage} 为空时回退内置默认验证提示词。verify_extract_{stage} 为空时回退到全局 `verify_extract`，再空则回退内置默认。

### 7.2 占位符表

模板中支持 10 个动态占位符，运行时由流水线状态替换为实际值：

| 占位符 | 注入内容 | 适用 stage |
|--------|---------|-----------|
| `{{context_reference}}` | 前一阶段验证通过的 summary 路径 + 本阶段上下文文件 + clarify 阶段需求文档路径 | 所有 stage |
| `{{domain_skill}}` | 业务域规则内容（启用 domain 时） | 所有 stage |
| `{{stage_skill}}` | 当前阶段 skill 文件内容（.pi/skills/{skillPath}） | 所有 stage |
| `{{loop_status}}` | 循环工程状态（当前步骤/尝试次数/保护路径/写范围） | develop、fix |
| `{{pipeline_status}}` | 流水线状态（pipelineId/当前阶段/域/验证状态） | 所有 stage |
| `{{verify_failures}}` | 上一阶段验证失败列表 | 所有 stage |
| `{{verify_tool_guidance}}` | 验证模式工具指引（tool 模式时） | 所有 stage |
| `{{stage_write_scope}}` | 写范围说明（非循环阶段） | clarify、plan、review |
| `{{stage_executor}}` | 阶段执行者调度段（哪个子 agent 执行、如何返回） | clarify、plan、develop、review、fix |
| `{{stage_deliverables}}` | Part 10：插件默认交付项（develop/review/fix 有值，其他 stage 为空） | 所有 stage（空则不渲染） |

**段落格式**：每个占位符独占一段，段间以 `---` 分隔。当占位符的动态值为空时，该段（两个 `---` 之间的内容）自动从渲染结果中移除。

### 7.3 修改方法

以 develop 阶段为例，以下是可复制的 yml 片段——保留既有占位符段落，追加自定义纯文本段落：

```yaml
develop: |
  {{context_reference}}
  ---
  {{domain_skill}}
  ---
  {{stage_skill}}
  ---
  {{loop_status}}
  ---
  {{pipeline_status}}
  ---
  {{verify_failures}}
  ---
  {{verify_tool_guidance}}
  ---
  必须遵循 TDD，先写测试再实现。
  所有公共函数必须添加 JSDoc 注释。
```

**两条规则**：

1. **不含占位符的自定义段落始终保留**——可在任意位置自由追加约束文本（如编码规范、测试要求），插件不会移除这些段落
2. **段落间以 `---` 分隔；勿删除关键占位符行**——每个 stage 必须保留以下关键占位符，否则该 stage 整体回退默认提示词：
   - 所有 stage：`{{pipeline_status}}`
   - develop / fix：另需 `{{loop_status}}`
   - clarify / plan / review：另需 `{{stage_write_scope}}`

### 7.4 回退行为

插件提供三档回退机制，确保编辑 yml 不影响流水线运行：

1. **stage value 为空/缺失** → 使用插件内置默认 8-part 提示词（与未配置一致）
2. **关键占位符缺失** → 该 stage 整体回退默认提示词（插件记录审计日志）
3. **yml 文件缺失/解析失败** → 全部 stage 走默认提示词，不影响流水线运行

此外，未知占位符（`{{xxx}}` 不在上述 8 个已知 key 中）保留原样不替换，可放心用于自定义标记。

**Prompt 快照审计**：当 yml 模板命中并成功渲染时，插件将渲染后的完整 systemPrompt 以多行快照格式写入 `audit.log`（`source=yml`）；当关键占位符缺失触发回退时，同样写入回退后的 default prompt 快照（`source=fallback`）；yml 未命中走 default 路径时也会写快照（`source=default`）。快照写入受 `audit.promptSnapshot` 控制（`"full"`/`"plugin"`/`"off"`，默认 `"full"`）。快照格式如下：

```
YYYY-MM-DD HH:mm:ss - [INFO] prompt_snapshot | stage=clarify | pipelineId=xxx | source=yml
=== PROMPT START ===
（多行 prompt 内容，仅含插件段，不含 pi base）
=== PROMPT END ===
```

快照写入 `{auditDir}/YYYYMMDD_audit.log`，与常规审计事件共存。

### 7.5 verify_extract 系列

`verify_extract` 是 yml 中的全局 key（不属于某个 stage），用于 verify 阶段从 `.pi/skills/` 下对应 SKILL.md 提取 **必须** 交付项的提示词。

- value 为空 → 使用插件内置默认提取提示词
- 旧文件 `.pi/references/verify_prompt.md` 已废弃，插件不再读取

Per-stage 提取提示词（`verify_extract_{stage}`）支持按阶段定制提取逻辑：
- 回退链：`verify_extract_{stage}` → 全局 `verify_extract` → 内置默认
- 未配置 per-stage key 时自动回退到全局 `verify_extract`

### 7.6 覆盖语义

- 已初始化项目重跑 `/pipeline-init 0` 即可获得 `pipeline-stage-prompt.yml`（对不存在的文件始终复制）
- **guide.md 始终覆盖**：重跑 init 后使用指南刷新为最新版本
- **`.pi/references/` 下文件按 skip 策略保留用户修改**：重跑 init 后 yml 中已编辑的内容不会被覆盖
- yml 文件缺失或损坏时自动回退默认提示词，可放心编辑

### 7.7 验证提示词说明

**执行阶段验证提示词**（`verify_{stage}`）：
- 验证时作为 modelPrompt 注入模型，指导 LLM 判断阶段交付是否达标
- 为空/缺失 → 回退到 verify.md body → 再空则使用内置默认验证提示词
- rules 始终来自 verify.md frontmatter（与 verify_{stage} 无关）

**生成阶段提取提示词**（`verify_extract_{stage}`）：
- 生成 verify.md 时用于 LLM 提取交付项
- 回退链：`verify_extract_{stage}` → 全局 `verify_extract` → 内置默认

### 7.8 老项目迁移说明

已初始化项目升级到新版本后：
1. 重跑 `/pipeline-init 0` 复制新文件 `pipeline-stage-prompt.yml`
2. 旧文件 `prompt-injector.yml` 不再被读取，插件自动回退到内置默认提示词
3. 如用户自定义过旧 yml 内容，需手动将自定义内容迁移到新文件 `pipeline-stage-prompt.yml`
4. 新文件包含 25 个 key（5 stage + 5 stage_executor_{stage} + 3 stage_deliverable_{stage} + 5 verify_{stage} + 5 verify_extract_{stage} + 1 全局 verify_extract + 1 conflict_check_prompt）

---

## 7.5 审计事件表

所有管线推进/查询事件通过 `writeStageAudit` 统一写入审计日志（`.pi/audit/YYYYMMDD_audit.log`）。

| 事件 | 触发时机 | 关键字段 |
|------|---------|---------|
| `stage_advance` | 成功推进到下一阶段 | pipelineId, stage, sequence, fromStage, toStage, override |
| `stage_advance_failed` | 推进失败（非法 nextStage/同 stage/verify 失败） | fromStage, reason |
| `pipeline_completed` | 进入 completed 终态 | finalStage, loopCycleCount, stageVisitOrder |
| `pipeline_start` | /pipeline-start 成功 | file, previousStage, command, mode (fresh/resume/spec), startStage |
| `pipeline_start_launch` | clarify 子 agent 自动注入成功 | agentName, requirementDoc, pipelineId |
| `pipeline_start_launch_skipped` | 无 pi SDK，降级 notify 提示 | agentName, reason |
| `pipeline_state` | 每次 pipeline_state 查询 | snapshot (完整状态 JSON) |
| `loop_check` | 每次 loop_check 调用 | action (advance/retry/halt), loopCount, summary |

**通用字段**：所有 `writeStageAudit` 事件自动携带 `pipelineId`、`stage`、`sequence`（沿 nextStage 链到 completed）、`loopCount`、`maxLoops`。

**Agent 速查表**：

| Agent | 阶段 | 文件名 | 职责 |
|-------|------|--------|------|
| `feat-design-plan-agent` | clarify/plan | `.pi/agents/feat-design-plan-agent.md` | 方案设计与规划 |
| `develop-agent` | develop | `.pi/agents/develop-agent.md` | 功能开发 |
| `code-review-agent` | review | `.pi/agents/code-review-agent.md` | 代码审查 |
| `code-review-withfix-agent` | fix | `.pi/agents/code-review-withfix-agent.md` | 修复 Blocker/High/Medium |

### 7.9 clarify 双入口与 stage skill 注入

clarify 阶段支持两种启动方式，两者均创建 fork 子会话并触发插件的 `before_agent_start` 注入：

1. **用户手动启动**：`@feat-design-plan-agent <doc> <round>`
2. **自动启动**：`/pipeline-start <doc>` — 插件自动调用 `maybeAutoLaunchClarify`，经 `sendUserMessage` 唤起 clarify subagent

**注入行为**：两种方式均会在 fork 子会话中触发插件注入当前 stage 的 skill（`STAGE-SPECIFIC RULES`），这是插件的目标特性，自动注入是正确的。

**跨上下文重复**：`/pipeline-start` 自动启动场景下，主会话（orchestrator）在 `sendUserMessage` 触发的 turn 中也可能携带同一 stage skill，与 fork 子会话各一份。同一 LLM 上下文内不会重复注入；跨上下文重复属于编排语义，非缺陷。

**审计定位**：当 `config.audit.promptSnapshot` 为 `full`（默认）时，audit log 包含以下独立事件，可精确区分 base 与 plugin 内容：

| 事件 | 内容 |
|------|------|
| `prompt_snapshot` | 合并后的完整 system prompt（base + plugin） |
| `prompt_snapshot_base` | pi 基础 system prompt（无 base 时写入占位文本） |
| `prompt_snapshot_plugin` | 插件注入的 prompt（含 stage skill） |

每个事件均携带 `prompt_hash` 字段，便于内容比对与去重分析。

---

## 8. 常见问题与恢复

### 8.1 流水线卡在 awaiting_human

**现象**：所有工具调用被阻止，Agent 无法执行操作。

**解决**：
- 查看审计日志（`.pi/audit/audit.log`）了解冻结原因
- 重新开始流水线（运行 /pipeline-start REQUIREMENT.md 开启新流水线），或手动修改会话元数据恢复

### 8.2 loop-breaker 导致 terminated

**现象**：流水线在 develop → review → fix 之间循环达到上限后终止。

**解决**：
- 检查测试失败原因，修复根本问题
- 调高 `maxLoops` 或 `maxLoopCycles` 配置
- 使用 /pipeline-start REQUIREMENT.md 重新开始流水线

### 8.3 受保护路径写入被拒

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

### 8.4 破坏性命令被拦截

**现象**：Agent 尝试执行危险命令（如 `sudo`、`rm -rf /`、`mkfs` 等）时被拦截。

**拦截机制**：
- 插件维护破坏性命令黑名单，匹配的命令会触发用户确认对话框
- 对话框提供三个选项：
  1. **Follow default rules (block, default)** — 按默认规则拦截
  2. **Allow this command once** — 仅本次放行
  3. **Allow this command for session** — 本次会话放行该命令
- 若 `protect.ask: false`（默认），破坏性命令直接拦截，需修改命令或启用 `protect.ask: true`

**解决**：
- 启用 `protect.ask: true` 以允许用户确认对话框
- 避免使用危险命令，改用安全的替代方案
- 对于项目内文件操作，确保路径在 `allowedWritePaths` 范围内

### 8.5 git add / git commit 被拦截

**现象**：Agent 执行 `git add` 或 `git commit` 时报错 `FORBIDDEN`。

**拦截机制**：
- `git add`：使用 `git add --dry-run` 预览将被暂存的文件，命中保护路径则拦截
- `git commit`：检查 `git diff --cached`（staged 文件）；若带 `-a`/`--all` 还检查 unstaged 文件

**解决**：
- ⚠️ `allow` **不放开** git 通道 — gitignore 中的路径本不应提交
- 若确需将 gitignore 中的文件纳入版本管理，先在 `.gitignore` 中移除对应条目
- 即使使用 `git add -f`（force）也会被 dry-run 拦截
- 内置硬编码路径（`.pi/`、`AGENTS.md`、`.git/`）始终不可提交

---

## 9. 验证机制（verify）完整说明

### 9.1 验证模式（verify.mode）

插件支持两种验证触发模式：

| 模式 | 触发时机 | 适用阶段 |
|------|---------|---------|
| `hook`（默认） | Agent 进入 idle 状态时，`agent_settled` hook 自动执行验证 | clarify, plan, develop, fix |
| `tool` | Agent 调用 `stage_advance` 工具时，工具内部执行验证门 | 任意（需配置） |

**推荐实践**：clarify/plan/develop/review/fix 均使用 hook 模式（agent_settled 自动触发）。review 启用 verify 将「结论：(通过|不通过)」作为规则校验结论存在（review_spec/verify.md 含 `结论：(通过|不通过)` pattern）；结论由模型调用 `stage_advance({ reviewConclusion: "fail" })` 声明后自动路由至 fix；声明 pass 或未声明则走 verify + confirm 门（避免 review↔fix 死循环）。

### 9.2 selfVerifySkip 机制

develop/fix 阶段配置 `verify.selfVerifySkip: true` 时：
- 插件根据**工具调用记录**（非文本声明）判定模型是否已在本 stage 成功执行过相同 requiredCommand
- 匹配规则：命令 token 前缀匹配（归一化后 `./mvnw`/`mvnw` 等价）
- **文件变更失效**：matching 之后若有 write/edit 成功记录，该命令不跳过
- 命中且 exitCode=0 → 跳过重执行，仅写 audit（`method:"self_verified"`）
- 模型遗漏 → 插件兜底执行，保证验证闭环

```jsonc
"develop": {
  "verify": { "require": true, "selfVerifySkip": true }
}
```

### 9.3 技术栈检测（LLM 提取增强）

当 `llmExtract: true` 时，插件在 LLM 提取 verify.md 规则前自动探测项目技术栈：

| 探测文件 | 技术栈 | 推荐命令 |
|---------|--------|---------|
| `pom.xml` / `mvnw` | Maven | `./mvnw clean compile` + `./mvnw clean test` |
| `build.gradle` / `gradlew` | Gradle | `./gradlew build` + `./gradlew test` |
| `package.json` + `bun.lockb` | bun | `bun run build` + `bun test` |
| `package.json` + `pnpm-lock.yaml` | pnpm | `pnpm run build` + `pnpm test` |
| `package.json` + `yarn.lock` | yarn | `yarn build` + `yarn test` |
| `package.json` | npm | `npm run build` + `npm test` |
| `Cargo.toml` | cargo | `cargo build` + `cargo test` |
| `pyproject.toml` | python | `python -m build` + `python -m pytest` |

探测到的技术栈上下文会注入到 LLM 提取提示词，确保 LLM 生成项目相关命令而非默认示例。

### 9.4 verify.md 规则级合并重建与保护语义

重跑 `/pipeline-init 1` 时，verify.md 已存在的处理逻辑：

| 情况 | 行为 | status | 显示文案 |
|------|------|--------|---------|
| 旧 verify.md 规则缺失某些 expected 命令/文件 | 补入缺失规则，body 保留 | `merged` | `Merged (rules added to existing verify.md):` |
| 旧 verify.md 含自定义规则（fileContentPattern/expectOutput 等） | 跳过，保护人工规则 | `skipped` (reason: `exists_custom`) | `user-authored custom rules protected` |
| 旧 verify.md 已覆盖所有 expected 规则 | 跳过，无变化 | `skipped` (reason: `exists`) | `rules already present` |
| 用户通过 protect.ask 拒绝覆盖（见 §9.4.1） | 该 stage 跳过，其余继续 | `skipped` (reason: `user_declined`) | `user declined overwrite` |

#### 9.4.1 损坏 frontmatter 自动清洗（Bug 3-C 修复）

`/pipeline-init 1` 在 exists 分支检测到损坏的 verify.md（如 `mode: and---` 闭合分隔符不独立成行）时，自动插入换行使 `---` 独立成行，然后继续正常 merge 流程。**仅插入换行符，不改动任何规则文本**。修复动作审计为 `verify_md_repair` 事件。

#### 9.4.2 ask 覆盖确认（protect.ask=true 时）

当 `protect.ask: true` 时，pipeline-init 对**已存在** verify.md 的 merge 覆盖写入会弹出 3 选 1 对话框：

1. **Follow plugin default rules (default)** → 跳过（block）
2. **Allow this edit only** → 允许本次覆盖
3. **Allow edits for this session** → 允许本次 + 该路径在当前会话中免询问

**首次生成**（文件不存在）不弹窗，直接生成。Esc / 无 UI → 按默认处理（block），该 stage 跳过、其余 stage 继续。

### 9.4.A verify.md 格式规范

verify.md 使用 YAML frontmatter 格式。**闭合分隔符 `---` 必须独立成行**：

```markdown
---
rules:
  requiredFiles:
    - "output.md"
  mode: and
---
Verify the delivery items...
```

**错误格式**（会导致 `mode: and` 静默降级为 `mode: or`）：

```markdown
---
rules:
  requiredFiles:
    - "output.md"
  mode: and---
Verify the delivery items...
```

`/pipeline-init 1` 会自动清洗已损坏的文件（见 §9.4.1）。新文件生成天然正确。手工编辑 verify.md 时，请确保 `---` 独立成行。

#### 9.4.B 自定义 verify 规则完整参考

入口：编辑 `.pi/references/{stage}_spec/verify.md` 的 YAML frontmatter。插件支持五类规则，可组合使用。

##### 1. `requiredFiles` — 文件存在性校验

路径支持 glob（`*`/`?`），至少一个匹配即通过。

```yaml
rules:
  requiredFiles:
    - "docs/design/*_plan.md"
    - "docs/design/*_commit.md"
```

##### 2. `requiredCommands` — 命令执行校验

`cmd` 为命令字符串，`expectExit` 为期望退出码（默认 0），`expectOutput` 为期望 stdout 子串（可选）。

```yaml
rules:
  requiredCommands:
    - cmd: "bun run build"
      expectExit: 0
    - cmd: "bun test"
      expectExit: 0
      expectOutput: "pass"
```

配合 `verify.selfVerifySkip: true` 可跳过模型已在本 stage 成功执行的相同命令（详见 §9.2）。`VERIFIED_COMMANDS` 自报协议见 §5。

##### 3. `requiredGit` — Git 状态校验

```yaml
rules:
  requiredGit:
    lastCommitWithin: "1h"
    branch: "main"
    cleanWorkingTree: true
```

##### 4. `fileContentPattern` — 文件内容正则校验

`path` 支持 glob（glob path 只查**最新 mtime** 文件）。`pattern` 为 JavaScript regex，使用 `m` 模式 + `test()` 存在匹配语义（匹配到任意位置即通过）。

```yaml
rules:
  fileContentPattern:
    - path: "docs/design/*_commit.md"
      pattern: "^\\*\\*plan doc\\*\\*:"
    - path: "docs/design/*_plan.md"
      pattern: "^## (用户确认|User Confirmation)"
    - path: "docs/review/code_review_*.md"
      pattern: "结论：(通过|不通过)"
```

**占位符**：`{requirementDoc}` 由 `/pipeline-start` 设置的需求文档路径替换（引用 §4.2）。未设置时规则不生效（运行时报 `requirementDoc not set`，属运行时配置错误 → freeze + 决策菜单）。

##### 5. `keywords` + `mode` — 关键词聚合校验（legacy）

校验对象是**主线程 assistantMessages 聚合**（subagent 文件产物请用 `fileContentPattern`）。`mode` 仅支持 `and`/`or`（大小写敏感）。

```yaml
rules:
  keywords:
    - "方案推荐"
    - "分析完成"
  mode: and
```

##### 完整示例（clarify_spec/verify.md 形态）

```yaml
---
rules:
  fileContentPattern:
    - path: "{requirementDoc}"
      pattern: "full-und\\? 理解确认：是"
    - path: "{requirementDoc}"
      pattern: "(?<![\\s\\S])(?![\\s\\S]*?^# 第 \\d+ 轮澄清(?![^]*?^- \\*{0,2}方案[ \\t]*[A-Z]))(?![\\s\\S]*?^# 第 \\d+ 轮澄清(?![^]*?^[ \\t]*答[:：]))"
---
等待用户输入 full-und? 询问是否完全理解需求；澄清节（含 `# 第 N 轮澄清`）必须包含方案推荐（`- 方案 [A-Z]`，容忍 `- 方案A` 无空格与 `**方案 X**` 加粗形态）与用户答复（`答：`/`答:`，容忍前导缩进如 `  答：...`）；无澄清节直接通过。
```

##### 坑点

- `---` 闭合分隔符独立成行（§9.4.A），否则 `mode: and` 等尾部规则静默降级
- glob path 只查**最新 mtime** 文件（引擎既有语义，不扩展）
- regex 为**存在匹配语义**：匹配到任意位置即通过；需用 `^`/`$` 锚定行首行尾
- `mode` 仅支持 `and`/`or`（大小写敏感），其他值（如 `xor`）会触发配置诊断错误
- `{requirementDoc}` 未设置时规则不生效（运行时 freeze，非静态跳过）

##### 配置错误行为（148 新增）

每次 `runVerification` 前实时诊断 verify.md frontmatter。以下情形判定为配置错误：

| 错误码 | 触发条件 | 行为 |
|--------|---------|------|
| `file_missing` | verify.md 文件缺失 | 跳过验证（视为通过）+ TUI 提示 + audit `verify_config_skip` |
| `frontmatter_missing` | 无 `---` 分隔符 | 同上 |
| `yaml_parse_error` | frontmatter 解析失败 | 同上 |
| `unknown_top_level_key` | 未知顶层 key | 同上 |
| `invalid_mode` | `mode` 非 `and`/`or` | 同上 |
| `empty_rule_item` | 空 path/pattern/keyword | 同上 |
| `no_rules` | 无任何规则 | 同上 |

**运行时配置错误**（静态诊断无法发现）：EISDIR / 路径指向目录 / 未解析 `{requirementDoc}` 占位符 → freeze + 决策菜单（保留既有 `isConfigError` 行为）。

修复后下阶段验证自动恢复（每次验证前重新诊断）。

### 9.5 破坏性命令拦截

插件维护破坏性命令黑名单，自动拦截危险操作（如 `sudo`、`rm -rf /`、`mkfs`、`dd of=/dev/` 等）。

**检测机制**：
- **模式匹配**：检查命令是否匹配预定义的破坏性模式
- **路径启发式**：检查 `rm`/`mv`/`chmod`/`chown` 是否 targeting 系统路径（如 `/etc`、`/usr`、`.git`）

**用户确认**：当 `protect.ask: true` 时，破坏性命令触发三选一对话框：
1. 按默认规则拦截（block）
2. 本次放行（allow once）
3. 本次会话放行（allow for session）

### 9.6 质量环与 8→7 阶段迁移

新版模板使用 7 阶段形态，质量环路径为 **review ⇄ fix**（review 拒绝→fix，fix 复验后回 review），由 review 确认门收敛到 completed：

```text
clarify → plan → develop → review ⇄ fix → review (loop) → completed (confirm approved)
```

老项目迁移步骤：
1. 更新 `pipeline_loop.json` 的 `review.nextStage` 从 `"completed"` 改为 `"fix"`
2. 更新 `fix.nextStage` 从 `"completed"` 改为 `"review"`（修复后回 review 复验，完成由 review 确认门收敛）
3. 重跑 `/pipeline-init 0` 刷新模板文件
4. 重跑 `/pipeline-init 1` 合并重建 verify.md（旧 bun 命令将被补入正确的项目命令）
5. （可选）启用 `llmExtract: true` 让 LLM 提取更贴合项目技术栈的 verify 规则

### 9.7 completionMarker 交互预检机制

对于交互式阶段（如 clarify 需要用户 full-und? 确认），配置 `verify.completionMarker` 可避免 hook 验证时序误报：

```jsonc
"clarify": {
  "verify": {
    "require": true,
    "completionMarker": "## 模型确认"
  }
}
```

**工作机制**：
1. Agent settled 触发时，若配置了 `completionMarker`，先预检需求文档（`meta.requirementDoc`）是否包含该标记文本
2. **标记已落盘** → 正常执行验证流程
3. **标记未落盘** → 跳过验证、不推进阶段、**不计 verifyAttempts**（防止冻结循环）
4. 审计记录 `verify_completion_marker_pending` 事件

**设计原则**：
- 纯配置驱动，不依赖 verify.md 规则
- `requirementDoc` 未设置或文件读取失败 → 视为未落盘（返回 false）
- 未配置 `completionMarker` 的 stage 行为完全不变（向后兼容）

---

## 10. 已初始化项目迁移指引

### 10.1 agents 目录平铺迁移

新版本将 agents 从子目录平铺到 `.pi/agents/*.md`（pi agent 可正确识别 subagent）。

**迁移步骤**（已初始化项目手动执行）：

```bash
# 移动 agent 文件到平铺目录
mv .pi/agents/clarify/feat-design-plan-agent.md .pi/agents/
mv .pi/agents/develop/develop-agent.md .pi/agents/
mv .pi/agents/review/code-review-agent.md .pi/agents/
mv .pi/agents/fix/code-review-withfix-agent.md .pi/agents/

# 删除空子目录
rmdir .pi/agents/clarify .pi/agents/develop .pi/agents/review .pi/agents/fix
```

**注意**：`/pipeline-init` 不会自动迁移已有的 agents 目录结构（避免覆盖用户自定义 agent）。新项目初始化天然使用平铺结构。

### 10.2 agentPath 配置迁移

`agentFile` 字段已重命名为 `agentPath`（可选字段，无默认回退）。`/pipeline-start` 启动时校验所有 5 个 active stage 均配置了 `agentPath`，缺失则阻止启动。

**迁移步骤**：在 `pipeline_loop.json` 中为每个 active stage 添加 `agentPath`：

```jsonc
{
  "stages": {
    "clarify": { "agentPath": ".pi/agents/feat-design-plan-agent.md", ... },
    "plan":    { "agentPath": ".pi/agents/feat-design-plan-agent.md", ... },
    "develop": { "agentPath": ".pi/agents/develop-agent.md", ... },
    "review":  { "agentPath": ".pi/agents/code-review-agent.md", ... },
    "fix":     { "agentPath": ".pi/agents/code-review-withfix-agent.md", ... }
  }
}
```
