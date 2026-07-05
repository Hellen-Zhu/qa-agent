---
name: ui-automation
description: This skill should be used when the user asks to "automate a UI flow", "write Playwright tests", "add E2E tests", "fix a flaky browser test", "set up page objects", or needs guidance on locators, waits, fixtures, or browser test structure.
---

# UI Automation with Playwright

Write Playwright (TypeScript) E2E tests that are deterministic, readable, and only cover what genuinely needs a browser. In an existing repo, read `playwright.config.ts` and 2-3 existing specs first and match their conventions — consistency beats these defaults.

## What deserves a UI test

UI E2E is the most expensive, slowest, flakiest layer. Reserve it for real user journeys (login → act → verify outcome) and things only a browser can verify (navigation, rendering-dependent behavior). Validation logic, permissions, and data rules belong at the API level — see `api-testing` skill.

## Locators — in order of preference

```ts
page.getByRole('button', { name: 'Submit' })   // 1. role + accessible name (best)
page.getByLabel('Email')                        // 2. form labels
page.getByText('Order confirmed')               // 3. user-visible text
page.getByTestId('cart-total')                  // 4. test id (when semantics don't exist)
page.locator('.btn-primary >> nth=2')           // 5. NEVER — CSS/XPath tied to structure
```

Role-based locators double as accessibility checks: if `getByRole` can't find it, screen readers can't either.

## Waiting — the #1 flake source

- Playwright auto-waits on actions and `expect()` — trust it.
- **Never** `page.waitForTimeout(n)`. A fixed sleep is either too short (flake) or too long (waste), and usually both across environments.
- Wait for *outcomes*, not time: `await expect(page.getByText('Saved')).toBeVisible()`.
- For actions that fire requests, assert on the resulting UI state; use `page.waitForResponse` only when there is no UI signal.

## Structure: page objects + fixtures

```ts
// pages/checkout.page.ts — actions and locators, NO assertions
export class CheckoutPage {
  constructor(private page: Page) {}
  readonly total = () => this.page.getByTestId('cart-total');
  async applyDiscount(code: string) {
    await this.page.getByLabel('Discount code').fill(code);
    await this.page.getByRole('button', { name: 'Apply' }).click();
  }
}

// fixtures.ts — inject pages and authenticated state
export const test = base.extend<{ checkout: CheckoutPage }>({
  checkout: async ({ page }, use) => { await use(new CheckoutPage(page)); },
});

// tests/checkout.spec.ts — assertions live here
test('discount survives quantity change', async ({ checkout, page }) => {
  await checkout.applyDiscount('SAVE10');
  await page.getByLabel('Quantity').fill('2');
  await expect(checkout.total()).toHaveText('$17.98');
});
```

Rules: assertions in specs, not page objects; authenticate once via `storageState` (global setup), not through the login UI in every test; each test creates or owns its data — no order dependence, so the suite can run with `--workers` and `--shard`.

## Anti-flake checklist

- [ ] No `waitForTimeout`, no retry-until-pass loops around assertions
- [ ] No dependence on test execution order or shared mutable accounts
- [ ] Test data created per-test (via API, not UI) and cleaned up or uniquely named
- [ ] Animations disabled in config (`reducedMotion: 'reduce'`) where they cause instability
- [ ] `trace: 'on-first-retry'` in config, so failures ship with a trace to debug

## Debugging failures

1. `npx playwright show-trace trace.zip` — the trace viewer shows DOM, network, and console at every step; start here, not with re-runs.
2. Reproduce headed: `npx playwright test path/to.spec.ts --headed --debug`.
3. If it only fails in CI: check viewport, timezone/locale, and data collisions from parallel workers — in that order.
4. A test that fails 1-in-N is a defect: fix or quarantine it same-day (see `regression-ci-strategy` skill), never re-run until green.
