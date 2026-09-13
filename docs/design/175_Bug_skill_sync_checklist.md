# 175_Bug — Business Skill Sync Checklist

> 本文档供用户手动更新业务项目 `.pi/` 目录下的 SKILL 和模板文件。
> 插件模板变更后，业务侧需要按需同步（重跑 `/pipeline-init` 或手工替换托管块）。

## 使用方式

1. 对照下方清单，检查业务项目 `.pi/` 目录下的对应文件
2. 按"建议操作"列执行更新
3. 更新后重跑 `/pipeline-init 0` 重新部署模板，或手工替换托管块内容

---

## 资产同步清单

| # | 资产路径 | 变更要点 (Phase 0-7) | 建议操作 |
|---|---------|---------------------|---------|
| 1 | `.pi/skills/design/SKILL.md` | 新增轮次标题契约说明（推荐 `# 第 N 轮澄清`，兼容 `# Round N`）；机读契约由插件托管块保障 | 重跑 `/pipeline-init 0` 或手工追加轮次标题契约节 |
| 2 | `.pi/skills/plan/SKILL.md` | 无结构性变更；托管块追加 plan 确认节 MUST | 重跑 `/pipeline-init 0` 更新托管块 |
| 3 | `.pi/skills/develop/SKILL.md` | 托管块追加 develop deliverable MUST（build/test/commit/pipeline header） | 重跑 `/pipeline-init 0` 更新托管块 |
| 4 | `.pi/skills/review/SKILL.md` | 托管块追加 review deliverable MUST（bilingual+bold tolerant verdict） | 重跑 `/pipeline-init 0` 更新托管块 |
| 5 | `.pi/skills/fix/SKILL.md` | 托管块追加 fix deliverable MUST（build/test/pipeline header） | 重跑 `/pipeline-init 0` 更新托管块 |
| 6 | `.pi/guide.md` | 新增 §16 verify 失败反馈通道 vs violations 熔断说明；protect/reload/resume 章节 | 重跑 `/pipeline-init 0`（guide.md 始终覆盖） |
| 7 | `.pi/references/clarify_template.md` | 默认模式切换为双语+加粗形态（bilingual round heading + answer field） | 重跑 `/pipeline-init 1` 重新生成 clarify_template |
| 8 | `.pi/references/pipeline-stage-prompt.yml` | stage_deliverable_* 增补双语契约 MUST；stage_executor_* 调度文本更新 | 重跑 `/pipeline-init 0` 覆盖 |

---

## 托管块说明

插件在 `/pipeline-init 0` 时会自动向 SKILL.md 文件追加托管块：

```
<!-- BEGIN pi-pipeline:managed-contract -->
# Plugin-Managed Contract ({stage})
> This section is auto-managed by pi-pipeline plugin. Do not edit manually.
- **MUST** ...
<!-- END pi-pipeline:managed-contract -->
```

- 托管块标记之间的内容由插件管理，用户不应手动编辑
- 重跑 `/pipeline-init 0` 时，托管块会原地更新（幂等）
- 托管块之外的用户自定义内容不受影响

---

## 基线参考

以下为插件模板各资产的基线 deployedHash（用于比对业务侧是否需要同步）：

| 资产 | 基线 deployedHash |
|------|------------------|
| design SKILL | f2a7b7db44a6 |
| plan SKILL | 7996c16c13ca |
| develop SKILL | a9a4b72f7283 |
| review SKILL | 0aad4fd9bd3c |
| fix SKILL | 16c4d56323b2 |
| guide.md | ee97392f3ea5 |
| clarify_template | e08920b424af |

> 注：以上 hash 为插件模板仓库的 git short hash，业务侧可通过 `git log --oneline` 对比。
