// Repair cases that the date-window sweep cannot see, by looking them up
// directly by CASE NUMBER.
//
// Searching by CaseNo lands on a results row, which carries the list fields a
// procType-filtered date search never returned for these cases: patient_name,
// claim_status, status_date, claim_no, card_no, ip_registration_dt. The detail
// page then gives district/mandal/village/contact/hospital/category/procedure,
// and the Claim tab gives the workflow.
//
// If the portal has no such case, it is recorded in phantom-cases.json for
// deletion - but only after a SECOND lookup confirms it, because a timeout and
// a genuinely absent record look identical from here.
//
// Read-then-write: updates existing rows, never inserts.
//
// Usage:
//   node repair-by-caseno.js               # dry run
//   node repair-by-caseno.js --apply
require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const fs = require('fs');
const { chromium } = require('playwright');
const { createClient } = require('@supabase/supabase-js');
const { pageAllChecked } = require('./supabase-page');
const s = require('./scraper');

const APPLY = process.argv.includes('--apply');
const STATE = 'repair-progress.json';
const blank = v => v === null || v === undefined || String(v).trim() === '';
const load = () => (fs.existsSync(STATE) ? JSON.parse(fs.readFileSync(STATE, 'utf8')) : { done: {} });
const save = st => fs.writeFileSync(STATE, JSON.stringify(st, null, 1));

(async () => {
  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });
  const rows = await pageAllChecked(sb, 'cases', 'case_no,status_date,patient_name,claimed_amount,is_paid');
  const st = load();
  const targets = rows.filter(c => blank(c.status_date) && !st.done[c.case_no]);
  console.log(`cases needing repair: ${targets.length}  (already done: ${Object.keys(st.done).length})`);
  if (!targets.length) { console.log('nothing to do'); return; }
  if (!APPLY) { console.log('\nDRY RUN - re-run with --apply'); return; }

  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  let repaired = 0, phantom = 0;
  const phantoms = [];
  try {
    let pg = await s.login(ctx, m => console.log('  ' + m));
    for (let i = 0; i < targets.length; i++) {
      const c = targets[i];
      const tag = `[${i + 1}/${targets.length}] ${c.case_no}`;
      try {
        await s.searchCaseByNo(pg, c.case_no, () => {});
        // the results row carries the list fields
        const list = (await s.scrapeResultsList(pg)).find(r => r.case_no === c.case_no) || null;
        const opened = await s.openCaseByText(pg, c.case_no);

        if (!list && !opened) {
          // second opinion before calling it a phantom
          await s.searchCaseByNo(pg, c.case_no, () => {});
          const again = (await s.scrapeResultsList(pg)).find(r => r.case_no === c.case_no) || null;
          const openedAgain = await s.openCaseByText(pg, c.case_no);
          if (!again && !openedAgain) {
            phantom++; phantoms.push(c.case_no);
            st.done[c.case_no] = 'PHANTOM'; save(st);
            console.log(`${tag}  NOT ON PORTAL (confirmed twice)`);
            continue;
          }
        }

        const patch = { case_no: c.case_no };
        for (const f of ['claim_no','patient_name','card_no','claim_status','source_registration','status_date','ip_registration_dt']) {
          if (list && !blank(list[f])) patch[f] = String(list[f]).trim();
        }
        if (opened) {
          const d = await s.scrapeCaseDetails(pg);
          for (const f of ['district','mandal','village','contact_no','nwh_name','nwh_type','ip_no','category','procedure_name','case_status']) {
            if (!blank(d[f])) patch[f] = String(d[f]).trim();
          }
          const flow = await s.scrapeClaimWorkflow(pg, () => {});
          const wf = (flow.rows || []).map((r, idx) => ({
            case_no: c.case_no, row_index: idx,
            date_time: r.date_time, role_name: r.role_name,
            remarks: r.remarks, action: r.action, amount: r.amount,
          }));
          if (wf.length) {
            await sb.from('claim_workflow').delete().eq('case_no', c.case_no);
            const { error } = await sb.from('claim_workflow').upsert(wf, { onConflict: 'case_no,row_index' });
            if (error) throw new Error('workflow: ' + error.message);
          }
        }
        if (Object.keys(patch).length > 1) {
          const { error } = await sb.from('cases').upsert([patch], { onConflict: 'case_no' });
          if (error) throw new Error('cases: ' + error.message);
        }
        repaired++; st.done[c.case_no] = 'REPAIRED'; save(st);
        console.log(`${tag}  repaired (${Object.keys(patch).length - 1} fields)`);
      } catch (e) {
        console.log(`${tag}  error: ${String(e.message).split('\n')[0].slice(0, 60)}`);
        try { pg = await s.login(ctx, () => {}); } catch (_) {}
      }
    }
  } finally { await browser.close().catch(() => {}); }
  if (phantoms.length) fs.writeFileSync('phantom-cases.json', JSON.stringify(phantoms, null, 1));
  console.log(`\nrepaired : ${repaired}`);
  console.log(`phantom  : ${phantom}${phantoms.length ? '  -> phantom-cases.json' : ''}`);
})().catch(e => { console.error('failed:', e.message); process.exit(1); });
