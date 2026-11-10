## Review 报告格式模板

```
**pipeline**: <当前 pipeline 的 pipelineId，从会话元数据获取>

# Summary
- Scope for this round: <本轮评审范围：commit 区间 + 文件清单>
- <plan文件路径>
- <简明扼要总结review范围>

## Review发现以下问题
### 问题 1
- ID: CR-<round>-1
- 问题: xx.ts:45-50 代码实现不全
- 等级：Blocker
- new / regression: new
- 符合规划：否
- 状态：待修复
- 证据：<命令 / 断言 / commit>
- 改进建议：再次根据规划实施 phase x

## Issue Ledger
| ID | 等级 | 状态 | 证据 | Summary |
| --- | --- | --- | --- | --- |

## 结论
- 结论：通过（或 不通过）

Open blocking: <n>
Open ids: <id,...|None>
```

## 字段契约（强制）

每个 `### 问题 N` 块必须固定携带以下字段，缺一即视为格式缺陷：

| 字段 | 取值 | 说明 |
|------|------|------|
| `ID` | `CR-<round>-<n>` | 稳定标识：同一问题在**跨轮**报告中必须复用同一 ID（`parseReviewFindings` 的无进展早停依赖该稳定性）；缺省 ID 会被机械生成为 `CR-<round>-<n>` |
| `问题` | 文本 | 缺陷描述（证据化：文件:行号 + 具体行为） |
| `等级` | `Blocker \| High \| Medium \| Low` | 必须可解析为这四个字面量之一；不可解析即视为格式缺陷 |
| `new / regression` | `new \| regression` | 本轮新引入 / 相对改动前是回归；`regression` 必须给出"改动前行为正常"的证据（契约 §2） |
| `符合规划` | `是 \| 否` | 是否与 plan 一致 |
| `状态` | `待修复 \| 已修复 \| 争议 \| 接受风险` | 三值修复词表以契约 §5.1（`references/review-loop-contract.md`，`Fixed/已修复`、`Disputed/争议`、`Accepted risk/接受风险`）为准 + `待修复`；`争议` 必须升级 owner |
| `证据` | 命令 / 断言 / commit | 证明缺陷存在或已修复的机械证据 |
| `改进建议` | 文本 | 可执行的修复方向 |

> `状态` 与 `证据` 是 fix 阶段**唯一**允许改写的行（`fix-report-edit-verifier` 的白名单）；
> 其余字段（`ID`/`问题`/`等级`/`new / regression`/`符合规划`/`改进建议`）在 fix 阶段**写保护**，
> 改动会触发 `fix_report_edit_violation` 并拒绝阶段前进。
>
> `## Issue Ledger` 必须重述编排者注入的上一轮全部 id 及其当前状态（契约 §4）；缺注入 id 即报告非法。
> `状态` 三值词表与 `新增/回归` 判定以契约 §2/§5.1 为准，本模板只规定字段位置。
>
> `Scope for this round`（`# Summary` 内）必须声明本轮评审的 commit 区间与文件清单；
> 声明范围之外的改动记为 `scope_violation`（等级 `High`，附章节/行号证据）。
>
> 报告末尾必须固定输出两行门数据（契约 §6），供编排者计算门 1/门 2：
> `Open blocking: <n>`（ledger 中 `状态` 为 `open` 且等级为 Blocker/High 的行数）与
> `Open ids: <id,...|None>`；缺任一行即视为格式缺陷，门 1/门 2 无法比较。