---
name: test-plan-design
description: This skill should be used when the user asks to "create a test plan", "plan testing for a feature/release", "define test scope", "what should we test", or needs entry/exit criteria, risk assessment, or test-level allocation for upcoming work.
---

# Risk-Based Test Plan Design

Produce a test plan that concentrates effort where failure hurts most. A plan is a decision tool, not a compliance document: it must fit on one or two pages and every section must change someone's behavior.

## Process

1. **Understand the change.** Read the spec/PR/ticket. Identify what is new, what is modified, and what it touches indirectly (shared components, data migrations, integrations).
2. **Build the risk list.** For each area, score Likelihood (1-3: how likely is a defect — new code, complex logic, historically buggy area) × Impact (1-3: money, data loss, security, user trust). Sort descending. This ordering drives everything else.
3. **Allocate test levels.** For each risk, choose the *lowest* level that can catch it: unit → integration/API → UI E2E → manual/exploratory. Reserve UI automation for genuine user journeys; reserve manual effort for judgment-heavy checks (usability, visual, exploratory).
4. **Define scope explicitly.** "Out of scope" with a reason is as important as "in scope" — it makes residual risk a stakeholder decision instead of a surprise.
5. **Set entry and exit criteria.** Entry: what must be true to start (env ready, feature-flagged build, test data). Exit: what must be true to ship (all P1 cases pass, no open Sev1/Sev2, regression suite green).

## Template

```markdown
# Test Plan: <feature/release> — <date>

## Change summary
<2-3 sentences: what changes and why>

## Risks (ordered)
| # | Risk | L×I | Test level | Owner |
|---|------|-----|-----------|-------|
| 1 | Payment double-charge on retry | 3×3 | API + unit | |

## In scope
- <area>: <approach>

## Out of scope (accepted risk)
- <area>: <why it's acceptable>

## Environments & test data
<envs, accounts, seed data, feature flags>

## Entry criteria          ## Exit criteria
- <...>                    - <...>

## Schedule & effort
<who does what, rough sizing>
```

## Heuristics

- If everything is high priority, the risk analysis failed — force-rank until the top 3 are unambiguous.
- New integrations and data migrations are almost always the top risks; UI polish almost never is.
- One exploratory session (see `exploratory-testing` skill) belongs in nearly every plan — scripted cases only find what was anticipated.
- Plan regression scope using the `regression-ci-strategy` skill rather than re-listing old cases here.
- A plan nobody can execute is fiction: name owners and check entry criteria before committing to dates.
