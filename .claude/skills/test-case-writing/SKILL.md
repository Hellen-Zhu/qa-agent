---
name: test-case-writing
description: This skill should be used when the user asks to "write test cases", "design test scenarios", "cover this feature with tests", "what edge cases should I test", or needs boundary analysis, equivalence partitioning, or Given/When/Then scenarios for a feature.
---

# Test Case Writing

Design test cases using systematic techniques, not enumeration by intuition. The goal is maximum defect-finding power per case: every case must be able to fail for a reason no other case covers.

## Design techniques — apply in this order

1. **Equivalence partitioning.** Split each input into classes the code should treat identically (valid, invalid, empty, wrong type). One case per class — more is waste.
2. **Boundary value analysis.** For every range or limit, test: minimum, minimum−1, maximum, maximum+1. Most off-by-one defects live here. Includes lengths (0, 1, max, max+1 characters) and collection sizes (empty, one, many, limit).
3. **Decision tables.** When behavior depends on combinations of conditions (role × state × flag), enumerate the table and collapse impossible/equivalent columns. This catches interaction bugs single-variable cases miss.
4. **State transitions.** For anything with a lifecycle (order, session, subscription): test each valid transition, and at least the plausible *invalid* transitions (cancel an already-shipped order).
5. **Error guessing — the standing dirty dozen:** empty/null, whitespace-only, unicode & emoji, very long input, SQL/HTML special characters (`' " < > &`), zero and negative numbers, duplicate submission (double-click), concurrent edit, expired session mid-flow, back-button after submit, slow network/timeout, permission-denied user.

## Case format

Use Given/When/Then with one behavior per case:

```markdown
### TC-014: Reject registration when email already exists [P1]
Given a registered user with email "a@b.com"
When a new registration is submitted with email "a@b.com" (any case variant)
Then the API returns 409 with error code EMAIL_TAKEN
And no new account or verification email is created
```

Rules:
- **Title states the expected behavior**, not the action ("Reject duplicate email", not "Test email field").
- **Then must be observable and specific** — status code, exact message, DB/UI state. "Works correctly" is not a result.
- **Assert the negative space too**: what must NOT happen (no email sent, no charge made).
- **Independent cases**: no case may depend on another case having run.

## Prioritization

- **P1** — core user journey or high-risk area (from the test plan's risk list); blocks release.
- **P2** — important variations and error handling; should pass before release.
- **P3** — rare edge cases and cosmetic checks; run when time allows.

Aim for a pyramid: if more than ~30% of cases are P1, priorities aren't real.

## Checklist before delivering

- [ ] Every input has partition + boundary cases; no partition tested twice
- [ ] Negative and permission cases exist, not just happy paths
- [ ] Each case's Then is concretely verifiable
- [ ] Cases marked for automation level (unit/API/UI) where relevant — see `ui-automation` / `api-testing` skills
