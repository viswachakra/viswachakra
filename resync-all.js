// Full resync: deep-scrape EVERY case's workflow from the portal by case number and push
// workflow rows + recomputed settlement detail to Supabase. Restores the full workflow
// (~23k rows) and settlement amounts after the DB rebuild. Crash-safe + resumable.
//
// Does NOT touch claimed_amount (that's the portal-list value already loaded) or the
// list fields — only workflow + paid_amount/paid_date/settlement_days/deduction/is_paid/
// latest_comment*. Legacy "-"-labelled paid rows are patched afterward by patch-paid-legacy.js.
//
// Usage: node resync-all.js [--limit N]
require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const fs = require('fs');
const path = require('path');
const { scrapeCaseWorkflows } = require('./scraper');
const { createClient } = require('@supabase/supabase-js');
const s = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });
process.on('unhandledRejection', (e) => { console.error('unhandledRejection:', (e && e.message) || e); process.exit(1); });
process.on('uncaughtException', (e) => { console.error('uncaughtException:', (e && e.message) || e); process.exit(1); });
const withTimeout = (p, ms, label) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(label + ' timeout ' + ms + 'ms')), ms))]);

function arg(name, fb) { const i = process.argv.indexOf('--' + name); return i > -1 ? process.argv[i + 1] : fb; }
const MON = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
function parseWfDate(str) { const m = String(str || '').match(/(\d{1,2})-([A-Za-z]{3})-(\d{4})\s+(\d{1,2}):(\d{2})\s*(AM|PM)?/i); if (!m) return null; let h = +m[4]; const ap = (m[6] || '').toUpperCase(); if (ap === 'PM' && h < 12) h += 12; if (ap === 'AM' && h === 12) h = 0; return new Date(+m[3], MON[m[2].toLowerCase()], +m[1], h, +m[5]); }
function parseAmt(v) { const n = parseInt(String(v == null ? '' : v).replace(/[^0-9]/g, ''), 10); return isNaN(n) ? 0 : n; }

function computeDetail(rows) {
  rows = rows.slice().sort((a, b) => a.row_index - b.row_index);
  const initiated = rows.find(r => /initiated/i.test(r.action || '')) || rows[0];
  const paidRow = [...rows].reverse().find(r => /paid/i.test(r.action || ''));
  const last = rows[rows.length - 1];
  const claimed = initiated ? parseAmt(initiated.amount) : 0;
  const initAt = initiated ? parseWfDate(initiated.date_time) : null;
  let paid = null, paidDate = null, settlement = null, deduction = null;
  if (paidRow) {
    paid = parseAmt(paidRow.amount); paidDate = paidRow.date_time || null;
    const paidAt = parseWfDate(paidRow.date_time);
    if (claimed > 0) deduction = Math.max(0, claimed - paid);
    if (initAt && paidAt) { const d = Math.round((paidAt - initAt) / 864e5); if (d >= 0) settlement = d; }
  }
  return {
    paid_amount: paid, paid_date: paidDate, settlement_days: settlement, deduction, is_paid: !!paidRow,
    latest_comment: last ? (last.remarks || '') : '', latest_comment_by: last ? (last.role_name || last.action || '') : '',
    latest_comment_date: last ? (last.date_time || '') : '',
  };
}

async function fetchAllCaseNos() {
  const out = []; let f = 0;
  while (true) { const { data, error } = await s.from('cases').select('case_no').order('case_no').range(f, f + 999); if (error) throw new Error(error.message); if (!data || !data.length) break; out.push(...data.map(r => r.case_no)); if (data.length < 1000) break; f += 1000; }
  return out;
}

async function pushCase(caseNo, rows) {
  await s.from('claim_workflow').delete().eq('case_no', caseNo);
  if (rows.length) {
    const recs = rows.map((r, i) => ({ case_no: caseNo, row_index: i, date_time: r.date_time, role_name: r.role_name, remarks: r.remarks, action: r.action, amount: r.amount }));
    const { error } = await s.from('claim_workflow').upsert(recs, { onConflict: 'case_no,row_index' });
    if (error) throw new Error('workflow upsert ' + caseNo + ': ' + error.message);
  }
  const detail = computeDetail(rows);
  const { error } = await s.from('cases').upsert({ case_no: caseNo, ...detail }, { onConflict: 'case_no' });
  if (error) throw new Error('detail upsert ' + caseNo + ': ' + error.message);
}

(async () => {
  const limit = parseInt(arg('limit', '0'), 10);
  fs.mkdirSync(path.join(__dirname, 'logs'), { recursive: true });
  const doneFile = path.join(__dirname, 'logs', 'resync-all-done.txt');
  const doneSet = new Set(fs.existsSync(doneFile) ? fs.readFileSync(doneFile, 'utf8').split(/\r?\n/).map(l => l.trim()).filter(Boolean) : []);
  let caseNos = (await fetchAllCaseNos()).filter(c => !doneSet.has(c));
  if (limit > 0) caseNos = caseNos.slice(0, limit);
  console.log(`Full resync: ${caseNos.length} cases to deep-scrape (skipping ${doneSet.size} already done)`);

  const logFile = path.join(__dirname, 'logs', 'resync-all.log');
  fs.appendFileSync(logFile, `\nresync-all resumed ${new Date().toISOString()} (${caseNos.length} remaining)\n`);

  let done = 0, failed = 0;
  const onResult = async (r) => {
    if (r.ok) { try { await withTimeout(pushCase(r.case_no, r.rows), 30000, 'supabase push'); fs.appendFileSync(doneFile, r.case_no + '\n'); } catch (e) { r.ok = false; r.note = e.message; } }
    if (!r.ok) failed++;
    done++;
    const line = `${done}/${caseNos.length} ${r.case_no} ${r.ok ? 'ok ' + r.rows.length + ' wf rows' : 'FAILED ' + (r.note || '')}`;
    if (done % 25 === 0 || !r.ok) console.log('  ' + line);
    fs.appendFileSync(logFile, line + '\n');
  };
  const compactLog = (m) => { if (/failed|re-login|Logged in OK|Login failed/i.test(m)) console.log('  ' + m); };
  await scrapeCaseWorkflows(caseNos, { headless: true, onResult, reloginEvery: 30, maxTries: 3, log: compactLog });

  console.log(`\nDone. ${done - failed} resynced, ${failed} failed.`);
  if (failed) console.log('Re-run to retry failed cases (safe - resumes from done-file).');
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
