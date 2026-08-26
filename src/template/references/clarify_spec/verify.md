---
rules:
  fileContentPattern:
    - path: "{requirementDoc}"
      pattern: "full-und\\? 理解确认：是"
    - path: "{requirementDoc}"
      pattern: "(?<![\\s\\S])(?![\\s\\S]*?^# 第 \\d+ 轮澄清(?![^]*?^- \\*{0,2}方案 [A-Z]))(?![\\s\\S]*?^# 第 \\d+ 轮澄清(?![^]*?^答：))"
---
等待用户输入 full-und? 询问是否完全理解需求；模型确认理解后须在需求文档末尾写入"## 模型确认"标记节。澄清节（含 `# 第 N 轮澄清`）必须包含方案推荐（`- 方案 [A-Z]`）与用户答复（`答：`）。
