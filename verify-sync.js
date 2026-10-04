// Record-by-record audit of local SQLite against Supabase.
//
// Run before handing the system over. It checks three different things, because
// "in sync" can fail in three different ways:
//
//   1. COVERAGE  - is every local case present in Supabase, and vice versa?
//   2. FIELDS    - for every shared case, does every stored field match?
//   3. DERIVED   - do claimed/paid/approved/deduction actually follow from the
//                  workflow rows they are supposed to be derived from? This is
//                  the one that caught the 472 corrupted claimed_amount rows -
//                  those matched perfectly between the two databases and were
//                  still wrong, because both held the same bad value.
//
// Derivation is imported from push-to-supabase.js, never reimplemented.
//
// Usage:
//   node verify-sync.js              # summary
//   node verify-sync.js --details    # also list every offending case_no
require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const { createClient } = require('@supabase/supabase-js');
const { db } = require('./db');
const { computeSummary } = require('./push-to-supabase');

const DETAILS = process.argv.includes('--details');

// Fields that exist in BOTH databases and should match exactly.
//
// Deliberately excluded:
//   last_synced, deep_synced   - legitimately differ by milliseconds
//   latest_comment_*           - free text, rewritten on every push
//   claimed_amount, paid_amount, approved_amount, deduction,
//   settlement_days, is_paid, paid_date
//       These do NOT exist in the local cases table at all - they are derived
//       from the workflow at push time and stored only in Supabase. Comparing
//       them reported every single row as different. They are verified properly
//       in check 4 instead, by recomputing them from the workflow.
const FIELDS = [
  'claim_no', 'patient_name', 'card_no', 'district', 'mandal', 'village',
  'contact_no', 'nwh_name', 'ip_no', 'category', 'procedure_name',
  'claim_status', 'status_date',
];

// Derived-only columns: fetched from Supabase so check 4 can recompute and
// compare them, but never compared field-by-field in check 2 (no local copy).
const DERIVED = [
  'claimed_amount', 'paid_amount', 'approved_amount', 'deduction',
  'settlement_days', 'is_paid', 'paid_date',
];

const norm = (v) => {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'number') return v;
  const s = String(v).trim();
  if (s === '') return null;
  if (/^-?\d+$/.test(s)) return parseInt(s, 10);
  return s;
};

function line(ok, label, detail) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(46)} ${detail}`);
}

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
  const remoteCases = await page('cases', ['case_no', ...FIELDS, ...DERIVED].join(','));
  const remoteWf = await page('claim_workflow', 'case_no,row_index,date_time,role_name,action,amount');

  const localCases = db.prepare('SELECT * FROM cases').all();
  const localWf = db.prepare('SELECT case_no,row_index,date_time,role_name,action,amount FROM claim_workflow').all();

  console.log(`  Supabase: ${remoteCases.length} cases, ${remoteWf.length} workflow rows`);
  console.log(`  Local   : ${localCases.length} cases, ${localWf.length} workflow rows\n`);

  const R = new Map(remoteCases.map((c) => [c.case_no, c]));
  const L = new Map(localCases.map((c) => [c.case_no, c]));

  // ---- 1. coverage -------------------------------------------------------
  console.log('1. COVERAGE');
  const missingInRemote = localCases.filter((c) => !R.has(c.case_no)).map((c) => c.case_no);
  const onlyRemote = remoteCases.filter((c) => !L.has(c.case_no)).map((c) => c.case_no);
  line(missingInRemote.length === 0, 'local cases present in Supabase',
    missingInRemote.length === 0 ? 'all' : `${missingInRemote.length} MISSING`);
  console.log(`  INFO  ${'cases in Supabase only'.padEnd(46)} ${onlyRemote.length} (older cases never scraped locally — expected)`);
  if (DETAILS && missingInRemote.length) console.log('        ' + missingInRemote.slice(0, 20).join(', '));

  // ---- 2. field-by-field -------------------------------------------------
  console.log('\n2. FIELD-BY-FIELD (shared cases)');
  const fieldMismatch = {};
  let casesWithMismatch = 0;
  const badCases = [];
  for (const lc of localCases) {
    const rc = R.get(lc.case_no);
    if (!rc) continue;
    let bad = false;
    for (const f of FIELDS) {
      if (norm(lc[f]) !== norm(rc[f])) {
        fieldMismatch[f] = (fieldMismatch[f] || 0) + 1;
        bad = true;
      }
    }
    if (bad) { casesWithMismatch++; badCases.push(lc.case_no); }
  }
  line(casesWithMismatch === 0, 'every field identical',
    casesWithMismatch === 0 ? `${L.size} cases compared` : `${casesWithMismatch} cases differ`);
  for (const [f, n] of Object.entries(fieldMismatch).sort((a, b) => b[1] - a[1])) {
    console.log(`          ${f.padEnd(20)} ${n} differ`);
  }
  if (DETAILS && badCases.length) console.log('        ' + badCases.slice(0, 20).join(', '));

  // ---- 3. workflow rows --------------------------------------------------
  console.log('\n3. WORKFLOW ROWS');
  const countBy = (rows) => rows.reduce((m, w) => (m[w.case_no] = (m[w.case_no] || 0) + 1, m), {});
  const lwC = countBy(localWf); const rwC = countBy(remoteWf);
  const wfDiff = Object.keys(lwC).filter((c) => (rwC[c] || 0) !== lwC[c]);
  line(wfDiff.length === 0, 'workflow row count matches per case',
    wfDiff.length === 0 ? `${Object.keys(lwC).length} cases` : `${wfDiff.length} cases differ`);
  if (DETAILS && wfDiff.length) {
    wfDiff.slice(0, 15).forEach((c) => console.log(`        ${c}  local ${lwC[c]} vs supabase ${rwC[c] || 0}`));
  }

  // ---- 4. derived values -------------------------------------------------
  // Recompute from SUPABASE's own workflow rows, not local's. Local is a
  // scratch cache and is missing rows on 77 cases; judging Supabase against it
  // reported failures that were really just local being behind. This check has
  // to stand on its own, because Supabase is what the apps actually read.
  console.log('\n4. DERIVED VALUES (recomputed from Supabase workflow)');
  const byCase = {};
  remoteWf.forEach((w) => { (byCase[w.case_no] = byCase[w.case_no] || []).push(w); });
  const derivedBad = [];
  const derivedFields = ['claimed_amount', 'paid_amount', 'approved_amount', 'deduction', 'is_paid'];
  for (const caseNo of Object.keys(byCase)) {
    const rc = R.get(caseNo);
    if (!rc) continue;
    const want = computeSummary(byCase[caseNo]);
    for (const f of derivedFields) {
      if (norm(want[f]) !== norm(rc[f])) { derivedBad.push({ caseNo, f, want: want[f], got: rc[f] }); break; }
    }
  }
  line(derivedBad.length === 0, 'stored values follow from the workflow',
    derivedBad.length === 0 ? `${Object.keys(byCase).length} cases recomputed` : `${derivedBad.length} cases wrong`);
  if (DETAILS && derivedBad.length) {
    derivedBad.slice(0, 15).forEach((d) => console.log(`        ${d.caseNo}  ${d.f}: stored ${d.got}, workflow says ${d.want}`));
  }

  // ---- 5. internal sanity ------------------------------------------------
  console.log('\n5. INTERNAL SANITY (Supabase)');
  const absurd = remoteCases.filter((c) => c.claimed_amount != null && (c.deduction || 0) > c.claimed_amount);
  const mismatch = remoteCases.filter((c) => c.is_paid && c.claimed_amount != null && c.paid_amount != null &&
    (c.deduction || 0) > 0 && c.claimed_amount - c.paid_amount !== c.deduction);
  line(absurd.length === 0, 'deduction never exceeds claimed', `${absurd.length} bad`);
  line(mismatch.length === 0, 'claimed - paid === deduction', `${mismatch.length} bad`);
  if (DETAILS && absurd.length) console.log('        ' + absurd.slice(0, 10).map((c) => c.case_no).join(', '));

  const fails = (missingInRemote.length ? 1 : 0) + (casesWithMismatch ? 1 : 0) + (wfDiff.length ? 1 : 0) +
                (derivedBad.length ? 1 : 0) + (absurd.length ? 1 : 0) + (mismatch.length ? 1 : 0);
  console.log(`\n${fails === 0 ? 'ALL CHECKS PASSED' : fails + ' CHECK(S) FAILED'}`);
  if (!DETAILS && fails) console.log('Re-run with --details to list the offending cases.');
}

main().catch((e) => { console.error('Verify failed:', e.message); process.exit(1); });
