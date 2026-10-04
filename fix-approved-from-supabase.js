// Fill in approved_amount for cases whose workflow is in Supabase but was never
// in local SQLite.
//
// backfill-approved-amount.js (Aug 2026) derived approved_amount from the LOCAL
// workflow, so it only covered the 2,146 cases local happened to hold. 755 more
// cases have their approval row sitting in Supabase the whole time - the value
// was always derivable, I just read from the wrong database. Those claims are
// invisible to the app's early-warning feature until this runs.
//
// DELIBERATELY NARROW: this only writes approved_amount, and only where it is
// currently NULL. It never overwrites an existing value and never touches
// claimed_amount / paid_amount / deduction / is_paid.
//
// Why so narrow: recomputing those from workflow is exactly what the warning at
// the top of run-hourly-sync.bat is about. Some older cases are genuinely paid
// but their Supabase workflow lacks a "Paid" row (legacy "-" action rows), so a
// blind recompute would flip is_paid to false and wipe real settlement data.
// Those ~40 cases are reported here for a human to look at, not auto-corrected.
//
// Usage:
//   node fix-approved-from-supabase.js            # dry run
//   node fix-approved-from-supabase.js --apply
require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const { createClient } = require('@supabase/supabase-js');
const { computeSummary } = require('./push-to-supabase');

const APPLY = process.argv.includes('--apply');

async function main() {
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
    auth: { persistSession: false },
  });

  const page = async (table, cols) => {
    let from = 0; const out = [];
    for (;;) {
      const { data, error } = await supabase.from(table).select(cols).range(from, from + 999);
      if (error) throw new Error(`${table}: ${error.message}`);
      out.push(...data);
      if (data.length < 1000) break;
      from += 1000;
    }
    return out;
  };

  console.log('Reading Supabase...');
  const cases = await page('cases', 'case_no,claimed_amount,paid_amount,approved_amount,deduction,is_paid');
  const wf = await page('claim_workflow', 'case_no,row_index,date_time,role_name,action,amount');

  const byCase = {};
  wf.forEach((w) => { (byCase[w.case_no] = byCase[w.case_no] || []).push(w); });

  const updates = [];
  const needsReview = [];
  for (const c of cases) {
    const rows = byCase[c.case_no];
    if (!rows) continue;
    const want = computeSummary(rows);

    // safe: a value that is simply absent
    if (c.approved_amount == null && want.approved_amount != null) {
      updates.push({ case_no: c.case_no, approved_amount: want.approved_amount });
    }

    // unsafe: an existing value that disagrees — report only
    const differs = (a, b) => (a ?? null) !== (b ?? null);
    if (
      differs(want.claimed_amount, c.claimed_amount) ||
      differs(want.paid_amount, c.paid_amount) ||
      differs(want.deduction, c.deduction) ||
      (!!want.is_paid !== !!c.is_paid)
    ) {
      needsReview.push({
        case_no: c.case_no,
        stored: { claimed: c.claimed_amount, paid: c.paid_amount, ded: c.deduction, is_paid: c.is_paid },
        workflow: { claimed: want.claimed_amount, paid: want.paid_amount, ded: want.deduction, is_paid: want.is_paid },
      });
    }
  }

  console.log(`\napproved_amount to fill (currently null) : ${updates.length}`);
  console.log(`cases needing human review (NOT touched) : ${needsReview.length}`);
  if (needsReview.length) {
    console.log('\n  case_no                 stored -> workflow says');
    needsReview.slice(0, 12).forEach((r) => {
      console.log(`  ${r.case_no}  paid=${r.stored.is_paid}/${r.stored.paid} ded=${r.stored.ded}` +
                  `  ->  paid=${r.workflow.is_paid}/${r.workflow.paid} ded=${r.workflow.ded}`);
    });
    if (needsReview.length > 12) console.log(`  ...and ${needsReview.length - 12} more`);
  }

  if (!updates.length) { console.log('\nNothing to fill.'); return; }
  if (!APPLY) { console.log('\nDRY RUN - nothing written. Re-run with --apply.'); return; }

  const chunk = 500;
  for (let i = 0; i < updates.length; i += chunk) {
    const slice = updates.slice(i, i + chunk);
    const { error } = await supabase.from('cases').upsert(slice, { onConflict: 'case_no' });
    if (error) throw new Error(`upsert failed at ${i}: ${error.message}`);
    process.stdout.write(`  written ${Math.min(i + chunk, updates.length)}/${updates.length}\r`);
  }
  console.log('\nDone.');
}

main().catch((e) => { console.error('Failed:', e.message); process.exit(1); });
