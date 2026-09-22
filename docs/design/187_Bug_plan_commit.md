# 187 Bug Fix — Commit Summary

**plan doc**: `docs/design/187_Bug_plan.md`
**dev commit id**: 4424963,68a9121,b76d4f4,992a576,87c4e3f
**fix commit id**: 7536c2d,feab79e

## Phase 0 — 4424963
fix(shortcut): phase 0 remove shortcut registration block, DEFAULT_DECISION_SHORTCUT constant, and template key

## Phase 1 — 68a9121
fix(shortcut): phase 1 remove decisionShortcutKey types, config parsing, and update hint to /pipeline-resume

## Phase 2 — b76d4f4
test(shortcut): phase 2 remove shortcut tests, update hint assertions, clean decisionShortcutKey from fixtures

## Phase 3 — 992a576
fix(spawn): phase 3 add stage-consistency guard in consumePendingSpawns with stale_stage_mismatch audit

## Phase 4 — 87c4e3f
fix(spawn): phase 4 clean pendingSpawns at restart, buildStartMeta, and buildResumeMeta lifecycle entry points
