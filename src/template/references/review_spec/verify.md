---
rules:
  requiredFiles:
    - "docs/review/code_review_*.md"
  fileContentPattern:
    - path: "docs/review/code_review_*.md"
      pattern: "结论：(通过|不通过)"
    - path: "docs/review/code_review_*.md"
      pattern: "^\\*\\*pipeline\\*\\*:\\s*{pipelineId}$"
---
验证 code-review 报告已产出且结论明确（通过或不通过），且包含当前 pipelineId。
