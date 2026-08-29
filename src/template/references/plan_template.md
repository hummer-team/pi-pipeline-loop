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

### Commit 遵循规范
```
feat(domain): phase {x} add BLOCKED status and optional/blockedReason fields to Task
```
