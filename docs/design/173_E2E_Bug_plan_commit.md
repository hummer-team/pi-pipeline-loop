# plan & commit id's
**plan doc**: `docs/design/173_E2E_Bug_plan.md`

**dev commit id**: 5d4d54b,af15c5d,7cb0de8,73da6ad,7931bc2,2a724fe,ae6cf4d,5f1d4c8,0adbcde

**fix commit id**: 

---

## Phase 6 — E2E Re-verification Checklist

### Build Verification (Plugin Repository)
- `bun run build`: ✅ PASS
- `bun run typecheck`: ✅ PASS (0 errors)
- `bun run test`: ✅ PASS (1964 pass / 0 fail / 5021 expect / 80 files)
- Baseline floor: ≥1892 → Actual: 1964 (+72 from plan estimate)

### Phase Completion Summary

| Phase | Commit | Description | Tests Added | Cumulative |
|-------|--------|-------------|-------------|------------|
| P0 | `5d4d54b` | C1: restart registry rebind + timer cleanup | +6 | 1907 |
| P1 | `af15c5d` | C7: owner-only menu gate + retry self-destruct + C10③ text unification | +10 | 1911 |
| P2a | `7cb0de8` | C2: dormant predicate + C6: no-meta guards (14 surfaces) | +22 | 1933 |
| P2b | `73da6ad` | C4: V1 auto-creation removed + C3: dormant matrix activated + D2: completed wake-up | 0 (rewrites) | 1933 |
| P3 (spike) | `7931bc2` | U3/U4 feasibility conclusions | 0 | 1933 |
| P3 (impl) | `2a724fe` | C8: frozen menu replay + C9: choose_stage + C10④ audit truthfulness | 0 (rewrites) | 1933 |
| P4 | `ae6cf4d` | C11: tri-state protect-ask + dismissCount overflow guardrail | +15 | 1948 |
| P5 | `5f1d4c8` | C13/C14/C15/C16/C17: template + drift + spawnTrigger + guide + SKILL | +16 | 1964 |

### Business-Side Actions (User Manual — C12)
The following actions must be performed by the user on the business project:
1. Delete all 5 `stages.*.allowedWritePaths` entries from `pipeline_loop.json`
2. Set `protect.allow: ["docs/"]` to enable gitignore exemption for docs
3. Run `/reload` to apply changes
4. Run `/pipeline-init` to deploy updated guide/SKILL/templates (drift → 0)

### E2E Scenario Verification (To be filled by user after business-side actions)

| # | Scenario | Expected Result | Status | Notes |
|---|----------|----------------|--------|-------|
| ① | Reload with frozen pipeline | Decision menu visible and selectable (owner-only) | ⏳ Pending | C8 replay |
| ② | Restart decision → subagent spawn | Subagent JOIN resolves to new pipeline (not old frozen) | ⏳ Pending | C1 rebind |
| ③ | choose_stage from develop | Select review → summaries skipped, audit choose_stage | ⏳ Pending | C9 inference |
| ④ | New session without /pipeline-start | Zero interception, zero notification (dormant silent) | ⏳ Pending | C3 matrix |
| ⑤ | /pipeline-quit + 3 rounds chat | Zero interception, zero notification | ⏳ Pending | C5 quit silent |
| ⑥ | C12生效后跨阶段写路径 | develop写src/✓ docs/✓ .pi/✗; clarify写docs/✓ | ⏳ Pending | C12 manual |

### 🔴-1 Pre-check Confirmation
- [ ] User acknowledges: dormant sessions bypass ALL protection chains (protect/gitignore/blacklist)
- [ ] User acknowledges: dangerous commands rely solely on pi SDK permission layer
- [ ] User acknowledges: rollback switch `DORMANT_KEEP_PROTECTION=true` available if needed

### 🔴-2 Boundary Confirmation
- [ ] Startup with running zombie → stale_startup abort (171 matrix h unchanged)
- [ ] Startup with blocked/awaiting_human → frozen menu replay (NOT abort)
