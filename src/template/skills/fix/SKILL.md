---
name: fix
description: Fix and optimize based on the review results
userInvocable: false
disable-model-invocation: true
---
## workflow
1. Check `To‑Fix` or `待修复` status issues in `<code review file>`
2. Read the `# Summary` section of the plan document
3. Obtain code‑fix context. **If** you fully understand the issues to be fixed, proceed to code‑fix phase; **otherwise**, output "Insufficient context information. Please supplement details such as: xx" and wait for user input.
4. **Mandatory steps**:
   - Fix issues one‑by‑one
   - Commit code after fixes, complying with git commit conventions
   - Update the `Fixed‑status` or `是否修复` field of corresponding issues to: `Fixed` or `已修复`
5. **Fallback rule**: If `{plan}_commit.md` does not exist (not created during development), create it as a fallback per `develop_commit_template.md` contract, record the dev commit id, then continue.
6. **Forbidden**: Modify issues unrelated to pending fixes
