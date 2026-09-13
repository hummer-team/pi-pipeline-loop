# plan & commit id's
**plan doc**: `docs/design/176_Feat_plan.md`

**dev commit id**: 5bcdc20,edddb9e,151a0ae,3b18f6c,0ae0678,cd42b83
**fix commit id**: 38ac894,36ff47e

## notes
- `5bcdc20` — prerequisite fix: removed a pre-existing stale assertion in
  `template-agent-contract.test.ts` (no template agent declares `permission`;
  the baseline suite was red before this plan's work started).
- `edddb9e` — Phase 0: verify-frontmatter groups/rule-node schema parsing.
- `151a0ae` — Phase 1: groups evaluation engine, when/scope, defer/placeholder
  penetration, and `[group:name][ruleType]` failure reflow.
- `3b18f6c` — Phase 2: contract-loader runtime anchors, clarify/review
  declaration-driven parsing, fail-open wiring, `CONTRACT_TOKENS` +
  `TEMPLATE_BUILTIN_CONTENT_PATTERNS` retirement, groups diagnosis codes.
- `0ae0678` — Phase 3: v6 clarify/plan/develop/review/fix verify.md templates,
  template structure + engine smoke tests, plan-marker defer contract, deploy
  content assertion.
- `cd42b83` — Phase 4: guide.md §9.4.B groups configuration reference (schema,
  scope enum, runtime warnings, behavior-change list), merge table groups row,
  guide content assertions, retired-reference comment cleanup.
