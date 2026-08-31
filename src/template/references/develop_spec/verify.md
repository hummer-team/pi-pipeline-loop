---
rules:
  requiredFiles:
    - "docs/design/*_commit.md"
  fileContentPattern:
    - path: "docs/design/*_commit.md"
      pattern: "^\\*\\*plan doc\\*\\*:"
    - path: "docs/design/*_commit.md"
      pattern: "^\\*\\*pipeline\\*\\*:\\s*{pipelineId}$"
---
验证 develop 已产出提交记录文档（docs/design/*_commit.md），且引用了 plan doc 和当前 pipelineId。
