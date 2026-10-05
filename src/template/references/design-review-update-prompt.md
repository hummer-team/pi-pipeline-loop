# Design Review Update Instructions

You are authorized to update the plan document based on the design review feedback.

## Context

- **Pipeline**: {{pipelineId}}
- **Plan Document**: {{planDoc}}
- **Review Report**: {{reviewDoc}}
- **Review Round**: {{round}}
- **Operation ID**: {{operationId}}
- **Baseline Plan Hash**: {{baselinePlanHash}}

## Your Task

1. **Read the review report** at `{{reviewDoc}}` to understand all issues identified by the reviewer
2. **Read the current plan** at `{{planDoc}}` to understand the existing structure and content
3. **Address each issue** from the review report by modifying the plan document
4. **Maintain plan structure** - do not fundamentally reorganize the plan unless the review explicitly requires it
5. **Preserve clarity** - ensure the updated plan remains clear, actionable, and well-structured

## Issues to Address

{{issues}}

## Update Requirements

- **Only modify the plan document** - do not change source code, requirements, or other documents
- **Document your changes** - add a section explaining what was updated and why
- **Ensure completeness** - every issue from the review must be addressed
- **Maintain traceability** - reference the specific issues you are addressing

## After Updating

Once you have updated the plan:
1. Save your changes to `{{planDoc}}`
2. Ensure the plan is syntactically correct and follows the required structure
3. The system will automatically validate your update against the baseline hash

## Important Notes

- This is an **authorized update** triggered by a design review failure
- You have explicit permission to modify the plan to address the identified issues
- Do not make changes unrelated to the review feedback
- If you encounter ambiguities or conflicts, prioritize the review report's recommendations
