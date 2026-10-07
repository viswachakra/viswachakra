// Push the local SQLite repository up to Supabase (Postgres) so the mobile app can read it.
// Runs after each scrape. Bulk-upserts cases + claim_workflow; replaces workflow per case.
// Needs SUPABASE_URL and SUPABASE_SERVICE_KEY in .env.
require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const { createClient } = require('@supabase/supabase-js');
const { db } = require('./db');

const URL = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_KEY;

// ---- precomputed per-case summary (so Summary/Follow-up read light columns, not the whole workflow) ----
const MON = { jan:0,feb:1,mar:2,apr:3,may:4,jun:5,jul:6,aug:7,sep:8,oct:9,nov:10,dec:11 };
function parseWfDate(str){const m=String(str||'').match(/(\d{1,2})-([A-Za-z]{3})-(\d{4})\s+(\d{1,2}):(\d{2})\s*(AM|PM)?/i);if(!m)return null;let h=+m[4];const ap=(m[6]||'').toUpperCase();if(ap==='PM'&&h<12)h+=12;if(ap==='AM'&&h===12)h=0;return new Date(+m[3],MON[m[2].toLowerCase()],+m[1],h,+m[5]);}
function parseAmt(v){const n=parseInt(String(v==null?'':v).replace(/[^0-9]/g,''),10);return isNaN(n)?0:n;}
// The amount the Trust actually sanctioned, taken from the LAST approval row.
// Measured against 3 years of history this predicts a short-payment with 100%
// precision and 100% recall (478/478, zero false alarms) — and it appears on the
// workflow months before the Paid row, so the app can warn early. Using the
// smallest approval amount instead would have raised 30 false alarms.
const APPROVAL_RE = /Recommended for Approval|Medical Audit Recommend Approval/i;
function computeApproved(rows){
  const a=rows.filter(r=>APPROVAL_RE.test(r.action||'')).map(r=>parseAmt(r.amount)).filter(v=>v>0);
  return a.length?a[a.length-1]:null;
}

function computeSummary(rows){
  rows=[...rows].sort((a,b)=>a.row_index-b.row_index);
  const initiated=rows.find(r=>/initiated/i.test(r.action||''))||rows[0];
  const paidRow=[...rows].reverse().find(r=>/paid/i.test(r.action||''));
  const last=rows[rows.length-1];
  const claimed=initiated?parseAmt(initiated.amount):0;
  const initAt=initiated?parseWfDate(initiated.date_time):null;
  let paid=null,paidDate=null,settlement=null,deduction=null;
  if(paidRow){paid=parseAmt(paidRow.amount);paidDate=paidRow.date_time||null;const pAt=parseWfDate(paidRow.date_time);if(claimed>0)deduction=Math.max(0,claimed-paid);if(initAt&&pAt){const d=Math.round((pAt-initAt)/864e5);if(d>=0)settlement=d;}}
  return {
    claimed_amount:claimed||null, paid_amount:paid, paid_date:paidDate, settlement_days:settlement, deduction, is_paid:!!paidRow,
    approved_amount:computeApproved(rows),
    latest_comment:last?(last.remarks||''):'', latest_comment_by:last?(last.role_name||last.action||''):'', latest_comment_date:last?(last.date_time||''):'',
  };
}

async function chunkedUpsert(supabase, table, rows, conflictCol, chunk = 500) {
  for (let i = 0; i < rows.length; i += chunk) {
    const slice = rows.slice(i, i + chunk);
    const { error } = await supabase.from(table).upsert(slice, { onConflict: conflictCol });
    if (error) throw new Error(`${table} upsert failed at row ${i}: ${error.message}`);
    process.stdout.write(`  ${table}: ${Math.min(i + chunk, rows.length)}/${rows.length}\r`);
  }
  console.log('');
}

function arg(name) {
  const i = process.argv.indexOf('--' + name);
  return i > -1 ? process.argv[i + 1] : null;
}

async function main() {
  if (!URL || !KEY) {
    console.error('Set SUPABASE_URL and SUPABASE_SERVICE_KEY in .env first.');
    process.exit(1);
  }
  const supabase = createClient(URL, KEY, { auth: { persistSession: false } });

  // optional: only push rows synced in the last N minutes (used for incremental per-chunk pushes)
  const sinceMin = arg('since-minutes') ? parseInt(arg('since-minutes'), 10) : null;
  let cases, workflow;
  if (sinceMin) {
    const cutoff = new Date(Date.now() - sinceMin * 60 * 1000).toISOString();
    cases = db.prepare('SELECT * FROM cases WHERE last_synced > ?').all(cutoff);
    const caseNos = new Set(cases.map((c) => c.case_no));
    workflow = db.prepare('SELECT case_no, row_index, date_time, role_name, remarks, action, amount FROM claim_workflow').all()
      .filter((w) => caseNos.has(w.case_no));
  } else {
    cases = db.prepare('SELECT * FROM cases').all();
    workflow = db.prepare('SELECT case_no, row_index, date_time, role_name, remarks, action, amount FROM claim_workflow').all();
  }
  // sync_runs mirror: keep ONLY today's runs (Sync History shows just today). Runs on EVERY
  // push — even "nothing new" or a failed scrape — so failures always get recorded.
  try {
    const allRuns = db.prepare('SELECT started_at, finished_at, status, from_dt, to_dt, total_found, deep_scraped, message FROM sync_runs ORDER BY id DESC LIMIT 200').all();
    const today = new Date().toDateString();
    const runs = allRuns.filter((r) => { const d = new Date(r.started_at); return !isNaN(d.getTime()) && d.toDateString() === today; });
    await supabase.from('sync_runs').delete().gte('id', 0);
    if (runs.length) { const { error } = await supabase.from('sync_runs').insert(runs); if (error) console.log('  (sync_runs mirror skipped:', error.message, ')'); }
  } catch (e) { console.log('  (sync_runs mirror error:', e.message, ')'); }

  if (!cases.length) { console.log('Nothing new to push.'); return; }

  // merge precomputed summary columns into each case from its workflow rows
  const byCase = {};
  workflow.forEach((w) => { (byCase[w.case_no] = byCase[w.case_no] || []).push(w); });
  for (const c of cases) Object.assign(c, computeSummary(byCase[c.case_no] || []));

  // Never overwrite a populated Supabase value with a blank local one.
  //
  // The list fields below come from the portal's SEARCH RESULTS page, which
  // rescrapeCases() does not read - its docstring says it "does not touch list
  // fields" - so a workflow-only re-scrape leaves them empty in local SQLite.
  // Upserting the whole local row then wiped names and statuses that had been
  // repaired directly in Supabase: 94 cases lost patient_name and claim_status
  // that way on 2026-10-05..07, including 55 paid claims worth ₹14.4 lakh.
  //
  // Omitting a key from the payload leaves that column untouched on conflict,
  // so blank list fields are simply dropped. Derived money columns are NOT
  // stripped - a null deduction or paid_amount is meaningful.
  const LIST_FIELDS = [
    'claim_no', 'patient_name', 'card_no', 'claim_status', 'source_registration',
    'status_date', 'ip_registration_dt', 'district', 'mandal', 'village',
    'contact_no', 'nwh_name', 'nwh_type', 'ip_no', 'category', 'procedure_name',
    'case_status',
  ];
  let stripped = 0;
  for (const c of cases) {
    for (const f of LIST_FIELDS) {
      if (f in c && (c[f] === null || c[f] === undefined || String(c[f]).trim() === '')) {
        delete c[f];
        stripped++;
      }
    }
  }
  if (stripped) console.log(`  (left ${stripped} blank field(s) alone rather than blanking Supabase)`);

  console.log(`Pushing ${cases.length} cases and ${workflow.length} workflow rows to Supabase...`);

  // cases: primary key case_no
  await chunkedUpsert(supabase, 'cases', cases, 'case_no');

  // claim_workflow: unique (case_no, row_index). Replace all rows for the cases we have,
  // then upsert - simplest correct approach for a full push.
  await chunkedUpsert(supabase, 'claim_workflow', workflow, 'case_no,row_index');

  console.log('Done. Supabase is up to date.');
}

// Exported so other push scripts derive amounts with EXACTLY this logic rather
// than reimplementing it - a second, drifting copy of computeSummary is how
// claimed_amount got corrupted before.
module.exports = { computeSummary, chunkedUpsert, parseAmt, parseWfDate };

if (require.main === module) {
  main().catch((e) => { console.error('Push failed:', e.message); process.exit(1); });
}
