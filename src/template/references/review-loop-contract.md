# Review Loop Contract

> Single semantic source for the "find issues → fix issues → re-check" review loop
> (plan review ↔ plan revision; code review ↔ code fix). Host-neutral: applies to
> any agent host. Where an automated runtime verifier exists, the verifier's
> decision is authoritative and the prose here is its reference description.
> Sections are numbered 1–9; skills reference only the sections relevant to their
> stage and MUST NOT restate the rules inline.

## 1. Roles

- The review loop MUST use exactly three roles with separated authority:
  - **Finder** — reviews an artifact (plan, design, or code) and writes only its
    own round report.
  - **Fixer** — resolves reported issues by editing source code (or, for plan
    revisions, the plan) and writes only whitelisted report fields.
  - **Orchestrator** — dispatches the next stage and accepts/rejects round
    outputs before any onward dispatch.
- A role MUST NOT review its own work or fix its own findings: self-review and
  self-fix are both prohibited.
- The Finder MUST NOT modify the reviewed plan, the requirement document, or any
  source code; it writes only its round report (plus the plan-revision decision
  line required by Section 3/5.2 routing on FAIL).
- The Fixer MUST write only: whitelisted fields of the previous round's report
  (e.g. issue `Status` and evidence-of-fix fields) and the source code.
  All other report content MUST NOT be edited by the Fixer.

## 2. Issue Schema

Every issue listed in a round report MUST carry all of these fields:

| Field | Rule |
|---|---|
| `ID` | Stable identifier, see Section 4. MUST be unique within a round and stable across rounds. |
| `Severity` | MUST be one of `Blocker`, `High`, `Medium`, `Low`. |
| `Evidence` | MUST be a precise command, failing assertion, log line, file/section reference, or commit. |
| `Status` | MUST be one of `open`, `fixed`, `accepted-risk`, `carry-over`. |
| `Summary` | One-sentence human-readable description of the issue. |

- `Blocker` and `High` issues MUST include `Evidence`. A `Blocker`/`High` entry
  without `Evidence` makes the report invalid.
- An issue missing `Severity` makes the report invalid.
- `Medium` and `Low` issues SHOULD include `Evidence` where available; they are
  recorded in the ledger but never block a verdict (Section 3).

## 3. Verdict Gate

- The round verdict MUST be decided solely by the **blocking set**: the issues
  whose `Severity` is `Blocker` or `High` and that carry `Evidence`.
- Blocking set non-empty ⇒ verdict is **FAIL**; blocking set empty (verdict
  `None`, or only `Medium`/`Low` issues) ⇒ verdict is **PASS**.
- Blocking issues take precedence over any summary or conclusion line: a PASS
  statement MUST NOT stand while an unresolved blocking issue is listed.
- On FAIL, the Finder MUST declare exactly one plan-revision decision under the
  heading `## Plan Revision Decision` with `**action**` set to exactly one of:
  - `revise-plan` — the orchestrator may dispatch an authorized plan update; or
  - `request-human` — a human must decide, no automated revision is allowed.
  The decision MUST include a real reason.
- On PASS, the report MUST NOT contain a `## Plan Revision Decision` section.

## 4. Issue Ledger

- Every round report MUST contain a section `## Issue Ledger` (a table mapping
  each issue to its current state).
- Each ledger row MUST repeat the schema of Section 2: `ID`, `Severity`,
  `Status` (one of `open` / `fixed` / `accepted-risk` / `carry-over`),
  `Evidence`, `Summary`.
- Issue identifiers MUST be stable and round-scoped:
  - Plan review issues: `DR-<round>-<n>` (e.g. `DR-2-1` is the first issue found
    in design-review round 2).
  - Code review issues: `CR-<round>-<n>`.
  - `<n>` increments within the round; the same issue MUST keep the same id
    across rounds — renumbering a previously reported id across rounds is
    prohibited.
- The next round's report MUST restate the current status of every issue id that
  was injected into it by the orchestrator. A report that fails to restate an
  injected id is invalid.
- New issues discovered in round *r* MUST be numbered `DR-<r>-1`, `DR-<r>-2`, …
  (or `CR-<r>-1`, …); they MUST NOT reuse or continue a previous round's
  numbering.

## 5. Fix Disposition

This section defines two **mutually exclusive** disposition vocabularies. They
MUST NOT be mixed: code fixes use Section 5.1 only; plan revisions use Section
5.2 only. Re-review checks dispositions against Section 5.2.

### 5.1 Code-fix dispositions (three values)

For every issue it treats, the Fixer MUST record exactly one disposition:

| Disposition | Meaning | Required content |
|---|---|---|
| `Fixed` / 已修复 | The issue is resolved in source code. | Fix evidence: commit id, changed file(s) or a re-run of the failing command. |
| `Disputed` / 争议 | The Fixer believes the finding is wrong or out of scope. | The dispute reason; disputes MUST be escalated to the orchestrator/human, never silently dropped. |
| `Accepted risk` / 接受风险 | The issue is real but intentionally not fixed now. | The accepted-risk justification and the owner. |

- The Fixer MUST NOT rewrite any field of the previous round's report other than
  the whitelisted disposition/status fields and their evidence. Writing other
  report content is prohibited.

### 5.2 Plan-revision dispositions (five values)

For an authorized plan revision, the revising role MUST produce a standalone
revision receipt containing exactly one line per injected issue id:

| Disposition | Meaning |
|---|---|
| `fixed` | The plan was changed so the issue no longer applies. |
| `deferred` | The issue is postponed to a later phase/plan; MUST state the deferred destination and follow-up handling. |
| `rejected` | The issue is declined; MUST state the reason and follow-up handling. MUST be promoted to `accepted-risk` (Section 5.1) or escalated to a human. |
| `new-decision` | The issue required a new product/technical decision; MUST reference the decision record. |
| `unfixable` | The issue cannot be resolved inside the plan; MUST state the blocking point. |

- Every injected id MUST appear in the receipt. Silently dropping an injected id
  is prohibited.
- Each line MUST carry `Evidence` (the plan section changed, or the reason
  text) for its disposition.

## 6. Convergence Gates

The orchestrator MUST evaluate three gates after every round; hitting any gate
stops the loop. The plan↔design-review loop and the review↔fix loop each count
their rounds independently.

| Gate | Trigger |
|---|---|
| Gate 1 — no progress on blocking set | `openBlocking` did not decrease in 2 consecutive rounds. |
| Gate 2 — identical evidence reproduced | The same issue id reproduces with the same `Evidence` in 2 consecutive rounds. |
| Gate 3 — hard round budget | The accumulated rounds of one loop reach 3. |

- `openBlocking` is computed by the orchestrator from the round report's
  `## Issue Ledger`: the number of ledger rows whose `Status` is `open` and
  whose `Severity` is `Blocker` or `High`.
- A report with a missing or unparsable `## Issue Ledger` is **contract-invalid**:
  the orchestrator MUST send it back once with the validation feedback and, on a
  second failure, escalate to a human. It MUST NOT be silently passed through
  and MUST NOT auto-advance the stage.
- On hitting any gate, the orchestrator MUST stop the loop and output the
  remaining blocking issues together with one recommended exit: `revise-plan`
  (plan loop only), `request-human`, or `advance` (accept the remaining items as
  `accepted-risk`). Hosts with a runtime loop controller MUST implement the same
  three triggers with the same computation and take the exit per their runtime
  configuration.

## 7. Dispatch Ownership

- Only the Orchestrator dispatches a next stage. Skills/agents MUST NOT spawn
  the next stage themselves.
- Every review/fix skill/agent MUST return, as its final output, a verdict plus
  the recommended next stage (`nextStage`), and MUST NOT invoke, spawn, or
  otherwise trigger the downstream stage directly.
- The dispatch payload MAY carry: the expected output path for the round, the
  list of injected open issue ids from the previous round, and the scope for
  this round.
- The payload MUST NOT override a business output path that belongs to the
  artifact being produced, and MUST NOT contain file/line-level implementation
  instructions for the dispatched role.

## 8. Artifacts

Round artifacts live in the project's design directory (default `docs/design/`)
or the project's review directory, as named below. When the dispatch payload
carries an explicit output path, it takes precedence.

| Loop | Artifact | Location |
|---|---|---|
| Plan review | `Design_Review_{index}_{reqBase}_Design.md` | design directory |
| Plan revision receipt | `Design_Review_Update_{index}_{operationId}_{reqBase}_Design.md` | design directory |
| Code review | `Code_Review_{reqBase}_Develop_Commit_{index}.md` | review directory |

- `{index}` is the round number of the loop and MUST equal the `<round>` value
  inside the artifact's issue ids.
- `{reqBase}` is the requirement document's base name. Both plan-loop artifacts
  are derived from it — never from the plan document's base name: a name built
  from the plan file does not match the runtime reader and its ledger closure is
  skipped.
- The plan review report and the plan revision receipt are ONE family
  (`Design_Review_{index}_{reqBase}_Design.md` /
  `Design_Review_Update_{index}_{operationId}_{reqBase}_Design.md`) derived by
  the plugin from the round, the operation id and the requirement base name.
  Skills MUST NOT invent their own name: when the dispatch payload names the
  path, that path is authoritative.
- Old reports that predate this contract are legacy: they MUST NOT be migrated;
  a new round starts a fresh ledger.

## 9. Plan Contract

- Every plan phase MUST state testable acceptance criteria: at least one exact
  command and its expected result. Acceptance that cannot be executed or
  observed does not satisfy this section.
- "Target code snippet" content in a plan is illustrative only: it MUST NOT be
  treated as a verbatim implementation contract.
- If a decision required to write the plan is uncertain, the plan MUST NOT be
  produced; the uncertainty MUST go back to the clarification stage.
