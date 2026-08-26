---
rules:
  requiredFiles:
    - "docs/design/*_commit.md"
  fileContentPattern:
    - path: "docs/design/*_commit.md"
      pattern: "^\\*\\*plan doc\\*\\*:"
---
验证 fix 已产出提交记录文档（docs/design/*_commit.md），且引用了 plan doc。
