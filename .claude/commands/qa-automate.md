---
description: Invoke qa-agent to automate BDD test cases produced by /qa-design
argument-hint: <path to docs/test-cases/<slug>.md, or story slug>
---

Automate the test cases in the given test case document by dispatching the **qa-agent** subagent.

## Input

$ARGUMENTS

Resolve the input to a test case file:
- If it is a path, use it directly.
- If it is a slug or story ID, look for `docs/test-cases/<slug>.md` (glob `docs/test-cases/*` if needed).
- If empty or not found, list the files in `docs/test-cases/` and ask which one to automate.

## Instructions for the dispatch

Use the Agent tool with `subagent_type: "qa-agent"` and pass it this brief:

> You are automating designed BDD test cases into Playwright tests.
>
> **Test case document:** <insert resolved file path> — read it first. Scenarios are tagged `[api]`, `[ui]`, or `[manual]` and prioritized `[P1]`-`[P3]`.
>
> Scope:
> - Automate all `[api]` scenarios (load the `api-testing` skill) and all `[ui]` scenarios (load the `ui-automation` skill). Skip `[manual]` scenarios — list them at the end as remaining manual work.
> - Automate in priority order: all P1 first, then P2, then P3.
>
> Before writing any test, inspect the project: find `playwright.config.ts`, existing specs, fixtures, and page objects, and follow the repo's conventions (naming, directory layout, fixtures). If Playwright is not set up at all, initialize it (`npm init playwright@latest` conventions: tests in `tests/`, TypeScript) before writing specs.
>
> Conventions:
> - One spec file per story: `tests/api/<story-slug>.spec.ts` and/or `tests/e2e/<story-slug>.spec.ts` (follow the repo's existing layout instead if one exists).
> - Map each scenario to one `test()` whose title starts with its ID: `test('TC-01: reject duplicate email', ...)`.
> - Keep Given/When/Then visible as structure in the test body (comments or steps), so the spec traces back to the design doc.
> - Follow the skills' rules strictly: role-based locators, no fixed sleeps, per-test data, assertions on observable outcomes including what must NOT happen.
>
> Verify your work: run the new specs. If the application under test is not running/reachable, say so explicitly and report the tests as written-but-unverified with the exact command to run them.
>
> Finally, update the test case document: change `**Status:** designed` to `**Status:** automated <date>`, and annotate each scenario line with `→ automated in <spec path>` or `→ manual`.

## After the agent returns

Report to the user:
1. Which scenarios were automated, in which spec files, and the test run result (pass/fail/unverified with reason).
2. Which scenarios remain manual and why.
3. The exact command to run the new tests (e.g. `npx playwright test tests/api/<slug>.spec.ts`).
