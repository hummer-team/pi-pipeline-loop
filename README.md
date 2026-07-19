# @earendil-works/pi-pipeline

> Pipeline loop plugin for [pi agent](https://github.com/earendil-works/pi) — 基于阶段的智能体编排引擎，支持项目级配置注入、工具安全管控、循环熔断与审计追踪。

## 目录

- [安装](#安装)
- [快速开始](#快速开始)
- [PipelineConfig 配置](#pipelineconfig-配置)
- [Pipeline 工作流](#pipeline-工作流)
- [Hooks 与 Tools](#hooks-与-tools)
- [命令](#命令)
- [Domain 提示词配置](#domain-提示词配置)
- [审计日志](#审计日志)
- [npm 发布](#npm-发布)
- [API 类型参考](#api-类型参考)

---

## 安装

### 1. 安装 npm 包

```bash
npm install @earendil-works/pi-pipeline
```

> **注意**：`@earendil-works/pi` 是 peerDependency，请确保目标项目已安装 pi SDK。

### 2. 创建项目侧配置

在目标项目的 `.pi/extensions/pipeline/` 目录下创建以下文件：

```
.pi/extensions/pipeline/
├── package.json          # 声明依赖
├── pipeline.config.ts    # 项目专属 PipelineConfig
└── index.ts              # 入口文件，注册插件
```

**`package.json`**：

```json
{
  "name": "my-project-pipeline",
  "private": true,
  "dependencies": {
    "@earendil-works/pi-pipeline": "^0.1.0"
  }
}
```

**`pipeline.config.ts`**：

```ts
import type { PipelineConfig } from "@earendil-works/pi-pipeline";

const config: PipelineConfig = {
  projectRoot: process.cwd(),
  auditDir: ".pi/audit",
  domainDir: ".pi/domains",
  maxLoops: 3,
  stages: {
    clarify: {
      agentFile: "feat-design-plan-agent.md",
      skillPath: "design-und/SKILL.md",
      model: "claude-sonnet-4-20250514",
      allowedTools: ["read", "write", "bash", "generate_stage_summary"],
      allowedBashPrefixes: ["cat", "ls", "find"],
      nextStage: "design",
      requireDomain: true,
    },
    design: {
      agentFile: "feat-design-plan-agent.md",
      skillPath: "design-plan/SKILL.md",
      model: "claude-sonnet-4-20250514",
      allowedTools: ["read", "write", "bash", "generate_stage_summary"],
      allowedBashPrefixes: ["cat", "ls", "find"],
      nextStage: "plan",
      requireDomain: true,
    },
    plan: {
      agentFile: "feat-design-plan-agent.md",
      skillPath: "design-plan/SKILL.md",
      model: "claude-sonnet-4-20250514",
      allowedTools: ["read", "write", "bash", "generate_stage_summary", "validate_summary"],
      allowedBashPrefixes: ["cat", "ls", "find"],
      nextStage: "develop",
      requireDomain: true,
    },
    develop: {
      agentFile: "develop-agent.md",
      skillPath: "fast-develop/SKILL.md",
      model: "claude-sonnet-4-20250514",
      allowedTools: ["read", "write", "edit", "bash", "loop_check", "generate_stage_summary"],
      allowedBashPrefixes: ["npm", "bun", "git", "npx"],
      nextStage: "review",
      requireDomain: true,
    },
    review: {
      agentFile: "code-review-agent.md",
      skillPath: "code-review/SKILL.md",
      model: "claude-sonnet-4-20250514",
      allowedTools: ["read", "bash", "generate_stage_summary"],
      allowedBashPrefixes: ["npm", "bun", "git"],
      nextStage: "fix",
      requireDomain: false,
    },
    fix: {
      agentFile: "code-review-withfix-agent.md",
      skillPath: "code-review-withfix/SKILL.md",
      model: "claude-sonnet-4-20250514",
      allowedTools: ["read", "write", "edit", "bash", "loop_check", "generate_stage_summary"],
      allowedBashPrefixes: ["npm", "bun", "git", "npx"],
      nextStage: "review",
      requireDomain: false,
    },
    awaiting_human: {
      agentFile: "develop-agent.md",
      skillPath: "",
      allowedTools: [],
      allowedBashPrefixes: [],
      nextStage: null,
      requireDomain: false,
    },
    completed: {
      agentFile: "develop-agent.md",
      skillPath: "",
      allowedTools: [],
      allowedBashPrefixes: [],
      nextStage: null,
      requireDomain: false,
    },
  },
};

export default config;
```

**`index.ts`**：

```ts
import { createPipeline } from "@earendil-works/pi-pipeline";
import config from "./pipeline.config";

export default createPipeline(config);
```

---

## 快速开始

```bash
# 1. 安装依赖
npm install @earendil-works/pi-pipeline

# 2. 创建项目配置（参考上方 PipelineConfig 配置）
# 3. 启动 pi agent（插件自动加载 .pi/extensions/pipeline/）
pi start

# 4. 输入需求，pipeline 自动运行
```

---

## PipelineConfig 配置

`PipelineConfig` 是项目侧提供的配置对象，通过 `createPipeline(config)` 注入到插件：

| 字段 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| `stages` | `Record<PipelineStage, StageConfig>` | 是 | — | 8 个阶段的完整配置映射 |
| `projectRoot` | `string` | 是 | — | 项目根目录的绝对路径 |
| `auditDir` | `string` | 否 | `".pi/audit"` | 审计日志和摘要输出目录 |
| `domainDir` | `string` | 否 | `".pi/domains"` | Domain 提示词文件目录 |
| `maxLoops` | `number` | 否 | `3` | develop/fix 循环最大次数 |

### StageConfig 字段说明

| 字段 | 类型 | 说明 |
|------|------|------|
| `agentFile` | `string` | Agent 定义文件路径（相对于 projectRoot） |
| `skillPath` | `string` | Skill 文件路径（相对于 `.pi/skills/`） |
| `model` | `string?` | 该阶段使用的模型（如 `"claude-sonnet-4-20250514"`） |
| `allowedTools` | `string[]` | 该阶段允许使用的工具列表 |
| `allowedBashPrefixes` | `string[]` | 该阶段允许的 bash 命令前缀 |
| `nextStage` | `PipelineStage \| null` | 下一阶段，`null` 表示终止 |
| `requireDomain` | `boolean` | 是否需要注入 Domain 提示词 |

---

## Pipeline 工作流

Pipeline 包含 8 个阶段，按以下流程自动流转：

```
┌─────────┐    ┌────────┐    ┌──────┐    ┌─────────┐    ┌────────┐    ┌─────┐
│ clarify │───▶│ design │───▶│ plan │───▶│ develop │───▶│ review │───▶│ fix │
└─────────┘    └────────┘    └──────┘    └─────────┘    └────────┘    └─────┘
                                  │                         ▲            │
                                  │ 人工卡点                 │            │
                                  │ (validate_summary)      └────────────┘
                                  │                         review↔fix 循环
                                  ▼                         (≤ maxLoops 次)
                            ┌──────────────┐
                            │awaiting_human│  ← 熔断 / 人工审核
                            └──────────────┘
                                  │
                                  ▼
                            ┌───────────┐
                            │ completed │
                            └───────────┘
```

### 完整使用流程

1. **安装配置**：项目安装 `@earendil-works/pi-pipeline`，编写 `pipeline.config.ts`
2. **启动 pi agent**：插件自动从 `.pi/extensions/pipeline/` 加载
3. **输入需求** → 自动进入 `clarify` 阶段
4. **clarify → design → plan**：自动流转，每个阶段结束时 agent 调用 `generate_stage_summary` 生成摘要
5. **人工审核 plan**：用户 review plan 文档后，调用 `validate_summary` 批准 → 进入 `develop`
6. **develop**：按 plan Phase 逐步实现代码，完成后自动进入 `review`
7. **review ↔ fix 循环**：自动循环（最多 `maxLoops` 次），超过限制后 pipeline 冻结进入 `awaiting_human`
8. **全流程完成**：pipeline 进入 `completed`

### 阶段流转规则

- 每个阶段结束时，agent 必须调用 `generate_stage_summary` 生成摘要
- 摘要必须经过 `validate_summary` 人工审核（status 变为 `"valid"`）
- `pipeline_handoff` 仅在摘要已验证的情况下允许阶段切换
- `develop` 和 `fix` 阶段支持自动循环，测试失败计数 +1，达到 `maxLoops` 后熔断

---

## Hooks 与 Tools

### Hooks（5 个事件钩子）

| Hook | 事件 | 功能 |
|------|------|------|
| `session_start` | 会话启动 | 初始化 pipeline 元数据（pipelineId、domain、stage） |
| `before_agent_start` | Agent 启动前 | 注入 5 段提示词（上下文、Domain、Skill、Loop 状态、Pipeline 状态） |
| `tool_call` | 工具调用前 | 工具权限校验、Bash 命令前缀检查、文件写入保护、冻结状态拦截 |
| `tool_result` | 工具执行后 | 测试失败计数、循环熔断、文件修改 diff 归档 |
| `session_end` | 会话结束 | 写入 `session_end` 审计日志 |

### Tools（6 个自定义工具）

| Tool | 参数 | 功能 |
|------|------|------|
| `stage_advance` | 无 | 按配置推进到下一阶段 |
| `loop_check` | `result: "pass"\|"fail"`, `summary?` | 检查循环状态，返回 advance/retry/halt |
| `pipeline_state` | 无 | 获取完整 pipeline 状态 |
| `generate_stage_summary` | `coreContent`, `constraints`, `pendingItems`, `referenceFiles` | 生成阶段摘要（frontmatter + markdown） |
| `validate_summary` | `stage`, `isApproved`, `comment?` | 人工审核摘要（valid/invalid） |
| `pipeline_handoff` | `nextStage`, `note?` | 阶段切换（需摘要已验证） |

### 工具安全管控

`tool_call` hook 执行四层安全检查：

1. **工具权限**：仅允许 `StageConfig.allowedTools` 中的工具
2. **Bash 前缀**：仅允许 `StageConfig.allowedBashPrefixes` 匹配的命令
3. **冻结状态**：`awaiting_human` 阶段阻止所有工具调用
4. **文件保护**：禁止写入 `.pi/`、`AGENTS.md`、`.git/` 等受保护路径

---

## 命令

### `/pipeline-status`

查看当前 pipeline 运行状态：

```
# Pipeline Status
- ID: pipe-1721356800000-a1b2c3
- Stage: develop
- Model: claude-sonnet-4-20250514
- Domain: sap-btp@1.0.0
- Summary Status: pending (Path: .pi/audit/pipe-xxx/develop.md)
- Loop: 1/3 (Step: 2)
- Protected: .pi/, AGENTS.md, .git/
```

---

## Domain 提示词配置

Domain 提示词为特定业务领域提供上下文知识，仅在 `requireDomain: true` 的阶段注入。

### 目录结构

```
~/.pi/domains/
├── sap-btp.md        # SAP BTP 领域知识
├── e-commerce.md     # 电商领域知识
└── default.md        # 默认领域（fallback）
```

### Domain 文件格式

支持可选的 YAML frontmatter：

```markdown
---
id: sap-btp
version: 1.0.0
---

# SAP BTP 领域知识

## 技术栈
- SAP BTP (Business Technology Platform)
- CAP (Cloud Application Programming Model)
- ...

## 编码规范
- 使用 CDS 定义数据模型
- ...
```

如果没有 frontmatter，文件名（不含 `.md`）将作为 domain id。

### 加载规则

1. `session_start` 时从 `{domainDir}/domain.md` 加载默认 domain
2. `before_agent_start` 时从 `~/.pi/domains/{domain.id}.md` 加载领域知识
3. 仅 `requireDomain: true` 的阶段会注入 domain 内容

---

## 审计日志

所有关键事件以 JSON Lines 格式写入 `{auditDir}/audit.log`：

### 事件类型

| 事件 | 触发时机 | 记录字段 |
|------|----------|----------|
| `loop_break` | 循环熔断（测试失败达到 maxLoops） | timestamp, pipelineId, stage, loopCount |
| `file_modified` | 文件写入/编辑成功 | timestamp, pipelineId, stage, step, loop, file, diff |
| `summary_validated` | 摘要人工审核 | timestamp, pipelineId, stage, approved, comment |
| `handoff` | 阶段切换 | timestamp, pipelineId, from, to, model, summaryHash, note |
| `session_end` | 会话结束 | timestamp, pipelineId, finalStage |

### 日志示例

```json
{"timestamp":"2026-07-19T10:30:00.000Z","pipelineId":"pipe-1721356800000-a1b2c3","action":"handoff","from":"plan","to":"develop","model":"claude-sonnet-4-20250514","summaryHash":"abc123...","note":"Plan approved"}
{"timestamp":"2026-07-19T10:35:00.000Z","pipelineId":"pipe-1721356800000-a1b2c3","action":"file_modified","stage":"develop","step":0,"loop":0,"file":"src/handler.ts","diff":".pi/audit/pipe-xxx/step-0/loop-0/handler.ts.diff.md"}
{"timestamp":"2026-07-19T10:40:00.000Z","pipelineId":"pipe-1721356800000-a1b2c3","action":"loop_break","stage":"develop","loopCount":3}
```

### 摘要文件结构

摘要文件输出到 `{auditDir}/{pipelineId}/{stage}.md`，包含 JSON frontmatter 和 markdown body：

```markdown
---
{
  "stage": "plan",
  "pipeline_id": "pipe-1721356800000-a1b2c3",
  "generated_at": "2026-07-19T10:25:00.000Z",
  "domain": "sap-btp@1.0.0",
  "validation_status": "valid",
  "hash": "sha256:abc123..."
}
---
# PLAN Stage Summary

## Core Content
...

## Constraints
- ...

## Pending Items
- ...

## Reference Files
- ...
```

---

## npm 发布

### 版本号规范

遵循 [Semantic Versioning](https://semver.org/)：

- `MAJOR.MINOR.PATCH`（如 `0.1.0` → `0.2.0` → `1.0.0`）
- 破坏性变更 → MAJOR
- 新功能（向后兼容）→ MINOR
- Bug 修复 → PATCH

### 发布步骤

```bash
# 1. 确保构建通过
bun run build

# 2. 更新版本号
npm version patch   # 或 minor / major

# 3. 发布到 npm
npm publish --access public
```

### 发布内容

`package.json` 中 `"files": ["dist"]` 确保仅发布编译产物：

```
dist/
├── index.js          # 主入口（CommonJS）
├── index.d.ts        # 类型声明
├── types.js / .d.ts
├── core/
│   ├── session-starter.js / .d.ts
│   ├── prompt-injector.js / .d.ts
│   ├── tool-guard.js / .d.ts
│   ├── loop-breaker.js / .d.ts
│   ├── stage-advancer.js / .d.ts
│   ├── loop-checker.js / .d.ts
│   ├── pipeline-state.js / .d.ts
│   └── session-ender.js / .d.ts
├── tools/
│   ├── generate-summary.js / .d.ts
│   ├── validate-summary.js / .d.ts
│   └── pipeline-handoff.js / .d.ts
└── commands/
    └── pipeline-status.js / .d.ts
```

---

## API 类型参考

### 导出的类型

```ts
import type {
  PipelineStage,    // "clarify" | "design" | "plan" | "develop" | "review" | "fix" | "awaiting_human" | "completed"
  StageConfig,      // 单阶段配置（agentFile, skillPath, model, allowedTools, ...）
  PipelineConfig,   // 顶层配置（stages, projectRoot, auditDir, domainDir, maxLoops）
  SessionMeta,      // 运行时元数据（currentStage, pipelineId, domain, summaries, loopCount, ...）
  SummaryMeta,      // 摘要元数据（path, hash, status）
  DomainConfig,     // Domain 配置（id, version, skillPath）
  Hook,             // pi SDK 事件钩子接口
  Tool,             // pi SDK 自定义工具接口
  Command,          // pi SDK 自定义命令接口
  PipelinePlugin,   // createPipeline() 返回的插件对象 { hooks, tools, commands }
} from "@earendil-works/pi-pipeline";
```

### createPipeline

```ts
function createPipeline(config: PipelineConfig): PipelinePlugin;
```

接收项目级 `PipelineConfig`，返回包含 `hooks`（5个）、`tools`（6个）、`commands`（1个）的插件对象，供 pi SDK 注册。

---

## License

MIT
