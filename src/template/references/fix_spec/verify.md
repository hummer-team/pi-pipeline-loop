---
rules:
  path: "docs/design/*_commit.md"
  groups:
    - name: commit-ready
      ruleMode: and
      rules:
        - type: requiredFile
        - type: fileContentPattern
          patterns: ["^\\*\\*plan doc\\*\\*:"]
        - type: fileContentPattern
          patterns: ["^\\*\\*pipeline\\*\\*:\\s*{pipelineId}$"]
        - type: requiredGit
          cleanWorkingTree: true
---
验证 fix 已产出提交记录文档（docs/design/*_commit.md），且引用了 plan doc 和当前 pipelineId。工作树必须干净（所有变更已提交）。
