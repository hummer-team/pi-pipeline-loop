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
- Review report generated at the path given in the spawn context
- Every identified issue documented under `## Issues` (exactly `None` when there are none)
- Recommendations provided
- Verdict is either PASS or FAIL

### Process
1. Read the plan document and the requirement document
2. Analyze the plan against requirements; identify issues and risks
3. Write the CURRENT review report following the template contract below
4. STOP — the plugin validates the report and routes the verdict:
   - a trusted, contract-complete PASS → proceeds to develop automatically in EVERY mode
   - a valid FAIL → handled by the configured confirmation mode:
     - auto: an authorized plan-revision pass, then the new plan is re-reviewed
     - manual: the human decision menu (Revise Plan / Proceed to Develop / Cancel)
     - smart: your declared binary action — `revise-plan` or `request-human`;
       smart mode NEVER releases a FAIL automatically
   - an initial stage-entry authorization does NOT pre-approve any future FAIL

### Verdict Rules
- ISSUES TAKE PRECEDENCE: ANY valid entry under `## Issues` means FAIL,
  regardless of severity labels or the conclusion line
- PASS requires the `## Issues` section to contain exactly `None`
- Severity labels may annotate issues for the reader; they never change the
  verdict rule above

### Report Structure
Follow the template in `references/design_review_report_template.md`:
- Identity header rows (ALL required — canonical labels `**pipeline**`,
  `**plan**`, `**round**`, `**operation**` (alias `**operationId**`),
  `**input hash**` (alias `**baselinePlanHash**`)) — copied verbatim from
  the spawn context; a report that misses or differs on any of them is
  rejected by the plugin verifier
- The four sections `## Summary`, `## Recommendations`, `## Verdict`,
  `## Issues` — each present exactly once (order is free) with real content
- Verdict section (with exact markers): `**Design Review: PASS**` or
  `**Design Review: FAIL**`
- `## Issues`: one entry per problem; when there are NO issues write exactly
  `None` as the single entry (partial phrases and empty sections do NOT count)
- Valid Issues entries take precedence: a PASS verdict alongside non-empty
  Issues is FAILed by the verifier
- SMART mode ONLY: a FAIL verdict must carry exactly one
  `## Plan Revision Decision` section with `**action**` set to `revise-plan`
  or `request-human` and a real (non-placeholder) `**reason**` line;
  `proceed-develop` is never a valid action and PASS reports never carry it

### Tools
- read/grep/find/ls: read documents (plan, requirements, existing reports)
- write/edit: ONLY the current review report file named in the spawn context

### Constraints
- Writable scope: the CURRENT review report and nothing else — never the
  plan document, the requirement document, or source code
- No build commands, no code changes
- Do NOT approve stages, call pipeline tools, or route your own verdict —
  the plugin owns validation and every transition
- Focus on design quality, not implementation
