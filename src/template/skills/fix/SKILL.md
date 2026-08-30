---
name: fix
description: Fix and optimize based on the review results
userInvocable: false
---
## workflow
1. 检查 `<code review file>` **Blocker**、**High**、**Medium** 的问题
2. 读取 `# Summary` 章节的 plan 文档
3. 获取代码修复上下文，**如果**你足够理解需要修复的问题，则进入代码修复阶段，**否则**输出"无法获取足够的上下文信息，请补充如：xx"等待用户补充上下文
4. **必须遵循以下步骤**：
   - 按问题逐个修复
   - 修复完成后，commit 代码，遵循 git commit 规范
   - 修改对应的问题 `是否修复` 状态为：`已修复`
5. **兜底规则**：若 `{plan}_commit.md` 不存在（develop 未创建），按 `develop_commit_template.md` 契约兜底创建并记录 dev commit id 后继续
6. **禁止**
   - 修改跟 **Blocker**、**High**、**Medium** 不相关的问题
