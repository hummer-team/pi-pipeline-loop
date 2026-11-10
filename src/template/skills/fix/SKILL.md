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
   - Update the `Fixed‑status` or `是否修复` field of corresponding issues to the THREE-VALUE vocabulary: `Fixed / 已修复`, `Disputed / 争议`, `Accepted risk / 接受风险` (a disputed row MUST be escalated to the owner — never silently resolved)
   - Fill the `证据` field of every touched issue with the EXACT failing command / assertion / commit id that proves the fix
   - The review report's other fields (finding text, `等级`, ids, plan/summary) are WRITE-PROTECTED for you: rewriting them outside the whitelist is a `fix_report_edit_violation` and refuses the stage exit
8. **Fallback rule**: If `{reqBase}_Develop_Commit.md` does not exist (not created during development), create it as a fallback per `develop_commit_template.md` contract, record the dev commit id, then continue. Reading the HISTORICAL issue ledger of the review file (previous rounds) IS allowed — the history informs only the fix, never a report rewrite.
9. **Forbidden**: Modify issues unrelated to pending fixes
