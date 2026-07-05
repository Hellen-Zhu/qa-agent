---
description: Invoke qa-agent to design BDD test cases for a user story
argument-hint: <user story text, ticket ID, or path to story file>
---

Design BDD test cases for the following user story by dispatching the **qa-agent** subagent.

## User story

$ARGUMENTS

If the argument is a file path, read the file to get the story. If the argument is empty, ask for the user story before proceeding.

## Instructions for the dispatch

Use the Agent tool with `subagent_type: "qa-agent"` and pass it this brief:

> You are designing BDD test cases for a user story. Load the `test-case-writing` skill (and `test-plan-design` if the story is large enough to need risk scoping) and follow it.
>
> **Story:** <insert the full user story text here>
>
> Deliverable — write a test case document to `docs/test-cases/<story-slug>.md` (derive a short kebab-case slug from the story title or ticket ID; if the file already exists, update it in place rather than duplicating). The document must follow this exact structure, because the `/qa-automate` command consumes it later:
>
> ```markdown
> # Test Cases: <story title>
> **Story:** <ticket ID or one-line summary>
> **Date:** <today> | **Status:** designed
>
> ## Risk notes
> <2-4 bullets: riskiest failure modes driving the case selection>
>
> ## Scenarios
>
> ### TC-01: <expected behavior as title> [P1] [api]
> ```gherkin
> Given <precondition>
> When <action>
> Then <observable, specific outcome>
> And <what must NOT happen, where relevant>
> ```
>
> ### TC-02: ... [P2] [ui]
> ...
> ```
>
> Tagging rules — every scenario gets exactly one priority tag and one automation-level tag:
> - Priority: `[P1]` blocks release / `[P2]` should pass / `[P3]` nice to have
> - Level: `[api]` verifiable without a browser / `[ui]` needs a real browser journey / `[manual]` needs human judgment (visual, usability)
> - Push cases to the cheapest level that can catch the bug: prefer `[api]` over `[ui]`.
>
> Cover happy paths, validation/boundary cases, auth/permission cases, and the error-guessing "dirty dozen" from the skill — but only where relevant to this story. Every Then must be concretely observable.

## After the agent returns

1. Show the user a summary table: scenario ID, title, priority, level.
2. State the file path where the cases were saved and note the next step: run `/qa-automate docs/test-cases/<story-slug>.md` to automate the `[api]` and `[ui]` cases.
