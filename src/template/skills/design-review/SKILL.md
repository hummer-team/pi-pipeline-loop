---
name: design-review
description: Translate whether the plan complies with the design and propose modification suggestions
userInvocable: false
disable-model-invocation: true
---

> Read and follow `references/review-loop-contract.md` (sections 2-4 and 8).

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
5. Identify non-cohesive, oversized and splittable phases, provide splitting suggestions
6. Check whether phase dependencies (preceding phases) are marked

### Verdict Rules
- The verdict criteria are defined by the contract
  `references/review-loop-contract.md` §2–§4 and this skill adds nothing to
  them: decide by the contract blocking set — a BLOCKING SET entry (severity
  Blocker or High WITH Evidence) fails the verdict; `None` or only
  Medium/Low entries means PASS
- Issue ids, severities, Evidence and the cross-round ledger are the
  contract §2/§4 schema; stable ids keep the SAME id across rounds

### Report Structure
Follow the template in `references/design_review_report_template.md`.
The rules are defined by the review loop contract
(`references/review-loop-contract.md`) §2–§4 — the single source of truth
for the issue schema, the verdict gate and the ledger. Host-specific items
for this line:
- Identity header rows (ALL required — canonical labels `**pipeline**`,
  `**plan**`, `**round**`, `**operation**` (alias `**operationId**`),
  `**input hash**` (alias `**baselinePlanHash**`)) — copied verbatim from
  the spawn context; a report that misses or differs on any of them is
  rejected by the plugin verifier
- The four sections `## Summary`, `## Recommendations`, `## Verdict`,
  `## Issues` are each MANDATORY and appear exactly once (order is free)
  with real content; the verdict markers are exactly `**Design Review: PASS**`
  or `**Design Review: FAIL**`
- `## Issues` carries the NEW/unclosed items of this round with stable ids
  (`DR-<round>-n`); when there are NO issues write exactly `None` as the
  single entry (partial phrases and empty sections do NOT count)
- `## Issue Ledger`: when the spawn context injected previous-round open
  findings, restate EVERY id with a legal status
  (`open`/`fixed`/`accepted-risk`/`carry-over`); a missing injected id
  rejects the report
- The plugin validates the report and routes the verdict; SMART mode ONLY:
  a FAIL verdict must carry exactly one `## Plan Revision Decision` section
  with `**action**` set to `revise-plan` or `request-human` and a real
  (non-placeholder) `**reason**` line; `proceed-develop` is never a valid
  action and PASS reports never carry it; smart mode NEVER releases a FAIL
  automatically and an authorization does NOT pre-approve any future FAIL

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
