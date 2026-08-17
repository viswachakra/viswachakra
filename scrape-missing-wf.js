// Deep-scrape workflow for a specific list of case numbers (logs/no-workflow.txt) and push
// workflow + settlement detail. Sets claimed_amount from the workflow's initiated row only
// when the case has none yet (new cases). Resumable via done-file. Session-resilient engine.
require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const fs = require('fs');
const path = require('path');
const { scrapeCaseWorkflows } = require('./scraper');
const { createClient } = require('@supabase/supabase-js');
const s = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });
process.on('unhandledRejection', (e) => { console.error('unhandledRejection:', (e && e.message) || e); process.exit(1); });
const withTimeout = (p, ms, label) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(label + ' timeout ' + ms + 'ms')), ms))]);
const MON = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
function parseWfDate(str) { const m = String(str || '').match(/(\d{1,2})-([A-Za-z]{3})-(\d{4})\s+(\d{1,2}):(\d{2})\s*(AM|PM)?/i); if (!m) return null; let h = +m[4]; const ap = (m[6] || '').toUpperCase(); if (ap === 'PM' && h < 12) h += 12; if (ap === 'AM' && h === 12) h = 0; return new Date(+m[3], MON[m[2].toLowerCase()], +m[1], h, +m[5]); }
function parseAmt(v) { const n = parseInt(String(v == null ? '' : v).replace(/[^0-9]/g, ''), 10); return isNaN(n) ? 0 : n; }

function computeDetail(rows, currentClaimed) {
  rows = rows.slice().sort((a, b) => a.row_index - b.row_index);
  const initiated = rows.find(r => /initiated/i.test(r.action || '')) || rows[0];
  const paidRow = [...rows].reverse().find(r => /paid/i.test(r.action || ''));
  const last = rows[rows.length - 1];
  const claimed = initiated ? parseAmt(initiated.amount) : 0;
  const initAt = initiated ? parseWfDate(initiated.date_time) : null;
  let paid = null, paidDate = null, settlement = null, deduction = null;
  if (paidRow) { paid = parseAmt(paidRow.amount); paidDate = paidRow.date_time || null; const paidAt = parseWfDate(paidRow.date_time); if (claimed > 0) deduction = Math.max(0, claimed - paid); if (initAt && paidAt) { const d = Math.round((paidAt - initAt) / 864e5); if (d >= 0) settlement = d; } }
  const detail = { paid_amount: paid, paid_date: paidDate, settlement_days: settlement, deduction, is_paid: !!paidRow, latest_comment: last ? (last.remarks || '') : '', latest_comment_by: last ? (last.role_name || last.action || '') : '', latest_comment_date: last ? (last.date_time || '') : '' };
  if ((currentClaimed == null) && claimed > 0) detail.claimed_amount = claimed; // fill only when missing
  return detail;
}

async function pushCase(caseNo, rows, currentClaimed) {
  await s.from('claim_workflow').delete().eq('case_no', caseNo);
  if (rows.length) { const recs = rows.map((r, i) => ({ case_no: caseNo, row_index: i, date_time: r.date_time, role_name: r.role_name, remarks: r.remarks, action: r.action, amount: r.amount })); const { error } = await s.from('claim_workflow').upsert(recs, { onConflict: 'case_no,row_index' }); if (error) throw new Error('wf ' + caseNo + ': ' + error.message); }
  const { error } = await s.from('cases').upsert({ case_no: caseNo, ...computeDetail(rows, currentClaimed) }, { onConflict: 'case_no' });
  if (error) throw new Error('detail ' + caseNo + ': ' + error.message);
}

(async () => {
  const file = process.argv[2] || path.join(__dirname, 'logs', 'no-workflow.txt');
  let caseNos = fs.readFileSync(file, 'utf8').split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const doneFile = path.join(__dirname, 'logs', 'scrape-missing-done.txt');
  const done = new Set(fs.existsSync(doneFile) ? fs.readFileSync(doneFile, 'utf8').split(/\r?\n/).map(l => l.trim()).filter(Boolean) : []);
  caseNos = caseNos.filter(c => !done.has(c));
  // current claimed_amount for each (so we only fill when missing)
  const claimedBy = {};
  for (let i = 0; i < caseNos.length; i += 500) { const { data } = await s.from('cases').select('case_no,claimed_amount').in('case_no', caseNos.slice(i, i + 500)); (data || []).forEach(r => { claimedBy[r.case_no] = r.claimed_amount; }); }
  console.log(`deep-scraping ${caseNos.length} cases missing workflow (skipping ${done.size} done)`);
  let n = 0, failed = 0, withWf = 0;
  const onResult = async (r) => {
    if (r.ok) { try { await withTimeout(pushCase(r.case_no, r.rows, claimedBy[r.case_no]), 30000, 'push'); fs.appendFileSync(doneFile, r.case_no + '\n'); if (r.rows.length) withWf++; } catch (e) { r.ok = false; r.note = e.message; } }
    if (!r.ok) failed++; n++;
    if (n % 10 === 0 || !r.ok) console.log(`  ${n}/${caseNos.length} ${r.case_no} ${r.ok ? 'ok ' + r.rows.length + ' wf' : 'FAILED ' + (r.note || '')}`);
  };
  await scrapeCaseWorkflows(caseNos, { headless: true, onResult, reloginEvery: 25, maxTries: 3, log: (m) => { if (/Logged in OK|Login failed|re-login/i.test(m)) console.log('  ' + m); } });
  console.log(`\nDone. ${n - failed} scraped (${withWf} had workflow), ${failed} failed.`);
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
