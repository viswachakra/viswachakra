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
  if (!cases.length) { console.log('Nothing new to push.'); return; }

  // merge precomputed summary columns into each case from its workflow rows
  const byCase = {};
  workflow.forEach((w) => { (byCase[w.case_no] = byCase[w.case_no] || []).push(w); });
  for (const c of cases) Object.assign(c, computeSummary(byCase[c.case_no] || []));

  console.log(`Pushing ${cases.length} cases and ${workflow.length} workflow rows to Supabase...`);

  // cases: primary key case_no
  await chunkedUpsert(supabase, 'cases', cases, 'case_no');

  // claim_workflow: unique (case_no, row_index). Replace all rows for the cases we have,
  // then upsert - simplest correct approach for a full push.
  await chunkedUpsert(supabase, 'claim_workflow', workflow, 'case_no,row_index');

  // sync_runs history mirror: replace with the last 200 runs so it stays clean (no duplicates)
  const runs = db.prepare('SELECT started_at, finished_at, status, from_dt, to_dt, total_found, deep_scraped, message FROM sync_runs ORDER BY id DESC LIMIT 200').all();
  if (runs.length) {
    await supabase.from('sync_runs').delete().gte('id', 0);
    const { error } = await supabase.from('sync_runs').insert(runs);
    if (error) console.log('  (sync_runs mirror skipped:', error.message, ')');
  }

  console.log('Done. Supabase is up to date.');
}

main().catch((e) => { console.error('Push failed:', e.message); process.exit(1); });
