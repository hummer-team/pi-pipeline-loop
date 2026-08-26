
# bug fix plan 模板
> 引用 <对应的bug描述文档>

**Bug**: 描述

**Root Cause**: 根因，代码文件，代码位置

**fix Design 核心描述**:
1. xx
2. xx


## Phase {x} — {xx}
**注意**：{x} 从0开始;{xx} 每个phase的标题，简明扼要

**标题**：xx

### 目标
xx
### 任务
1. xx
2. xx
### 验收
- `./mvnw clean compile` 零错误
- `./mvnw clean test` 全部通过（无新增测试，类型兼容验证）

### Commit 遵循规范
```
fix(domain): phase {x} - add BLOCKED status and optional/blockedReason fields to Task
```
注意：{x} 从0开始
