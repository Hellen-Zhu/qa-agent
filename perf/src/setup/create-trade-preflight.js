/*
 * Local data gate for the create path: runs in setup(), once before the whole round starts.
 * It answers exactly one question and sends no requests: "is the data file filled in?" —
 * placeholders, missing fields, empty pools. These problems would make every single
 * iteration fail in the same way; intercepting them here is zero-cost and can report
 * exact row numbers.
 * "Is the data still valid today" is answered by smoke-session discipline plus the
 * long-run circuit-breaker line (see data/worker-svc/trade/README.md).
 */
import exec from 'k6/execution';
import { createCases, pickCase, DATA_FILE } from '../api/worker-svc/trade/create-data.js';
import { validateInputs } from '../api/worker-svc/trade/create.js';

export function createTradePreflight() {
  console.log('── preflight: local validation of the create case pool ──');
  console.log(`data=${DATA_FILE} rows=${createCases.length}`);

  if (createCases.length === 0) {
    exec.test.abort(`PREFLIGHT FAILED — data file has no data rows: ${DATA_FILE}`);
  }

  const all = [];
  for (let i = 0; i < createCases.length && i < 50; i++) {
    const row = pickCase(i);
    validateInputs(row).forEach((p) => all.push(`[row ${row.__row}] ${p}`));
  }
  if (all.length > 0) {
    console.error('PREFLIGHT FAILED — static data unusable:');
    all.slice(0, 10).forEach((p) => console.error('  ' + p));
    exec.test.abort(`static data unusable (${all.length} problems, see log above)`);
  }
  if (createCases.length > 50) {
    console.log(`(only the first 50/${createCases.length} rows were validated)`);
  }
  console.log('✓ local data validation passed: fields complete, no placeholders');

  // Return value must be JSON-serializable (k6 copies it to every VU)
  return { startedAt: new Date().toISOString(), dataFile: DATA_FILE };
}
