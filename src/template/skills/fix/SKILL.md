---
name: fix
description: typescript代码优化 - 针对review结果进行优化（由 @code-review-withfix-agent 执行）
userInvocable: false
---
## workflow
1. 由subagent`code-review-agent`触发并传入code review 上下文，如：`code-review-withfix-agent <code review file>`
2. 检查`<code review file>`**Blocker**,**High**的问题
3. 读取`# Summary`章节的的plan文档
4. 获取代码修复上下文，**如果**你足够理解需要修复的问题，则进入代码修复阶段，**否则**输出，"无法获取足够的上下文信息，请补充如：xx"等待用户补充上下文
5. **必须遵循以下步骤**，
   - 按问题逐个修复
   - 修复完成必须通过`bun run build`并且`bun run test`
   - 修复完成后，commit代码，遵循git commit规范，模板：
   ```
   fix(code review): <描述修复的问题>
   ``` 
   - 修改对应的问题`是否修复`状态为：`已修复`
6. **修复验证（触发 review 循环）**：
   - 所有 Blocker/High 问题修复完成后，从 `<code review file>` 的 `# Summary` 章节提取 plan 文件路径
   - plan 对应的 commit 文件为 `{plan路径}_commit.md`
   - **自动调用** `compact`工具完成上下文压缩，命令：`/compact save code fix context`
   - **自动使用** `task` 工具启动 code review 子 agent 重新验证，参数设置：
     - `subagent_type`: "code-review-agent"
     - `prompt`: `code-review-agent {plan路径}_commit.md`
   - 举例：`subagent_type: "code-review-agent"`, `prompt: "code-review-agent docs/design/04_feat_fn_ecom_fulfillment_efficiency_plan_commit.md"`
7. **循环终止条件**：
   - code-review 再次触发后若仍存在 Blocker/High 问题，则自动再次进入修复循环
   - 最多循环 3 轮，超过 3 轮仍未通过则输出 `修复循环已达上限，请人工介入` 并终止
8. **禁止**
   - 修改跟**Blocker**,**High**不相关的问题
