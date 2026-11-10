# plan 模板
> 引用 <对应的功能需求文档>

## Summary
简明扼要描述解决的问题

## Phase {x} — {xx}
**注意**：{x} 从0开始;{xx} 每个phase的标题，简明扼要

**标题**：xx

### 目标
xx

### 任务
1. xx
2. xx
3. 
### 交付标准
- `build/compile` 零错误
- `test` 全部通过（无新增测试，类型兼容验证）

> 契约级验收断言（契约 §9）：每个 Phase 至少一条**精确命令 + 预期结果**；不可执行、不可观测的验收视为无效。
> "目标代码片段"仅为示意，不构成逐字实现契约。

### 单元测试目标，边界
<描述单元测试目标、边界：新增或修改的测试文件、要覆盖的行为、明确不覆盖的边界>

### Commit 遵循规范
```
feat(domain): phase {x} add BLOCKED status and optional/blockedReason fields to Task
```
