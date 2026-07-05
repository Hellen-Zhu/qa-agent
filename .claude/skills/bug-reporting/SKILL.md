---
name: bug-reporting
description: This skill should be used when the user asks to "file a bug", "write a bug report", "report this issue", "how severe is this bug", or when a defect has been found and needs to be documented with severity, priority, and reproduction steps.
---

# Bug Reporting

A bug report has one job: let someone else reproduce and fix the defect without talking to the reporter. Reproduce-first, minimize, then write.

## Process

1. **Reproduce it twice** before writing anything. If it won't reproduce, report it as intermittent with frequency ("3 of 10 attempts") — never file a repro you haven't verified.
2. **Minimize.** Remove steps one at a time until the failure disappears; the last removed step is load-bearing. Shortest repro wins triage.
3. **Isolate the variable.** Does it fail in another browser? Another account? Another environment? Directly via API? Each answer halves the search space for the developer.
4. **Capture evidence at the moment of failure**: screenshot/video, console errors, failing network request (status + response body), server logs if accessible, timestamps.

## Template

```markdown
# <One line: what's broken, where, under what condition>
"Checkout total ignores discount code when user changes quantity after applying it"

**Severity:** S2 | **Priority:** P1 | **Environment:** staging, Chrome 138, build abc123
**Found via:** exploratory session / test case TC-014 / user report

## Steps to reproduce
1. Log in as standard user (test-user@example.com)
2. Add any item to cart, apply code SAVE10
3. Change item quantity to 2

## Expected
Total = (price × 2) − 10% discount

## Actual
Total = price × 2, discount silently dropped (no error shown)

## Evidence
- screenshot.png — cart state after step 3
- `POST /cart/update` returns 200 but response omits `discount` field

## Notes
- Reproduces 5/5 in Chrome and Firefox; API-level repro confirmed → backend, not UI
- Does NOT reproduce if quantity is changed before applying the code
```

## Severity vs priority

Severity = technical impact (fact). Priority = fix order (business decision). Set severity yourself; propose priority.

| | Definition | Example |
|---|---|---|
| **S1** | Data loss, security breach, crash, or blocker with no workaround | Payment charged twice |
| **S2** | Major function broken; workaround exists but painful | Discount dropped (refundable) |
| **S3** | Minor function broken or wrong; easy workaround | Sort order wrong on one page |
| **S4** | Cosmetic; no functional impact | Misaligned button |

Priority mismatches are legitimate: an S4 typo on the pricing page can be P1; an S2 crash in a deprecated feature can be P3. When they diverge, state why.

## Anti-patterns

- "It doesn't work" titles — the title must contain the *condition* that triggers the failure.
- Bundling multiple defects in one report — one bug, one report, always.
- Steps that assume state ("go to my cart") — start from a reproducible baseline (login, seed data).
- Filing judgment as fact — if it's a design disagreement, label it as such, not as a defect.
