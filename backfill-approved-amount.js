// One-time backfill of cases.approved_amount in Supabase.
//
// WHY THIS IS A SEPARATE SCRIPT: a full `node push-to-supabase.js` re-derives
// claimed_amount / paid_amount / is_paid / deduction for EVERY case from the
// local (possibly stale) SQLite workflow and would wipe the settlement backfill
// — see the warning at the top of run-hourly-sync.bat. This script never writes
// those columns. It updates approved_amount and nothing else, and only for
// case_no values that already exist in Supabase, so it cannot insert stubs.
//
// Usage:
//   node backfill-approved-amount.js              # dry run, writes nothing
//   node backfill-approved-amount.js --apply      # actually write
require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const { createClient } = require('@supabase/supabase-js');
const { db } = require('./db');

const URL = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_KEY;
const APPLY = process.argv.includes('--apply');

const APPROVAL_RE = /Recommended for Approval|Medical Audit Recommend Approval/i;
const parseAmt = (v) => {
  const n = parseInt(String(v == null ? '' : v).replace(/[^0-9]/g, ''), 10);
  return isNaN(n) ? 0 : n;
};

// Amount on the LAST approval row — 100% precision / 100% recall against history.
function approvedFor(rows) {
  const a = rows
    .filter((r) => APPROVAL_RE.test(r.action || ''))
    .map((r) => parseAmt(r.amount))
    .filter((v) => v > 0);
  return a.length ? a[a.length - 1] : null;
}

async function existingCaseNos(supabase) {
  const seen = new Set();
  let from = 0;
  const size = 1000;
  for (;;) {
    const { data, error } = await supabase
      .from('cases')
      .select('case_no')
      .range(from, from + size - 1);
    if (error) throw new Error(`read case_no failed: ${error.message}`);
    data.forEach((r) => seen.add(r.case_no));
    if (data.length < size) break;
    from += size;
  }
  return seen;
}

async function main() {
  if (!URL || !KEY) {
    console.error('Set SUPABASE_URL and SUPABASE_SERVICE_KEY in .env first.');
    process.exit(1);
  }
  const supabase = createClient(URL, KEY, { auth: { persistSession: false } });

  const workflow = db
    .prepare('SELECT case_no, row_index, action, amount FROM claim_workflow ORDER BY case_no, row_index')
    .all();
  const byCase = {};
  for (const w of workflow) (byCase[w.case_no] = byCase[w.case_no] || []).push(w);

  console.log('Reading existing case_no list from Supabase...');
  const present = await existingCaseNos(supabase);
  console.log(`  ${present.size} cases in Supabase, ${Object.keys(byCase).length} in local SQLite`);

  const updates = [];
  let skippedMissing = 0;
  for (const [caseNo, rows] of Object.entries(byCase)) {
    const approved = approvedFor(rows);
    if (approved === null) continue;            // no approval row yet
    if (!present.has(caseNo)) { skippedMissing++; continue; }
    updates.push({ case_no: caseNo, approved_amount: approved });
  }

  // How many of these are already visibly short-approved?
  let shortApproved = 0;
  for (const u of updates) {
    const rows = byCase[u.case_no];
    const init = rows.find((r) => /initiated/i.test(r.action || ''));
    const claimed = init ? parseAmt(init.amount) : 0;
    if (claimed > 0 && u.approved_amount < claimed) shortApproved++;
  }

  console.log(`  ${updates.length} cases have an approval amount to write`);
  console.log(`  ${shortApproved} of them were approved BELOW the amount raised`);
  if (skippedMissing) console.log(`  ${skippedMissing} skipped (not in Supabase yet)`);

  if (!APPLY) {
    console.log('\nDRY RUN — nothing written. Re-run with --apply to write.');
    return;
  }

  // Upsert only {case_no, approved_amount}: on conflict PostgREST sets just the
  // columns present in the payload, so no other column is touched.
  const chunk = 500;
  for (let i = 0; i < updates.length; i += chunk) {
    const slice = updates.slice(i, i + chunk);
    const { error } = await supabase
      .from('cases')
      .upsert(slice, { onConflict: 'case_no' });
    if (error) throw new Error(`upsert failed at row ${i}: ${error.message}`);
    process.stdout.write(`  written: ${Math.min(i + chunk, updates.length)}/${updates.length}\r`);
  }
  console.log('\nDone. approved_amount is populated.');
}

main().catch((e) => { console.error('Backfill failed:', e.message); process.exit(1); });
