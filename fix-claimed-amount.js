// Repair cases.claimed_amount in Supabase.
//
// THE BUG: for 472 cases claimed_amount holds the PAID figure instead of the
// amount originally raised, so the app shows nonsense like "Claimed 15,000 /
// Deducted 20,500". The true figure is the amount on the "Initiated" workflow
// row (35,500 in that example). deduction and paid_amount are correct; only
// claimed_amount was overwritten, by an older backfill. push-to-supabase.js
// already derives it correctly, so this is a one-time repair of stale rows.
//
// Like backfill-approved-amount.js, this writes ONE column and only for
// case_no values already present, so it cannot disturb the settlement backfill
// that a full push-to-supabase.js run would wipe (see run-hourly-sync.bat).
//
// Usage:
//   node fix-claimed-amount.js            # dry run, writes nothing
//   node fix-claimed-amount.js --apply    # actually write
require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const { createClient } = require('@supabase/supabase-js');
const { db } = require('./db');

const URL = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_KEY;
const APPLY = process.argv.includes('--apply');

const parseAmt = (v) => {
  const n = parseInt(String(v == null ? '' : v).replace(/[^0-9]/g, ''), 10);
  return isNaN(n) ? 0 : n;
};

async function main() {
  if (!URL || !KEY) {
    console.error('Set SUPABASE_URL and SUPABASE_SERVICE_KEY in .env first.');
    process.exit(1);
  }
  const supabase = createClient(URL, KEY, { auth: { persistSession: false } });

  // current state in Supabase
  let from = 0;
  let all = [];
  for (;;) {
    const { data, error } = await supabase
      .from('cases')
      .select('case_no,claimed_amount,paid_amount,deduction')
      .range(from, from + 999);
    if (error) throw new Error(`read failed: ${error.message}`);
    all = all.concat(data);
    if (data.length < 1000) break;
    from += 1000;
  }
  const sup = new Map(all.map((c) => [c.case_no, c]));

  // truth: the amount on the Initiated row
  const rows = db
    .prepare('SELECT case_no, row_index, action, amount FROM claim_workflow ORDER BY case_no, row_index')
    .all();
  const byCase = {};
  for (const w of rows) (byCase[w.case_no] = byCase[w.case_no] || []).push(w);

  const updates = [];
  let absurd = 0;
  for (const [caseNo, ws] of Object.entries(byCase)) {
    const init = ws.find((w) => /initiated/i.test(w.action || ''));
    if (!init) continue;
    const trueClaimed = parseAmt(init.amount);
    if (trueClaimed <= 0) continue;
    const cur = sup.get(caseNo);
    if (!cur) continue;
    if (cur.claimed_amount === trueClaimed) continue;
    if ((cur.deduction || 0) > (cur.claimed_amount || 0)) absurd++;
    updates.push({ case_no: caseNo, claimed_amount: trueClaimed });
  }

  console.log(`${sup.size} cases in Supabase, ${Object.keys(byCase).length} with local workflow`);
  console.log(`${updates.length} rows have the wrong claimed_amount`);
  console.log(`  ${absurd} of them currently show deduction > claimed (visibly absurd)`);

  if (!APPLY) {
    console.log('\nDRY RUN - nothing written. Re-run with --apply to write.');
    return;
  }

  const chunk = 500;
  for (let i = 0; i < updates.length; i += chunk) {
    const slice = updates.slice(i, i + chunk);
    const { error } = await supabase.from('cases').upsert(slice, { onConflict: 'case_no' });
    if (error) throw new Error(`upsert failed at row ${i}: ${error.message}`);
    process.stdout.write(`  written: ${Math.min(i + chunk, updates.length)}/${updates.length}\r`);
  }
  console.log('\nDone. claimed_amount now matches the Initiated row.');
}

main().catch((e) => { console.error('Fix failed:', e.message); process.exit(1); });
