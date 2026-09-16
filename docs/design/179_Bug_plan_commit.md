# plan & commit id's
**plan doc**: `docs/design/179_Bug_plan.md`

**dev commit id**: d6f7297,1d304ea,394f85c,578c111,cef17a1,cb6cbb9,f1ce67b
**fix commit id**: bd0886a,8759509,16870a4,e5ff7f7,5efb38f,fb9822d,9a03d6c

## E2E 部署清单（用户手动项，Phase 5 验收记录）

- `.pi/pipeline_loop.json` → `decisionShortcutKey: "ctrl+shift+u"`，并**整进程重启 pi**（顺带完成 G9 取证复验：`[Extension issues]` 应消失）。
- `.pi/subagents.json` → `agentMentions: "direct"`。
- E2E 场景回归（`pipl-integration`）：G2 命令行提示、G3 跨 stage 挂起、G4 缩进方案行 + `expected` 反馈、G5/G7 弹窗后置与 re-arm=3、G6 越权拦截、G8 链尾唤醒、G9 快捷键无冲突。
