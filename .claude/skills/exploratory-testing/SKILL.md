---
name: exploratory-testing
description: This skill should be used when the user asks to "explore a feature", "do exploratory testing", "hunt for edge cases", "poke at this before release", or wants unscripted, session-based investigation of an app to find defects scripted cases miss.
---

# Exploratory Testing

Exploratory testing is simultaneous learning, test design, and execution — structured by charters and time-boxes, not scripts. It finds the bugs nobody thought to write cases for.

## Session structure

1. **Write a charter** — one sentence scoping the mission:
   > Explore *<target area>* with *<resources/constraints>* to discover *<information sought>*.
   > "Explore checkout with an expired-card account to discover payment error handling gaps."
2. **Time-box**: 45-90 minutes, single charter. Off-charter discoveries get noted and become new charters, not detours.
3. **Take notes as you go** (template below) — a session without notes is just clicking around.
4. **Debrief**: bugs found, coverage achieved, risks remaining, new charters spawned.

## Generating charters: SFDIPOT

Walk the product through each lens; each cell that matters becomes a charter.

| Lens | Ask |
|---|---|
| **S**tructure | What is it made of? (pages, components, services, files) |
| **F**unction | What does it do? Especially interactions between functions |
| **D**ata | What does it consume/produce? Extremes, invalid, lifecycle (create→archive→delete) |
| **I**nterfaces | APIs, imports/exports, integrations, deep links |
| **P**latform | Browsers, devices, OS, screen sizes, locales/timezones |
| **O**perations | Who uses it, how, under what real conditions? (slow network, interruptions) |
| **T**ime | Timeouts, expiry, concurrency, DST, month/year boundaries, "what if I wait?" |

## Tours — ready-made exploration strategies

- **Interruption tour**: start every flow, then interrupt it — back button, refresh, close tab, session expiry, network drop mid-submit.
- **Data-extremes tour**: everywhere input is accepted, feed the dirty dozen (see `test-case-writing` skill's error-guessing list).
- **Landmark tour**: hit every primary feature in realistic sequence, as a new user would.
- **Saboteur tour**: try to corrupt state — double-submit, edit the same record in two tabs, replay a completed action, manipulate URL parameters.
- **Neglected-paths tour**: settings pages, empty states, first-run experience, error pages — where nobody looks and bugs accumulate.

## Session notes template

```markdown
# Session: <charter>
**Date/build:** | **Duration:** | **Tester:**

## Path taken
- <timestamped notes of what was tried and observed>

## Bugs  → file each via `bug-reporting` skill
- <one line + report link>

## Questions / spec ambiguities
- <things that need a product decision>

## Coverage & risk
Touched: <...> | Not touched: <...> | Feels risky: <...>

## New charters spawned
- <...>
```

## Heuristics

- Follow the smell: when something is *slightly* off (slow, flickers, odd wording), dig — minor symptoms cluster around major defects.
- Vary one thing at a time when investigating; vary wildly when hunting.
- The most valuable finds are often not bugs but wrong assumptions in the spec — report those too.
- If 90 minutes yields zero findings, the charter is too shallow or the area genuinely solid — say which, with evidence.
