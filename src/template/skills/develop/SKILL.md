---
name: develop
description: Complete phase‑feature development and unit testing according to the plan.
userInvocable: false
---

## workflow
### 必须遵循
1. **plan** 严格遵循 plan doc Phase 顺序完成规划的所有任务(不能跳跃，遗漏)
2. **技术规范**：read `.pi/references/{stack}_code_spec.md`（`{stack}` 见交付项 Template-TODO 占位）

### phase 开发流程
1. **前置校验**：
   - 检查规划文件是否存在，不存在则提示用户并终止。
   - 检查文件是否包含 `## Phase <index>` 章节，若无则提示"无效的规划文件"。
     - 举例：`Phase 0: xxx`、`Phase 1: xxx` 等。
2. **解析规划**：读取规划文件，理解所有 Phase 及其任务列表、验收标准。
3. git log check
    - 读取最近的git log已完成的功能，避免重复开发，确保持续开发
4. **按 Phase 渐进式开发**（Phase 编号从 0 开始）：
   - 按顺序依次执行每个 Phase。
   - 每个 Phase 完成后，向用户汇报进度（如"Phase 1/5 已完成"）。
   - 每个 Phase 执行后必须运行项目构建与单元测试命令（以项目实际技术栈为准）确认通过。
     - 自动修复测试失败的问题
5. **每个 phase 完成后，必须**：
   - 按 plan 文档中 commit 内容提交代码
   - 参考模板 `@.pi/references/develop_commit_template.md`
    - 新建 `docs/design/{plan文件名}_commit.md`，把 git commit id 追加到 `dev commit id` 行
6. **声明式交接**：开发交付完成（`_commit.md` 已建）后进入 review 阶段

### 交付规范
每次代码交付必须包含以下结构：
```
✅ 修改摘要：（1-3句话说明描述问题原因及修复思路）
✅ 影响范围：（列出修改的文件）
✅ 构建验证：（粘贴项目构建命令成功输出）
✅ 测试用例：（列出 A/B/C 测试场景及预期结果）
⚠️ 已知风险：（如有潜在副作用，必须说明）
```
---
## 交付项
<!-- Template-TODO: 补充项目业务交付项（插件默认交付项如 build/test/commit/pipeline 标记由插件注入段提供） -->
- **Template-TODO**: 补充项目特有的业务交付项（例如：生成 API 文档、更新 CHANGELOG 等）
<!-- Template-TODO: 配置项目技术栈 stack（如 frontend_ts / java），develop 按 .pi/references/{stack}_code_spec.md 读取对应规范 -->
