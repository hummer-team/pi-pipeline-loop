<!--
  Design-review report template (193 contract). The trusted domain verifier
  enforces ALL of the following on this file, from ONE snapshot:

  * The four sections below (Summary, Recommendations, Verdict, Issues) are
    each MANDATORY and appear exactly once; their order does not matter;
    unfilled {placeholders} do not count as content.
  * The five identity rows must be copied verbatim from the spawn context
    (never from memory): a missing or differing row rejects the report.
    Canonical labels `**operation**` / `**input hash**` are shown; the
    legacy aliases `**operationId**` / `**baselinePlanHash**` also pass.
  * ISSUES TAKE PRECEDENCE: any valid entry under `## Issues` forces the
    verdict FAIL, whatever the conclusion line says. Exactly `None` (the
    whole entry) is the only way to state "there are no issues".
  * This report is the ONLY file the reviewer may write or edit. The
    reviewer never approves a stage or routes its own verdict — the plugin
    validates the report and performs every transition.
-->

# Design Review Report

**pipeline**: {pipelineId}
**plan**: {planDoc}
**round**: {round}
**operation**: {operationId}
**input hash**: {baselinePlanHash}

## Summary

{summary}

## Recommendations

{recommendations}

## Verdict

**Design Review: {verdict}**

{verdictReason}

## Issues

<!-- When there are NO issues, write exactly `None` as the only entry.
     Any real issue listed below forces the verdict to FAIL — severity
     labels are informational and never relax this rule. -->
{issues}

<!--
  OPTIONAL — SMART confirmation mode, FAIL verdict ONLY.
  This is an INERT EXAMPLE: keep it inside this comment unless BOTH
  conditions hold (confirmation mode is smart AND the verdict is FAIL).
  PASS reports and auto/manual mode reports MUST NOT contain a Plan
  Revision Decision section — its presence there rejects the report.
  `**action**` accepts ONLY `revise-plan` or `request-human`
  (`proceed-develop` is never valid — smart does not release a FAIL).
  `**reason**` must be a real justification, never template text.

  ## Plan Revision Decision

  **action**: revise-plan
  **reason**: <replace this line with one real justification>
-->
