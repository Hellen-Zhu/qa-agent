// JSON data-file parsing contract (pure logic, Node-loadable).
// Top level is an array, or an object containing a rows array; keys starting with "_" (top-level
// and in-row) are comments, stripped at load time;
// scalar values are always converted to whitespace-trimmed strings (null/undefined → '') —
// whether the payload sends a number is the assembler's decision;
// __row (1-based row number) is auto-injected as the row identity, used for metric tags and
// pinpointing preflight errors.
// Note that note has no underscore — it is a real data column (recording capture time and
// source); do not write it as _note.
export function rowsFromJson(text, sourceName) {
  let doc;
  try {
    doc = JSON.parse(text);
  } catch (e) {
    throw new Error(
      `${sourceName} is not valid JSON — ${e.message}. ` +
      `Common causes: JSON allows neither comments nor trailing commas — write comments as keys starting with _`
    );
  }

  let rows;
  if (Array.isArray(doc)) rows = doc;
  else if (doc && Array.isArray(doc.rows)) rows = doc.rows;
  else {
    throw new Error(`${sourceName} has an invalid structure: top level should be an array, or an object containing a rows array (other keys starting with _ are comments)`);
  }

  return rows.map((r, idx) => {
    if (r === null || typeof r !== 'object' || Array.isArray(r)) {
      throw new Error(`${sourceName} row ${idx + 1} is not an object — each row should be {"field": "value"}`);
    }
    const out = { __row: idx + 1 };
    Object.keys(r).forEach((k) => {
      if (k.startsWith('_')) return;
      const v = r[k];
      if (v !== null && typeof v === 'object') {
        throw new Error(`${sourceName} row ${idx + 1} field ${k} is an object/array — in-row values must be scalars`);
      }
      out[k] = v === null || v === undefined ? '' : String(v).trim();
    });
    return out;
  });
}
