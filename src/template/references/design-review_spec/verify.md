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
        # 193 Phase 0: the report must be a COMPLETE report — all four sections
        # are declared here (the trusted domain verifier enforces the same shape
        # plus substantive content from ONE snapshot).
        - type: fileContentPattern
          patterns: ["^##\\s+(Summary|摘要)\\s*$"]
        - type: fileContentPattern
          patterns: ["^##\\s+(Recommendations|建议)\\s*$"]
        - type: fileContentPattern
          patterns: ["^##\\s+(Verdict|结论)\\s*$"]
        # issueHeading anchor: the parser consumes items from this section only
        - type: fileContentPattern
          runtime: issueHeading
          patterns: ["^##\\s+Issues\\s*$"]
---
验证 design-review 报告已产出且结论明确（通过或不通过 / PASS/FAIL / pass/fail 任一形态即可），支持双语+加粗/斜体形态。groups 无条件校验完整身份绑定（pipeline / plan / round / operationId / baselinePlanHash，占位符仅由权威会话状态替换，无法解析时直接判失败）与 `runtime: issueHeading` 锚点；活跃 design-review 上下文中，groups 与领域校验器共享同一份精确路径快照（单一读取，无双读窗口）。可信语义判定（问题优先、互斥结论、代码块/引用/注释排除）由 design-review 领域校验器对同一快照执行。

193 Phase 0（完整报告契约）：报告必须同时具备四个章节标题——`## Summary`（摘要）、`## Issues`（问题）、`## Recommendations`（建议）、`## Verdict`（结论），每个章节恰好出现一次、顺序不限、大小写与空格不敏感，且必须包含实质内容（空行、未填充的 `{placeholder}`、代码块、引用块与 HTML 注释均不计入实质内容）。`## Issues` 无问题时必须恰好写 `None`，空白 Issues 章节永远不代表“无问题”。章节结构由领域校验器在同一快照上强制执行；上述 groups 仅声明标题存在性。身份不匹配、结构不完整或结论不明确的报告一律判定为**无效交付物**（仅可修正），绝不作为评审结论路由到 develop。
