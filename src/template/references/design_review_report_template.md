<!--
  Design-review report template (193 contract + cross-round convergence). The
  trusted domain verifier enforces ALL of the following on this file, from ONE
  snapshot:

  * The four sections below (Summary, Recommendations, Verdict, Issues) are
    each MANDATORY and appear exactly once; their order does not matter;
    unfilled {placeholders} do not count as content.
  * The five identity rows must be copied verbatim from the spawn context
    (never from memory): a missing or differing row rejects the report.
    Canonical labels `**operation**` / `**input hash**` are shown; the
    legacy aliases `**operationId**` / `**baselinePlanHash**` also pass.
  * BLOCKING SET: the verdict is FAIL only when `## Issues` carries
    at least one BLOCKING issue (severity Blocker or High WITH Evidence).
    Medium/Low issues never fail the verdict — they enter the ledger as
    `open`. Exactly `None` (the whole entry) states "there are no issues".
    ISSUES TAKE PRECEDENCE: a blocking issue forces the verdict FAIL,
    whatever the conclusion line says.
  * Every issue row needs: `ID` (stable `DR-<round>-n`), `severity`
    (Blocker | High | Medium | Low), `evidence` (REQUIRED for
    Blocker/High — the failing command / assertion / commit) and `summary`.
  * CROSS-ROUND LEDGER: when the dispatch context injects
    previous-round open findings, every injected id MUST re-appear in
    `## Issue Ledger` with a legal status (`open`/`fixed`/`accepted-risk`/
    `carry-over`) — a missing id rejects the report as invalid.
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

## Issue Ledger

<!-- Full cross-round ledger. When the dispatch context injected a
     previous-round findings list, restate EVERY injected id here with its
     CURRENT status. `ID` is the stable issue id (`DR-<round>-n`, `LEGACY-n`
     once before the first legacy backfill), `origin` is the FIRST-SEEN round.
     Status vocabulary: open / fixed / accepted-risk / carry-over. Without
     injected findings this section stays empty (omit it). -->
| ID | Severity | Status | Evidence | Summary |
| --- | --- | --- | --- | --- |

## Issues

<!-- When there are NO issues, write exactly `None` as the only entry.
     `None` or ONLY Medium/Low entries mean PASS; a Blocker or High
     entry fails the verdict and requires an `Evidence` citation (the exact
     failing command, assertion or commit). Every entry needs a stable
     `ID` (`DR-<round>-n` — keep the SAME id across rounds for the same
     problem) and `Issues` carries only the NEW/unclosed items of THIS round. -->
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
