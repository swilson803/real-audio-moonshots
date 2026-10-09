// Deletes the test scans (ms006_scans rows labelled RA_TEST_…) from the
// moonshots project. Refuses production (moonshotsWriter).
//
//   MOONSHOTS_SUPABASE_URL=… MOONSHOTS_SERVICE_ROLE_KEY=… node scripts/clear-test-scans.mjs [--dry-run]
//
// --dry-run only counts them.
import { pathToFileURL } from 'node:url';
import { moonshotsWriter } from './lib/targets.mjs';

// PostgREST LIKE: * is %, and _ is escaped with \ so it matches only "_".
const FILTER = 'label=like.RA%5C_TEST%5C_*';
const PAGE = 1000;

export async function clearTestScans({ write, dryRun = false }) {
  let count = 0;
  for (let offset = 0; ; offset += PAGE) {
    const rows = await write(`ms006_scans?${FILTER}&select=id&order=id&limit=${PAGE}&offset=${offset}`);
    count += rows.length;
    if (rows.length < PAGE) break;
  }
  if (dryRun || !count) return { matched: count, deleted: 0 };
  const deleted = await write(`ms006_scans?${FILTER}&select=id`, { method: 'DELETE', prefer: 'return=representation' });
  return { matched: count, deleted: deleted.length };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const dryRun = process.argv.includes('--dry-run');
  const write = moonshotsWriter(process.env.MOONSHOTS_SUPABASE_URL, process.env.MOONSHOTS_SERVICE_ROLE_KEY);
  const r = await clearTestScans({ write, dryRun });
  console.log(dryRun ? `${r.matched} RA_TEST_ scans (dry run, nothing deleted)` : `deleted ${r.deleted} of ${r.matched} RA_TEST_ scans`);
}
