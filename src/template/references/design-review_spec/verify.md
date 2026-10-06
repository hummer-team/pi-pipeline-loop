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
        # 192 fix (issue 2): operation/input-hash binding rows, substituted from
        # the authoritative session state (fail-closed if unresolvable). Both
        # canonical labels and legacy aliases are accepted.
        - type: fileContentPattern
          patterns: ["^\\*\\*(?:operationId|operation)\\*\\*:\\s*{operationId}$"]
        - type: fileContentPattern
          patterns: ["^\\*\\*(?:baselinePlanHash|input hash)\\*\\*:\\s*{inputHash}$"]
        # issueHeading anchor: the parser consumes items from this section only
        - type: fileContentPattern
          runtime: issueHeading
          patterns: ["^##\\s+Issues\\s*$"]
---
验证 design-review 报告已产出且结论明确（通过或不通过 / PASS/FAIL / pass/fail 任一形态即可），支持双语+加粗/斜体形态。groups 无条件校验完整身份绑定（pipeline / plan / round / operationId / baselinePlanHash，占位符仅由权威会话状态替换，无法解析时直接判失败）与 `runtime: issueHeading` 锚点；活跃 design-review 上下文中，groups 与领域校验器共享同一份精确路径快照（单一读取，无双读窗口）。可信语义判定（问题优先、互斥结论、代码块/引用/注释排除）由 design-review 领域校验器对同一快照执行。
