---
rules:
  path: "docs/design/review-design-*-*.md"
  groups:
    - name: design-review-report-ready
      ruleMode: and
      rules:
        - type: requiredFile
        - type: fileContentPattern
          mode: or
          runtime: verdict
          patterns:
            - "结论\\s*[:：]\\s*[*_]{0,2}(不通过|通过)[*_]{0,2}"
            - "Verdict\\s*[:：]\\s*[*_]{0,2}(PASS|FAIL)[*_]{0,2}"
            - "Conclusion\\s*[:：]\\s*[*_]{0,2}(pass|fail)[*_]{0,2}"
            - "\\*\\*Design Review:\\s*(PASS|FAIL)\\*\\*"
            - "\\*\\*设计评审[:：]\\s*(通过|不通过)\\*\\*"
        - type: fileContentPattern
          patterns: ["^\\*\\*pipeline\\*\\*:\\s*{pipelineId}$"]
        # 192 Phase 5: full identity binding (declaration is behavior). The
        # trusted domain verifier enforces these same fields from ONE snapshot.
        - type: fileContentPattern
          patterns: ["^\\*\\*plan\\*\\*:\\s*{planDoc}$"]
        - type: fileContentPattern
          patterns: ["^\\*\\*round\\*\\*:\\s*{round}$"]
        # issueHeading anchor: the parser consumes items from this section only
        - type: fileContentPattern
          runtime: issueHeading
          patterns: ["^##\\s+Issues\\s*$"]
---
验证 design-review 报告已产出且结论明确（通过或不通过 / PASS/FAIL / pass/fail 任一形态即可），支持双语+加粗/斜体形态；192 Phase 5 起 groups 同时校验完整身份绑定（pipeline / plan / round / operationId / baselinePlanHash）与 `runtime: issueHeading` 锚点。可信语义判定（问题优先、互斥结论、代码块排除）由 design-review 领域校验器对同一快照执行。
