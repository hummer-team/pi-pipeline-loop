---
name: design-review
description: Translate whether the plan complies with the design and propose modification suggestions
userInvocable: false
disable-model-invocation: true
---

# Design Review Skill

This skill defines the design review stage of the pipeline, where plan documents are reviewed for completeness, consistency, and feasibility before proceeding to development.

## Stage: design-review

### Purpose
Validate the plan document against requirements and ensure it's ready for implementation.

### Entry Criteria
- Plan document exists and is complete
- Requirements document is available
- Previous stages (clarify, plan) have passed

### Exit Criteria
- Review report generated with clear verdict
- All issues documented with severity
- Recommendations provided
- Verdict is either PASS or FAIL

### Process
1. Agent reads the plan document
2. Agent analyzes plan against requirements
3. Agent identifies issues and risks
4. Agent generates structured review report
5. Plugin validates report and determines verdict
6. If PASS: proceed to develop stage
7. If FAIL: return to plan stage for revision

### Verdict Rules
- **PASS**: No Blocker or High severity issues
- **FAIL**: Any Blocker or High severity issues present

### Report Structure
Follow the template in `references/design_review_report_template.md`:
- Identity header rows (ALL required, exact labels): `**pipeline**`, `**plan**`,
  `**round**`, `**operationId**`, `**baselinePlanHash**` — they bind the report to
  the current review operation and plan version; a report that misses or differs
  on any of them is rejected by the plugin verifier
- Summary section
- Issues section (`## Issues`): one entry per problem; when there are NO issues
  write exactly `None` as the single entry (partial phrases do not count)
- Recommendations section
- Verdict section (with exact markers): `**Design Review: PASS**` or
  `**Design Review: FAIL**`
- Valid Issues entries take precedence: a PASS verdict alongside non-empty
  Issues is FAILed by the verifier

### Tools
- read: Read plan and requirements documents
- grep: Search for specific patterns
- find: Locate files
- ls: List directory contents

### Constraints
- Read-only: Do not modify any files
- No build commands
- No code changes
- Focus on design quality, not implementation
