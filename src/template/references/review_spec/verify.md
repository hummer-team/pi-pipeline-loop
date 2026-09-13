---
rules:
  requiredFiles:
    - "docs/review/code_review_*.md"
  fileContentPattern:
    - path: "docs/review/code_review_*.md"
      pattern: "(结论\\s*[:：]\\s*[*_]{0,2}(不通过|通过)[*_]{0,2}|Verdict\\s*[:：]\\s*[*_]{0,2}(PASS|FAIL)[*_]{0,2}|Conclusion\\s*[:：]\\s*[*_]{0,2}(pass|fail)[*_]{0,2})"
    - path: "docs/review/code_review_*.md"
      pattern: "^\\*\\*pipeline\\*\\*:\\s*{pipelineId}$"
---
验证 code-review 报告已产出且结论明确（通过或不通过 / PASS/FAIL / pass/fail 任一形态即可），支持双语+加粗/斜体形态，且包含当前 pipelineId。
