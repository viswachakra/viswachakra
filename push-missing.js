// Push every case that has NOT made it to Supabase, identified by comparing
// last_synced per case rather than by a time window.
//
// WHY NOT push-to-supabase.js --since-minutes: that selects by "scraped in the
// last N minutes", so anything older than the window is silently skipped. 172
// cases scraped in August sat unpushed for that exact reason - no time window
// short enough to be safe would ever reach them, and a full push (no window)
// re-derives every case from local SQLite and risks the settlement backfill
// (see the warning in run-hourly-sync.bat). This pushes by identity instead:
// exactly the rows that are missing or stale in Supabase, and nothing else.
//
// Amount derivation is imported from push-to-supabase.js rather than copied -
// a second, drifting implementation is how claimed_amount got corrupted.
//
// Usage:
//   node push-missing.js            # dry run, writes nothing
//   node push-missing.js --apply    # push
require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const { createClient } = require('@supabase/supabase-js');
const { db } = require('./db');
const { computeSummary, chunkedUpsert } = require('./push-to-supabase');

const URL = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_KEY;
const APPLY = process.argv.includes('--apply');

// Parse to epoch. Local writes "...978Z", Supabase returns "...978+00:00";
// comparing those as STRINGS reports every row as newer, which is wrong.
const ts = (v) => {
  if (!v) return null;
  const n = new Date(v).getTime();
  return isNaN(n) ? null : n;
};

async function main() {
  if (!URL || !KEY) {
    console.error('Set SUPABASE_URL and SUPABASE_SERVICE_KEY in .env first.');
    process.exit(1);
  }
  const supabase = createClient(URL, KEY, { auth: { persistSession: false } });

  let from = 0;
  const remote = new Map();
  for (;;) {
    const { data, error } = await supabase.from('cases').select('case_no,last_synced').range(from, from + 999);
    if (error) throw new Error(`read failed: ${error.message}`);
    data.forEach((c) => remote.set(c.case_no, ts(c.last_synced)));
    if (data.length < 1000) break;
    from += 1000;
  }

  const local = db.prepare('SELECT * FROM cases').all();
  const todo = local.filter((c) => {
    if (!remote.has(c.case_no)) return true;              // never pushed
    const lt = ts(c.last_synced);
    if (lt === null) return false;
    const rt = remote.get(c.case_no);
    return rt === null || lt > rt + 1000;                  // 1s slack for rounding
  });

  console.log(`local ${local.length} cases, Supabase ${remote.size}`);
  console.log(`needing push: ${todo.length}`);
  if (!todo.length) { console.log('Nothing to do - Supabase matches local.'); return; }

  if (!APPLY) {
    console.log('  e.g.', todo.slice(0, 5).map((c) => c.case_no).join(', '));
    console.log('\nDRY RUN - nothing written. Re-run with --apply.');
    return;
  }

  // Attach each case's workflow and derive the summary columns exactly as the
  // normal push does.
  const caseNos = new Set(todo.map((c) => c.case_no));
  const workflow = db
    .prepare('SELECT case_no,row_index,date_time,role_name,remarks,action,amount FROM claim_workflow')
    .all()
    .filter((w) => caseNos.has(w.case_no));

  const byCase = {};
  workflow.forEach((w) => { (byCase[w.case_no] = byCase[w.case_no] || []).push(w); });
  for (const c of todo) Object.assign(c, computeSummary(byCase[c.case_no] || []));

  console.log(`Pushing ${todo.length} cases and ${workflow.length} workflow rows...`);
  await chunkedUpsert(supabase, 'cases', todo, 'case_no');
  if (workflow.length) await chunkedUpsert(supabase, 'claim_workflow', workflow, 'case_no,row_index');
  console.log('Done.');
}

main().catch((e) => { console.error('Push failed:', e.message); process.exit(1); });
