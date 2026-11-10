---
name: fix
description: Fix and optimize based on the review results
userInvocable: false
disable-model-invocation: true
---

> Read and follow `references/review-loop-contract.md` (sections 5.1 and 6).
## workflow
1. Use the review file path given in the task prompt; do not search `docs/review/` yourself.
2. Read the `# Summary` section of the plan document
3. Fetch the code‑fix context: the review file itself, plus the `plan doc` referenced in its `# Summary` section.
4. **Wait for user input only when a required input is missing** — specifically when the review file cannot be read, or the `plan doc` it 5. references does not exist. In that case output exactly `Insufficient context information, please supplement: <missing path>` and stop.
6. **In every other case the dispatch is already authorized.** Do not ask for confirmation, do not ask whether to proceed, and do not answer with a plan, a patch sketch, or a command list. Proceed straight through the code‑fix phase and the mandatory steps below until the fixes are committed and verified.
7. **Mandatory steps**:
   - Fix issues one‑by‑one
   - Commit code after fixes, complying with git commit conventions
   - After committing, copy the exact id git printed (e.g. via `git rev-parse HEAD`) into the doc's `**dev commit id**` line; NEVER invent, reuse or hand-edit a commit id; do NOT use `git add -f` and do NOT commit gitignored files
   - Dispositions follow the code-fix vocabulary of `references/review-loop-contract.md` §5.1 (`Fixed`, `Disputed`, `Accepted risk`) — record exactly one per treated issue together with its evidence
   - The previous review report stays write-protected outside the disposition/status fields and their evidence; a rewrite outside that whitelist is a `fix_report_edit_violation` and refuses the stage exit
8. **Return the loop status**: output `Remaining open blocking: <n>` and `Remaining ids: <id,...|None>`; the count is the round's `Open blocking` value that the orchestrator feeds into gates 1 and 2; if the SAME id reproduces with the SAME Evidence for two consecutive rounds, annotate `reproduced: <id>` and stop fixing further (the orchestrator decides `revise-plan` / `request-human` / `advance`, contract §6 gate 2). Do not re-dispatch the review.
9. **Fallback rule**: If `{reqBase}_Develop_Commit.md` does not exist (not created during development), create it as a fallback per `develop_commit_template.md` contract, record the dev commit id, then continue. Reading the HISTORICAL issue ledger of the review file (previous rounds) IS allowed — the history informs only the fix, never a report rewrite.
10. **Forbidden**: Modify issues unrelated to pending fixes
