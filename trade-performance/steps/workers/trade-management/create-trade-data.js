/*
 * steps/workers/trade-management/create-trade-data.js
 * -- Data supply for the **create-trade path under test** (case-pool instantiation + .dat preload)
 *
 * [Layer] Path data supply -- the generic machinery is in lib/case-pool.js;
 * this file only does the two path-specific things:
 *   1. Instantiate create's case pool (SharedArray name, override key, default data file)
 *   2. .dat binary preload and upload naming (only upload-style paths have this part)
 * Lives in the same directory as the steps that consume it
 * (create-trade / calc-risk-for-new) -- data files (.json) stay purely in
 * data/, no code mixed in.
 *
 * ── Why the default data file path lives here, not in config/<env>.json ──
 * In the three orthogonal dimensions, config is "which environment to hit"
 * (addresses, identities, timeouts, preflight policy); "which case pool to
 * use" is a **plan-dimension** concern: p05 hammering list endpoints has no
 * need for create cases at all, and putting it in env config would force
 * every environment to declare configuration irrelevant to itself.
 * For an ad-hoc pool swap (lock-contention control pools and other variants)
 * use the CREATE_DATA_FILE override.
 *
 * ⚠ Data **content** is environment-specific (ids do not carry across
 *   environments, see data/workers/trade-management/README.md), but the
 *   **path** is not -- when switching environments, re-collect and fill the
 *   same file, don't switch to a different path.
 *
 * ══ Three k6 constraints you must understand ═══════════════════
 *
 * 1. open() can only be called in the **init context**, and relative paths
 *    resolve against **this file**.
 *    → All .dat files must be **fully read into memory once** at module
 *      load; you cannot "read from disk per iteration based on the row's
 *      datFile field".
 *
 * 2. SharedArray can only hold **JSON-serializable** data.
 *    → Row data fits (saves memory); **binary .dat does not**.
 *
 * 3. Therefore .dat is **duplicated per VU**:
 *
 *        memory ≈ VU count × total bytes of all .dat files
 *
 *    20 VUs × 3 files of 5MB = 300MB. Acceptable.
 *    20 VUs × 3 files of 50MB = 3GB. **Not acceptable.**
 *
 *    This is a **real weakness** of k6; don't gloss over it. If you actually
 *    hit it, there are two ways out:
 *      a) Lazy reads via k6/experimental/fs (newer versions)
 *      b) Split into multiple scenarios, each loading only its own productType
 *    Measure first, optimize later -- watch the memory in `k6 run` output,
 *    don't design ahead of the problem.
 * ═══════════════════════════════════════════════════════════
 */

import { makeCasePool, envOr, normalizePath, baseName } from '../../../lib/case-pool.js';

// import.meta.resolve anchors to this file (open()'s relative-path semantics
// are stable across old and new versions, see the header comment in
// lib/case-pool.js)
const ROOT = '../../../'; // steps/workers/trade-management/ → project root

// Root directory for .dat samples. Currently only the create path uploads
// .dat (create / calc-risk-for-new); if another path ever uploads files too,
// extract this section into a generic binary pool in lib/.
const DAT_DIR = 'data/dat';

// ── Case pool: one row = one complete case ──────────────────────────────
// .dat reference + embedded ownership fields (portfolioId /
// counterpartyFmId / counterpartyName); there is no separate refdata pool.
// A row's identity is the __row injected automatically at load time
// (row number, 1-based); the data file maintains no id column.
// Swap pools without changing scripts:
//   ./run.sh p02-trade-create dev baseline CREATE_DATA_FILE=data/workers/trade-management/create-trade-lock-variant.json
const pool = makeCasePool({
  name: 'create-cases',
  envKey: 'CREATE_DATA_FILE',
  defaultFile: 'data/workers/trade-management/create-trade.json',
});

export const DATA_FILE = pool.file;
export const createCases = pool.rows;

/** Global-cursor roundRobin: use exec.scenario.iterationInTest for i -- even coverage and reproducible */
export function pickCase(i) {
  return pool.pick(i);
}

// ── .dat: duplicated per VU, unavoidable ───────────────────────────────
// Only load the files the data file actually references, don't scan the
// whole directory -- large synthetic/ files may be sitting there, and
// reading them all in would be pure waste.
const datBinaries = {};
for (let i = 0; i < createCases.length; i++) {
  const rel = normalizePath(createCases[i].datFile);
  if (!rel || datBinaries[rel] !== undefined) continue;
  datBinaries[rel] = open(import.meta.resolve(ROOT + DAT_DIR + '/' + rel), 'b');
}

export function getDat(relPath) {
  const b = datBinaries[normalizePath(relPath)];
  if (b === undefined) {
    // Only happens when data and disk are out of sync, and by then init is
    // already over -- we can only error out, not read late
    throw new Error(
      `.dat not loaded: ${relPath}. The init phase only loads files referenced by the data file; ` +
      `check that the datFile fields in ${DATA_FILE} match ${DAT_DIR}/ ` +
      `(run ./scripts/index-dat.py to reconcile)`
    );
  }
  return b;
}

/*
 * ── DAT_NAME_MODE: unique upload filenames (deviation switch to bypass a server defect) ──
 *
 * The server names the temp file for each upload by **timestamp** and deletes
 * it when done. Two requests arriving in the same instant land on the same
 * temp file: whichever finishes first deletes it, and the other fails with
 * "dat not found".
 *
 * unique mode appends a unique suffix to the multipart filename; the **byte
 * content is unchanged**, so no physical file copies are needed (copying N
 * versions = N× memory amplification, see constraint 3 in the file header).
 * Whether it works depends on whether the server's temp name includes the
 * client filename:
 *   includes it → unique name means unique temp path, collision gone;
 *   timestamp only → renaming does nothing, collisions persist -- one
 *   control run is enough to tell which case it is.
 *
 * ⚠ Default is original: production users don't rename uploads, so error
 *   rates measured under unique will understate production -- the report
 *   must flag the deviation. After the server defect is fixed, turn this
 *   switch off and rerun the concurrency test; that rerun is the defect's
 *   regression verification.
 */
export const DAT_NAME_MODE = envOr('DAT_NAME_MODE', 'original');
if (DAT_NAME_MODE !== 'original' && DAT_NAME_MODE !== 'unique') {
  throw new Error(`DAT_NAME_MODE=${DAT_NAME_MODE} is invalid; only original | unique are accepted`);
}

// Each VU has its own JS VM, so a module-level counter is naturally isolated
// per VU -- combined with __VU it is globally unique within one run; rand4
// guards against cross-process name clashes when two runners run at once
// (manual + CI)
let uploadSeq = 0;

/** Upload filename: original uses the original name; unique inserts a unique segment before the extension */
export function uploadName(relPath) {
  const base = baseName(relPath);
  if (DAT_NAME_MODE === 'original') return base;
  const dot = base.lastIndexOf('.');
  const stem = dot > 0 ? base.slice(0, dot) : base;
  const ext = dot > 0 ? base.slice(dot) : '';   // keep the extension -- the server may validate .dat
  uploadSeq += 1;
  const rand = Math.random().toString(36).slice(2, 6);
  return `${stem}__u${__VU}-${uploadSeq}-${rand}${ext}`;
}
