/*
 * lib/rows.js — JSON data-file parsing (the k6 primary format)
 *
 * ══ Why we switched from CSV to JSON ═══════════════════════════
 * 1. JSON is k6's native path: open() + JSON.parse into a SharedArray is
 *    the standard pattern from the official docs — no parser of our own
 *    (the CSV era once carried a hand-written 30-line one).
 * 2. Real counterparty names already contain `*`; commas are only a matter
 *    of time — in CSV that means quoting and column-shift problems, a
 *    problem class that simply does not exist in JSON.
 * 3. Comments: why a value is what it is and when it was captured can go in
 *    a `_comment` key (same convention as config/profiles: keys starting
 *    with an underscore are comments, stripped at load time).
 *
 * ══ File contract ══════════════════════════════════════════════
 * Top level is an array, or an object containing a `rows` array (any other
 * top-level `_`-prefixed keys are comments):
 *
 *   { "_comment": "why these values…",
 *     "rows": [ { "portfolioId": "...", "_note": "inline comments work too" } ] }
 *
 * Row-level keys starting with `_` are likewise stripped. **Note that `note`
 * has no underscore** — that is a real data column (capture time and
 * source) that flows into the generated CSV; don't write it as `_note`.
 *
 * ══ Deliberate alignment with CSV semantics ════════════════════
 * Every scalar value becomes a **whitespace-trimmed string** (null/undefined
 * → ''). In CSV everything is a string, and downstream code (payload
 * assembly, placeholder detection) was written for strings; changing the
 * format must not change the semantics — sending numeric types in a payload
 * is buildTradePayload's decision, not the data file's.
 *
 * This file **depends on no k6 module**, so it can be imported and tested
 * directly under plain node.
 */

/**
 * @param {string} text        full JSON text
 * @param {string} sourceName  identifies the source (file path) in errors
 * @returns {Array<Object>} one object per row, with __row (1-based row number)
 */
export function rowsFromJson(text, sourceName) {
  let doc;
  try {
    doc = JSON.parse(text);
  } catch (e) {
    throw new Error(
      `${sourceName} is not valid JSON — ${e.message}. ` +
      `Common cause: JSON allows no comments or trailing commas — write comments as keys starting with _`
    );
  }

  let rows;
  if (Array.isArray(doc)) rows = doc;
  else if (doc && Array.isArray(doc.rows)) rows = doc.rows;
  else {
    throw new Error(
      `${sourceName} has the wrong structure: top level should be an array, or an object with a rows array` +
      ` (other keys starting with _ are comments)`
    );
  }

  return rows.map((r, idx) => {
    if (r === null || typeof r !== 'object' || Array.isArray(r)) {
      throw new Error(
        `${sourceName} row ${idx + 1} is not an object — each row should have the form {"field": "value"}`
      );
    }
    const out = { __row: idx + 1 };
    Object.keys(r).forEach((k) => {
      if (k.startsWith('_')) return; // row-level comment key
      const v = r[k];
      out[k] = v === null || v === undefined ? '' : String(v).trim();
    });
    return out;
  });
}
