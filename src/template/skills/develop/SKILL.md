---
name: develop
description: 资深AI Agent系统开发工程师 - 根据 plan 完成功能开发与单元测试（由 @develop-agent 执行）
userInvocable: false
---

## workflow
### phase 开发流程
1. 用户输入 `@develop-agent <plan文件路径>`
2. **前置校验**：
   - 检查规划文件是否存在，不存在则提示用户并终止。
   - 检查文件是否包含 `## Phase <index>` 章节，若无则提示"无效的规划文件"。
     - 举例：`Phase 0: xxx`、`Phase 1: xxx` 等。
3. **解析规划**：读取规划文件，理解所有 Phase 及其任务列表、验收标准。
4. git log check
    - 读取最近的git log已完成的功能，避免重复开发，确保持续开发
5. **按 Phase 渐进式开发**（Phase 编号从 0 开始）：
   - 按顺序依次执行每个 Phase。
   - 每个 Phase 完成后，向用户汇报进度（如"Phase 1/5 已完成"）。
   - 每个 Phase 执行后必须运行验收标准（`bun run build` + `bun run test`）确认通过。
     - 自动修复测试失败的问题
6. **每个phase完成后，必须**：
   - 必须按plan文档中commit内容提交代码
   - 新建`docs/design/{plan文件名}_commit.md`，把git commit id 追加到, 必须参考模板`@.opencode/references/develop_commit_template.md`
7. **所有phase完成后**，使用 `task` 工具启动独立的 code review 子 agent，参数设置：
    - `subagent_type`: "code-review-agent"
    - `prompt`: `code-review-agent {plan文件名}_commit.md`
    - 举例：`subagent_type: "code-review-agent"`, `prompt: "code-review-agent docs/design/04_feat_fn_ecom_fulfillment_efficiency_plan_commit.md"`
### 严禁 
跳过 Phase 或一次性实现多个 Phase。
### 交付规范
每次代码交付必须包含以下结构：
```
✅ 修改摘要：（1-3句话说明描述问题原因及修复思路）
✅ 影响范围：（列出修改的文件）
✅ 构建验证：（粘贴 bun build 成功输出）
✅ 测试用例：（列出 A/B/C 测试场景及预期结果）
⚠️ 已知风险：（如有潜在副作用，必须说明）
```
---
## 开发规范
### 0. 每个 phase 完成必须 commit，Git 规范
- 分支命名：`feature/xxx` / `fix/xxx`
- Commit 格式：`<type>(<scope>): <subject>`（type: feat/fix/docs/refactor/test/chore）
- 基于 `rebase main` 更新，冲突时**切勿自动强行合并**，必须报告并请求干预。

---
### 1. 通用技术原则
- `@.opencode/references/code_spec.md`
