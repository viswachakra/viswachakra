// Fill in the case fields that only appear on the portal's SEARCH RESULTS page.
//
// The 1,311 cases recovered on 2026-10-04 were pulled with rescrapeCases(),
// which is a workflow-only deep scrape - its own docstring says it "does not
// touch list fields". So their workflow and money came through (95%), but
// patient_name, claim_status, status_date, claim_no, card_no and
// ip_registration_dt are all empty. The doctor would see 1,311 nameless rows.
//
// Those fields live on the results list, which is far cheaper to read than
// opening each case: one page load returns up to 1000 rows. portal-completeness
// .json already records which months contain cases, so only those are walked.
//
// The portal is the source of truth, but a BLANK portal value never overwrites
// a non-blank stored one - a failed cell read must not erase good data.
//
// Read-then-write: it updates existing rows only, and never inserts.
//
// IMPORTANT: one session per account - disable ViswachakraHourlySync first.
//
// Usage:
//   node backfill-list-fields.js                  # dry run
//   node backfill-list-fields.js --apply
//   node backfill-list-fields.js --apply --from 2017-01
require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
const scraper = require('./scraper');
const { pageAllChecked } = require('./supabase-page');

const arg = (n, d = null) => {
  const i = process.argv.indexOf('--' + n);
  return i > -1 ? process.argv[i + 1] : d;
};
const APPLY = process.argv.includes('--apply');
const SWEEP = path.join(__dirname, 'portal-completeness.json');
const STATE = path.join(__dirname, 'listfields-progress.json');

const LIST_FIELDS = [
  'claim_no', 'patient_name', 'card_no', 'claim_status',
  'source_registration', 'status_date', 'ip_registration_dt',
];

const blank = (v) => v === null || v === undefined || String(v).trim() === '';

const loadState = () => (fs.existsSync(STATE) ? JSON.parse(fs.readFileSync(STATE, 'utf8')) : { done: {} });
const saveState = (s) => fs.writeFileSync(STATE, JSON.stringify(s, null, 1));

async function main() {
  if (!fs.existsSync(SWEEP)) {
    console.error('portal-completeness.json not found - run verify-completeness.js first.');
    process.exit(1);
  }
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
    auth: { persistSession: false },
  });

  console.log('Reading Supabase...');
  const existing = await pageAllChecked(supabase, 'cases',
    ['case_no', ...LIST_FIELDS].join(','));
  const byCase = new Map(existing.map((c) => [c.case_no, c]));
  const emptyNow = existing.filter((c) => blank(c.patient_name)).length;
  console.log(`  ${existing.length} cases, ${emptyNow} with no patient name\n`);

  // only months the sweep found cases in
  const sweep = JSON.parse(fs.readFileSync(SWEEP, 'utf8'));
  const state = loadState();
  const from = arg('from');
  let months = Object.entries(sweep.months || {})
    .filter(([, v]) => (v.listed || 0) > 0)
    .map(([k]) => k)
    .filter((k) => !state.done[k])
    .filter((k) => !from || k >= from)
    .sort();

  console.log(`months with cases, still to walk : ${months.length}`);
  if (!months.length) { console.log('Nothing to do.'); return; }
  if (!APPLY) {
    console.log('  ' + months.slice(0, 12).join(', ') + (months.length > 12 ? ' ...' : ''));
    console.log('\nDRY RUN - nothing written. Re-run with --apply.');
    return;
  }

  const pad = (n) => String(n).padStart(2, '0');
  const windows = months.map((m) => {
    const [y, mo] = m.split('-').map(Number);
    const last = new Date(y, mo, 0).getDate();
    return [`01/${pad(mo)}/${y} 00:00`, `${last}/${pad(mo)}/${y} 23:59`];
  });

  let updatedTotal = 0;
  let seenTotal = 0;

  await scraper.listRanges(windows, {
    headless: true,
    log: (m) => process.stdout.write(`  ${m}\n`),
    onResult: async (r, i) => {
      const label = months[i];
      if (!r.ok) { console.log(`  ${label}: FAILED - will retry on the next run`); return; }
      const records = r.records || [];
      seenTotal += records.length;

      const updates = [];
      for (const rec of records) {
        const cur = byCase.get(rec.case_no);
        if (!cur) continue;                       // not in Supabase: not this script's job
        const patch = { case_no: rec.case_no };
        let changed = false;
        for (const f of LIST_FIELDS) {
          const v = rec[f];
          if (blank(v)) continue;                 // never overwrite with blank
          if (String(v).trim() !== String(cur[f] ?? '').trim()) { patch[f] = String(v).trim(); changed = true; }
        }
        if (changed) updates.push(patch);
      }

      if (updates.length) {
        for (let j = 0; j < updates.length; j += 500) {
          const slice = updates.slice(j, j + 500);
          const { error } = await supabase.from('cases').upsert(slice, { onConflict: 'case_no' });
          if (error) throw new Error(`upsert failed (${label}): ${error.message}`);
        }
        updates.forEach((u) => Object.assign(byCase.get(u.case_no), u));
        updatedTotal += updates.length;
      }
      state.done[label] = { listed: records.length, updated: updates.length };
      saveState(state);
      console.log(`  ${label}: ${records.length} listed, ${updates.length} updated  (running total ${updatedTotal})`);
    },
  });

  console.log(`\nrows seen on portal : ${seenTotal}`);
  console.log(`cases updated       : ${updatedTotal}`);
}

main().catch((e) => { console.error('Backfill failed:', e.message); process.exit(1); });
