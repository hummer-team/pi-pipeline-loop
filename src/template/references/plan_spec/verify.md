---
rules:
  path: "docs/design/*_plan.md"
  groups:
    - name: plan-ready
      ruleMode: and
      rules:
        - type: requiredFile
        - type: fileContentPattern
          patterns: ["^## (用户确认|User Confirmation)"]
---
验证 design-plan 已产出规划文档（docs/design/*_plan.md），且包含双语用户确认标记（## 用户确认 或 ## User Confirmation）。用户确认标记节点由 confirm gate 在 plan 阶段按需 defer。
