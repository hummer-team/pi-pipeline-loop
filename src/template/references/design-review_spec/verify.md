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
        # plus substantive content from ONE snapshot). 193 fix (review issue 3):
        # the declared anchors mirror the domain contract's tolerance EXACTLY
        # (report-contract.ts): heading levels 1–4, canonical + Chinese aliases,
        # and — because the groups engine compiles these patterns with the "m"
        # flag only — case-insensitivity written inline. A heading the trusted
        # verifier accepts must never fail here, or the model would receive the
        # generic feedback instead of the complete-report correction template.
        - type: fileContentPattern
          patterns: ["^#{1,4}\\s*(?:[Ss][Uu][Mm][Mm][Aa][Rr][Yy]|摘要|总结)\\s*$"]
        - type: fileContentPattern
          patterns: ["^#{1,4}\\s*(?:[Rr][Ee][Cc][Oo][Mm][Mm][Ee][Nn][Dd][Aa][Tt][Ii][Oo][Nn][Ss]?|[Ss][Uu][Gg][Gg][Ee][Ss][Tt][Ii][Oo][Nn][Ss]?|修改建议|改进建议|建议)\\s*$"]
        - type: fileContentPattern
          patterns: ["^#{1,4}\\s*(?:[Vv][Ee][Rr][Dd][Ii][Cc][Tt]|[Cc][Oo][Nn][Cc][Ll][Uu][Ss][Ii][Oo][Nn]|结论|判定)\\s*$"]
        # issueHeading anchor: the parser consumes items from this section only
        # (same alias set and level tolerance as DEFAULT_ISSUE_HEADING_PATTERN).
        - type: fileContentPattern
          runtime: issueHeading
          patterns: ["^#{1,4}\\s*(?:[Ii][Ss][Ss][Uu][Ee][Ss]|问题列表|问题)\\s*$"]
---
验证 design-review 报告已产出且结论明确（通过或不通过 / PASS/FAIL / pass/fail 任一形态即可），支持双语+加粗/斜体形态。groups 无条件校验完整身份绑定（pipeline / plan / round / operationId / baselinePlanHash，占位符仅由权威会话状态替换，无法解析时直接判失败）与 `runtime: issueHeading` 锚点；活跃 design-review 上下文中，groups 与领域校验器共享同一份精确路径快照（单一读取，无双读窗口）。可信语义判定（问题优先、互斥结论、代码块/引用/注释排除）由 design-review 领域校验器对同一快照执行。

193 Phase 0（完整报告契约）：报告必须同时具备四个章节标题——`Summary`（摘要）、`Issues`（问题）、`Recommendations`（建议）、`Verdict`（结论），标题层级 `#`～`####` 任一即可（与领域校验器一致），每个章节恰好出现一次、顺序不限、大小写与空格不敏感，且必须包含实质内容（空行、未填充的 `{placeholder}`、代码块、引用块与 HTML 注释均不计入实质内容）。`## Issues` 无问题时必须恰好写 `None`，空白 Issues 章节永远不代表“无问题”。章节结构由领域校验器在同一快照上强制执行；上述 groups 仅声明标题存在性。身份不匹配、结构不完整或结论不明确的报告一律判定为**无效交付物**（仅可修正），绝不作为评审结论路由到 develop。

193 Phase 1 (conditional, NOT declared as a group above): when the design-review stage runs in SMART confirmation mode, a FAIL verdict must additionally carry EXACTLY ONE `## Plan Revision Decision` section with a binary `**action**: revise-plan | request-human` token and a non-empty, non-placeholder `**reason**` line, enforced by the domain verifier on the SAME snapshot. PASS reports never include this section; auto/manual modes ignore it; `proceed-develop` is not a valid action. A FAIL missing or malformed in this section is INVALID (correction), never routed.
