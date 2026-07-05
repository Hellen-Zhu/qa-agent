---
name: api-testing
description: This skill should be used when the user asks to "test an API", "write API tests", "verify an endpoint", "add contract tests", or needs to validate REST endpoints, status codes, response schemas, or auth behavior without a browser.
---

# API Testing

Test APIs with Playwright's `APIRequestContext` (keeps one framework across UI and API suites). API tests are ~10× faster and more stable than UI tests — push every check that doesn't need a browser down to this layer.

## Setup

```ts
// api-fixtures.ts
export const test = base.extend<{ api: APIRequestContext }>({
  api: async ({ playwright }, use) => {
    const ctx = await playwright.request.newContext({
      baseURL: process.env.API_URL,
      extraHTTPHeaders: { Authorization: `Bearer ${process.env.API_TOKEN}` },
    });
    await use(ctx);
    await ctx.dispose();
  },
});
```

Never hardcode credentials or environment URLs in specs — environment variables or a config module only.

## What to assert on every endpoint

1. **Status code** — exact, not "ok": `expect(res.status()).toBe(201)`.
2. **Response shape** — validate the contract, not just spot fields. Use zod:

```ts
const OrderSchema = z.object({
  id: z.string().uuid(),
  total: z.number().nonnegative(),
  status: z.enum(['pending', 'paid', 'shipped']),
});
OrderSchema.parse(await res.json()); // throws with a precise diff on drift
```

3. **Business values** — the fields the operation was supposed to change.
4. **Side effects** — verify with a follow-up GET that state actually persisted; a 200 proves the handler returned, not that it worked.

## Coverage matrix per endpoint

| Category | Cases |
|---|---|
| Happy path | Valid input → expected status + body + persisted state |
| Validation | Missing required field, wrong type, boundary values (see `test-case-writing` skill) → 400 with actionable error body |
| Auth | No token → 401; valid token, wrong role/owner → 403 (test *other users' resources* explicitly — IDOR) |
| Not found | Random ID → 404 (and not 500) |
| Idempotency | Repeat the same POST/PUT — duplicates? double side effects? |
| Method/content | Wrong HTTP method → 405; malformed JSON → 400 |

## CRUD lifecycle pattern

Prefer one test per behavior, but keep entity lifecycles honest with a create→read→update→delete→verify-gone flow:

```ts
test('order lifecycle', async ({ api }) => {
  const created = await api.post('/orders', { data: validOrder });
  expect(created.status()).toBe(201);
  const { id } = await created.json();

  expect((await api.get(`/orders/${id}`)).status()).toBe(200);
  expect((await api.patch(`/orders/${id}`, { data: { note: 'x' } })).status()).toBe(200);
  expect((await api.delete(`/orders/${id}`)).status()).toBe(204);
  expect((await api.get(`/orders/${id}`)).status()).toBe(404); // actually gone
});
```

Each test creates its own data and cleans up (or uses unique names) so the suite is parallel-safe.

## Principles

- Test through the public contract; never assert on internal implementation details that a legitimate refactor could change.
- Error responses are part of the API: assert their structure (code, message) — clients depend on them.
- When a UI test exists for a flow, ask what it verifies that the API test doesn't; delete the overlap at the more expensive layer.
- Schema validation failures on unchanged tests mean the API contract drifted — that's a finding to report (see `bug-reporting` skill), not a test to loosen.
