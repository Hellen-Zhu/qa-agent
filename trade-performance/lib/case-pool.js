/*
 * lib/case-pool.js — generic case pool: build a pool from a JSON data file and pick rows
 *
 * Framework infrastructure — it **knows nothing about any specific path under
 * test**. Each path's instantiation (SharedArray name, override key, default
 * data file, plus path-specific mechanisms like .dat preloading) lives in
 * steps/<svc>/<domain>/<path>-data.js, next to the step that consumes it —
 * lib/ keeps only the mechanics that are identical across dozens of APIs
 * (same engine/contract layering as errors.js).
 *
 * ── Data format: JSON only ──
 * Contract in lib/rows.js: top-level rows array, keys starting with _ are
 * comments, all values coerced to strings. The .csv compatibility path was
 * removed on 2026-07-29 (the old CSV column layout is incompatible with the
 * new schema's embedded ownership fields) — if a pool ever grows big enough
 * to need Excel maintenance, add an offline csv→json conversion script;
 * don't make k6 read CSV again.
 *
 * ⚠ open() is init-only. Its relative-path semantics are in flux: current k6
 *   resolves against the "module being evaluated" (so when a path module
 *   calls this function, paths resolve relative to **that module**), while
 *   future versions resolve against the "module where the code is written".
 *   import.meta.resolve() anchors to **this file** under both semantics —
 *   it is the official pattern from the k6 warning. All cross-module open()
 *   calls must go through it; bare relative paths will break sooner or later.
 */

import { SharedArray } from 'k6/data';
import { rowsFromJson } from './rows.js';

const ROOT = '../'; // lib/ → project root (paired with import.meta.resolve anchoring to this file)

/** Override semantics match pick() in lib/config.js: empty string = unset */
export function envOr(key, fallback) {
  const v = __ENV[key];
  return v === undefined || v === '' ? fallback : v;
}

/*
 * Path normalization: relative paths in data files always use /, but files
 * edited on Windows may sneak in backslashes (\). k6's open() accepts both,
 * but baseName splitting only on / would treat the whole path as the file
 * name — the outgoing multipart becomes
 * `filename="products\FX_TRF\x.dat"`, which the server most likely accepts
 * as-is: **the request succeeds with the wrong filename**, and the report
 * shows nothing.
 */
export function normalizePath(p) {
  return String(p || '').replace(/\\/g, '/');
}

/** Last segment of a path (for multipart filename and similar) */
export function baseName(relPath) {
  const p = normalizePath(relPath);
  const i = p.lastIndexOf('/');
  return i < 0 ? p : p.slice(i + 1);
}

/**
 * Build a case pool. Row data goes through SharedArray (one copy shared by
 * all VUs; open() runs only once inside the callback — the officially
 * recommended pattern).
 *
 * @param {Object} opts
 *   opts.name        SharedArray name — globally unique, one per path
 *   opts.envKey      override key for the data file (e.g. CREATE_DATA_FILE)
 *   opts.defaultFile default data file (rooted at the project directory). The default lives in
 *                    the instantiating module rather than config/<env>.json —
 *                    "which pool to use" is a plan-level decision, not an
 *                    environment-level one (rationale in each instantiating
 *                    module's header comment)
 * @returns {{file: string, rows: SharedArray, pick: (i: number) => Object}}
 *   pick is global-cursor roundRobin: paired with
 *   exec.scenario.iterationInTest (a globally monotonic counter across all
 *   VUs), coverage is uniform and reproducible
 */
export function makeCasePool(opts) {
  const file = envOr(opts.envKey, opts.defaultFile);
  if (!file.endsWith('.json')) {
    throw new Error(
      `Data files must be .json: ${file} (${opts.envKey}). ` +
      `Contract in lib/rows.js; .csv is no longer supported, see this file's header comment`
    );
  }
  const rows = new SharedArray(opts.name, () =>
    rowsFromJson(open(import.meta.resolve(ROOT + file)), file)
  );
  return {
    file,
    rows,
    pick(i) {
      if (rows.length === 0) throw new Error(`${file} has no data rows`);
      return rows[i % rows.length];
    },
  };
}
