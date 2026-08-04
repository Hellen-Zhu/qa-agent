# worker-svc / trade data files

- `trades-query.json` — query field pool: `{ filters: [...] }`. Fields have no validity coupling between them; rotate freely within the pool.
- `trades-create.json` — create case pool: one row = one complete runnable case. The row number `__row` is injected automatically at load time
  and serves as a metric tag (a bad data row can be sliced out directly from the metrics); there is no manually maintained id column.
- `trade-ids.json` — trade ID pool: `{ ids: [...] }`, shared by the detail and risk-metrics scenarios.
  Capture: run one `GET /api/v1/trades` query (or copy from the UI) and fill in trade ids from the **dedicated PERF portfolio**;
  IDs go stale with the environment — re-capture when switching environments. Placeholders are intercepted by the setup-phase preflight.
  ⚠ Expired IDs show up as **http-404 falling into the technical class** — if you see a wall of http-404, re-capture the IDs first; do not treat it as a performance problem.

The read-path client (`src/api/worker-svc/trade/query.js`) and the write-path client (`create.js`) are separate code,
because read scenarios should not load the create case pool or the dat binaries — the two never import each other.

## Why ownership fields are embedded per row, and must be same-source

Static data supply has no live-query fallback, so **any hand assembly can produce combinations that do not exist in reality** —
a portfolio belonging to desk A while the counterparty has no account on desk A. Server-side business rejections show up in the report as
"elevated error rate": it looks like a performance problem, but it is actually a data problem, and it is extremely hard to pin down. Therefore:

- `counterpartyFmId` and `counterpartyName` are consistency-checked server side; stitching them together from two places is forbidden;
- the three ownership fields must come **as one group from a single real curl** (create the order in the system's web UI, then in
  DevTools do Copy as cURL on `POST /trades/create`) — this one curl simultaneously yields: the paired ownership ground truth,
  the real .dat file (save it under the same-name convention as `../datfiles/products/<productType>/<productType>.dat` —
  rows do not carry paths; the framework locates it automatically by productType), and the payload structure and header set.

## Data validity is guarded by two layers of mechanism (preflight sends no requests)

- Before the run: in the same session before any big round, run `smoke` first — it genuinely creates one trade, and that is the real verification that "the API accepts this data right now";
- While running: the lenient abort-threshold line on business success rate for long profiles (`rate>0.50` + abortOnFail) —
  stale data manifests as wholesale business rejection, and whether it happens at startup or in hour 3, losses are cut automatically within minutes.

## When to refresh

There is no periodic refresh, but re-capture is mandatory in these cases: switching environments (ids do not cross environments); smoke's create starts failing or
a long run is aborted by the business-success-rate breaker; the errors contain a flood of "counterparty not found / not entitled"-style rejections.
Record the capture time and source in the `note` field.

## Variant pools (controlled experiments)

E.g. portfolio-level lock contention: copy `trades-create.json` as a variant (fill every row with the same ownership group), then switch via the
`CREATE_DATA_FILE=data/worker-svc/trade/<variant>.json` override — no script changes.

⚠ Captured curl/response samples go in `_samples/` in this directory (already gitignored) — DevTools exports contain session
cookies and real business data; **they must never enter the repo**.
