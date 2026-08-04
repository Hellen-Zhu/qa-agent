/*
 * Data supply for the create path: case-pool instantiation + dat preloading.
 * The generic parsing machinery lives in lib/rows.js; this file does only the two path-specific things.
 * k6 constraints: open() is available only in the init phase → all dat files must be read once at load time;
 * SharedArray can hold only JSON-serializable data → row data goes into the SharedArray (a single copy
 * across all VUs), but binary dat cannot → each VU carries its own copy, so memory ≈ VU count × total
 * dat bytes — beware large files.
 */
import { SharedArray } from 'k6/data';
import { rowsFromJson } from '../../../lib/rows.js';

function envOr(key, fallback) {
  const v = __ENV[key];
  return v === undefined || v === '' ? fallback : v;
}

// Switching variant pools (controlled experiments) needs no script change: CREATE_DATA_FILE=data/worker-svc/trade/<variant>.json
export const DATA_FILE = envOr('CREATE_DATA_FILE', 'data/worker-svc/trade/trades-create.json');
if (!DATA_FILE.endsWith('.json')) {
  throw new Error(`data file must be .json: ${DATA_FILE} (contract: see lib/rows.js)`);
}

export const createCases = new SharedArray('create-cases', () =>
  rowsFromJson(open(import.meta.resolve(`../../../../${DATA_FILE}`)), DATA_FILE)
);

/** Global cursor rotation: use exec.scenario.iterationInTest as i — uniform coverage and reproducible */
export function pickCase(i) {
  if (createCases.length === 0) throw new Error(`${DATA_FILE} has no data rows`);
  return createCases[Math.abs(i) % createCases.length];
}

// ── Convention-based dat preloading: productType → data/datfiles/products/<productType>/<productType>.dat ──
// Convention over configuration: rows carry only productType and the dat is located by the same-name
// convention — no path strings in the data file to mistype; adding a product = drop in one conventionally
// named file + add one data row. If a single product ever needs multiple dat samples, add an optional
// datFile override column to the rows (YAGNI for now). Only products actually referenced by the data
// file are preloaded.
const DAT_ROOT = '../../../../data/datfiles/products/';
// productType is spliced into a file path: run it through a character-set gate first
// (which also catches spelling anomalies right at load time)
const PRODUCT_TYPE_RE = /^[A-Za-z0-9_-]+$/;
const datBinaries = {};
for (let i = 0; i < createCases.length; i++) {
  const pt = createCases[i].productType || '';
  if (!pt || datBinaries[pt] !== undefined) continue;
  if (!PRODUCT_TYPE_RE.test(pt)) {
    throw new Error(
      `${DATA_FILE} row ${createCases[i].__row}: productType='${pt}' contains illegal characters (only letters/digits/_/- allowed)`
    );
  }
  datBinaries[pt] = open(import.meta.resolve(`${DAT_ROOT}${pt}/${pt}.dat`), 'b');
}

export function getDat(productType) {
  const b = datBinaries[productType];
  if (b === undefined) {
    throw new Error(
      `dat not preloaded: ${productType} — confirm data/datfiles/products/${productType}/${productType}.dat exists` +
      ` and the productType spelling in ${DATA_FILE} matches`
    );
  }
  return b;
}

/** multipart upload filename: by convention, <productType>.dat */
export function datName(productType) {
  return `${productType}.dat`;
}
