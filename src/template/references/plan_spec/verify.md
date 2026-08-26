---
rules:
  requiredFiles:
    - "docs/design/*_plan.md"
  fileContentPattern:
    - path: "docs/design/*_plan.md"
      pattern: "^## 用户确认"
---
验证 design-plan 已产出规划文档（docs/design/*_plan.md），且包含用户确认标记（## 用户确认）。
