---
rules:
  path: "{requirementDoc}"
  groups:
    - name: round-well-formed
      when: "^#{1,2}\\s*(?:第\\s*(?<roundZh>\\d+)\\s*轮澄清|[Rr]ound\\s+(?<roundEn>\\d+))"
      runtime: roundHeading
      scope: section
      ruleMode: and
      rules:
        - type: fileContentPattern
          patterns: ["^[ \\t]*[-*][ \\t]*\\*{0,2}(?:方案|Option|Plan)[ \\t]*[A-Z]"]
          example: "- **方案 A：xxx**"
        - type: fileContentPattern
          mode: or
          runtime: answerField
          patterns:
            - "答\\s*[:：]|\\*{2}答\\*{2}"
            - "Answer\\s*:"
          example: "答：方案 A"
    - name: full-und-confirmed
      ruleMode: and
      rules:
        - type: fileContentPattern
          mode: or
          patterns:
            - "full-und\\? 理解确认：是"
            - "full-und\\? .*理解确认[:：]\\s*[*_]{0,2}(是|yes|Y)"
        - type: fileContentPattern
          mode: or
          runtime: modelConfirm
          patterns:
            - "^##\\s*模型确认"
            - "^##\\s*Model\\s+Confirmation"
---
澄清验证：等待用户输入 full-und? 询问是否完全理解需求；模型确认理解后须在需求文档末尾写入"## 模型确认"标记节（最终轮确认结果，只在本组求值，不逐轮检查）。澄清节（`# 第 N 轮澄清` 推荐，`# Round N` 兼容；`#{1,2}` 仅限 h1/h2 防误命中）必须逐节包含方案推荐（`- 方案 [A-Z]` / `- Option [A-Z]` / `- Plan [A-Z]`，容忍前导缩进（2/4 空格）与 `*` bullet、`- 方案A` 无空格、`**方案 X**` 加粗形态）与用户答复（`答：`/`答:`/`**答**`/`Answer:`，容忍前导缩进如 `  答：...`）。失败反馈在 detail 中追加规则 `example` 期望示例（`; expected: <example>`），便于模型一轮修复。
