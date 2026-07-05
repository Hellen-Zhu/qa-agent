# QA Agent + Skills — Design

**Date:** 2026-07-05 · **Status:** Implemented

## Goal
A project-level `qa-agent` subagent representing a senior QA expert with hands-on functional and automation testing experience, backed by focused skills.

## Decisions
- **Location:** project-level, `.claude/agents/` + `.claude/skills/` in this repo (user choice).
- **Automation stack:** Playwright (TypeScript) for UI + API; k6 for performance (user choice).
- **Architecture:** one lean agent + 8 self-contained skills (chosen over a monolithic agent, which bloats every delegation, and over multiple specialized agents, which adds coordination overhead for one persona). The agent carries persona, principles, and a skill-routing table; skills carry the templates, heuristics, and code patterns, loaded on demand via progressive disclosure. Skills are also usable directly without the agent.

## Components
| File | Purpose |
|---|---|
| `agents/qa-agent.md` | Persona, when-to-invoke, skill routing, working principles, output format |
| `skills/test-plan-design` | Risk-based planning, scope, entry/exit criteria |
| `skills/test-case-writing` | Partitioning, boundaries, decision tables, Given/When/Then |
| `skills/ui-automation` | Playwright E2E: locators, waits, POM, anti-flake |
| `skills/api-testing` | APIRequestContext, schema/contract checks, coverage matrix |
| `skills/bug-reporting` | Repro-first reports, severity/priority rubric |
| `skills/exploratory-testing` | Charters, SFDIPOT, tours, session notes |
| `skills/regression-ci-strategy` | Suite tiers, test selection, flaky protocol, CI shape |
| `skills/performance-testing` | k6 test types, thresholds, metrics, report format |

Skills cross-reference each other by name (e.g. bug found in exploratory session → `bug-reporting`).

## Conventions followed
- Skill descriptions: third-person, trigger-phrase rich; bodies: imperative form, <1,500 words.
- Agent: `model: inherit`, full tool access (must run Playwright/k6), trigger scenarios in description + "When to invoke" body section.
