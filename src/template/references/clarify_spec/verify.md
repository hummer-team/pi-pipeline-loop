---
rules:
  fileContentPattern:
    - path: "{requirementDoc}"
      pattern: "full-und\\? 理解确认：是"
---
等待用户输入 full-und? 询问是否完全理解需求；模型确认理解后须在需求文档末尾写入"## 模型确认"标记节。
