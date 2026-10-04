// Compare Supabase against the PORTAL, case by case. Read-only.
//
// The portal is the only source of truth. Local SQLite is a scratch cache and
// proves nothing, so this opens each case on the portal, reads its detail page
// and Claim workflow, and reports where Supabase disagrees. It writes NOTHING -
// not to Supabase, not to local SQLite. Corrections are a separate decision.
//
// IMPORTANT: the portal allows ONE session per account. Disable
// ViswachakraHourlySync before running, and do not log into the portal while it
// runs, or both sides fail.
//
// Resumable: every case's verdict is appended to the report file as it is
// checked, and a re-run skips everything already recorded. A 3,500-case run
// takes many hours and WILL be interrupted; that is expected, just run it again.
//
// Usage:
//   node verify-against-portal.js --limit 50            # validation run
//   node verify-against-portal.js --paid-only           # only settled claims
//   node verify-against-portal.js                       # everything
//   node verify-against-portal.js --report out.json     # custom report path
require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
const { chromium } = require('playwright');

const arg = (n, d = null) => {
  const i = process.argv.indexOf('--' + n);
  return i > -1 ? process.argv[i + 1] : d;
};
const REPORT = arg('report', path.join(__dirname, 'portal-audit.json'));
const LIMIT = arg('limit') ? parseInt(arg('limit'), 10) : null;
const PAID_ONLY = process.argv.includes('--paid-only');
const HEADLESS = process.argv.includes('--headed') ? false : true;

// Exactly what scrapeCaseDetails() returns from the portal's detail page.
// Note case_status, NOT claim_status, and no patient_name.
const DETAIL_FIELDS = [
  'case_status', 'claim_no', 'card_no', 'district', 'mandal', 'village',
  'contact_no', 'nwh_name', 'ip_no', 'category', 'procedure_name', 'nwh_type',
];

const parseAmt = (v) => {
  const n = parseInt(String(v == null ? '' : v).replace(/[^0-9]/g, ''), 10);
  return isNaN(n) ? 0 : n;
};
const norm = (v) => {
  if (v === null || v === undefined) return null;
  const s = String(v).trim().replace(/\s+/g, ' ');
  return s === '' ? null : s;
};

// ---- report file (append-only, so a crash keeps what was already checked) ---
function loadReport() {
  if (!fs.existsSync(REPORT)) return { checked: {}, started: new Date().toISOString() };
  try { return JSON.parse(fs.readFileSync(REPORT, 'utf8')); }
  catch { return { checked: {}, started: new Date().toISOString() }; }
}
function saveReport(r) {
  fs.writeFileSync(REPORT, JSON.stringify(r, null, 1));
}

async function main() {
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
    auth: { persistSession: false },
  });

  // ---- what Supabase believes -------------------------------------------
  const page_ = async (table, cols) => {
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
  const cases = await page_('cases',
    'case_no,patient_name,case_status,claim_status,claim_no,card_no,district,mandal,village,' +
    'contact_no,nwh_name,nwh_type,ip_no,category,procedure_name,status_date,' +
    'claimed_amount,paid_amount,approved_amount,deduction,is_paid');
  const wf = await page_('claim_workflow', 'case_no,row_index,action,amount');
  const wfBy = {};
  wf.forEach((w) => { (wfBy[w.case_no] = wfBy[w.case_no] || []).push(w); });
  console.log(`  ${cases.length} cases, ${wf.length} workflow rows\n`);

  const report = loadReport();
  let todo = cases;
  if (PAID_ONLY) todo = todo.filter((c) => c.is_paid);
  todo = todo.filter((c) => !report.checked[c.case_no]);          // resume
  if (LIMIT) todo = todo.slice(0, LIMIT);

  console.log(`already verified : ${Object.keys(report.checked).length}`);
  console.log(`to check now     : ${todo.length}\n`);
  if (!todo.length) { summarise(report); return; }

  // scraper internals are only loaded once we know there is work to do
  const scraper = require('./scraper');

  // The portal allows ONE session per account, and other people log in without
  // warning. When that happens our session dies. Fighting for it would just
  // ping-pong both sides out, so after a few consecutive failures we close the
  // browser entirely, wait, and come back. Progress is already on disk, so
  // nothing is lost by stepping aside.
  const BACKOFF_MIN = parseInt(arg('backoff', '10'), 10);
  const FAILS_BEFORE_BACKOFF = 3;

  let browser = null;
  let ctx = null;
  let pg = null;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function openSession() {
    if (browser) await browser.close().catch(() => {});
    browser = await chromium.launch({ channel: 'chrome', headless: HEADLESS });
    ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
    pg = await scraper.login(ctx, (m) => console.log('  ' + m));
  }

  async function standAside(why) {
    console.log(`\n  !! ${why}`);
    console.log(`  !! someone else is probably on the portal. Closing the browser and`);
    console.log(`  !! waiting ${BACKOFF_MIN} min, then resuming from where we stopped.\n`);
    if (browser) await browser.close().catch(() => {});
    browser = null; ctx = null; pg = null;
    await sleep(BACKOFF_MIN * 60 * 1000);
    for (let attempt = 1; ; attempt++) {
      try {
        await openSession();
        console.log('  .. back in, resuming.\n');
        return;
      } catch (e) {
        const wait = Math.min(attempt, 3) * BACKOFF_MIN;
        console.log(`  !! still cannot log in (${String((e && e.message) || e).split('\n')[0]}); waiting ${wait} min`);
        await sleep(wait * 60 * 1000);
      }
    }
  }

  const t0 = Date.now();
  let done = 0;
  let consecutiveFails = 0;

  try {
    console.log('Logging into the portal...');
    await openSession();

    for (const c of todo) {
      done++;
      try {
        await scraper.searchCaseByNo(pg, c.case_no, () => {});
        const opened = await scraper.openCaseByText(pg, c.case_no);
        if (!opened) {
          report.checked[c.case_no] = { status: 'NOT_FOUND_ON_PORTAL' };
          saveReport(report);
          console.log(`[${done}/${todo.length}] ${c.case_no}  NOT FOUND on portal`);
          continue;
        }
        const detail = await scraper.scrapeCaseDetails(pg);
        const flow = await scraper.scrapeClaimWorkflow(pg, () => {});
        const rows = flow.rows || [];

        // --- compare ---
        // Only the fields scrapeCaseDetails actually returns. It yields
        // case_status (not claim_status) and no patient_name at all - that
        // comes from the search results list, not the detail page.
        const diffs = [];
        for (const f of DETAIL_FIELDS) {
          const portalVal = norm(detail[f]);
          if (portalVal === null) continue;          // portal blank: nothing to assert
          if (portalVal !== norm(c[f])) {
            diffs.push({ field: f, portal: detail[f], supabase: c[f] });
          }
        }
        const supRows = (wfBy[c.case_no] || []).length;
        if (rows.length !== supRows) {
          diffs.push({ field: 'workflow_rows', portal: rows.length, supabase: supRows });
        }
        // money, straight off the portal's own workflow
        const init = rows.find((r) => /initiated/i.test(r.action || ''));
        const paidRow = [...rows].reverse().find((r) => /paid/i.test(r.action || ''));
        const pClaimed = init ? parseAmt(init.amount) : null;
        const pPaid = paidRow ? parseAmt(paidRow.amount) : null;
        if (pClaimed !== null && pClaimed > 0 && c.claimed_amount !== pClaimed) {
          diffs.push({ field: 'claimed_amount', portal: pClaimed, supabase: c.claimed_amount });
        }
        if (pPaid !== null && c.paid_amount !== pPaid) {
          diffs.push({ field: 'paid_amount', portal: pPaid, supabase: c.paid_amount });
        }
        if (!!paidRow !== !!c.is_paid) {
          diffs.push({ field: 'is_paid', portal: !!paidRow, supabase: !!c.is_paid });
        }

        report.checked[c.case_no] = diffs.length
          ? { status: 'DIFFERS', diffs }
          : { status: 'MATCH' };
        saveReport(report);
        consecutiveFails = 0;

        const rate = done / ((Date.now() - t0) / 60000);
        const left = (todo.length - done) / Math.max(rate, 0.1);
        console.log(`[${done}/${todo.length}] ${c.case_no}  ${diffs.length ? 'DIFFERS (' + diffs.map(d => d.field).join(',') + ')' : 'match'}` +
                    `   ${rate.toFixed(1)}/min, ~${Math.round(left)} min left`);
      } catch (e) {
        // A single bad case must not end a multi-hour run. Record it as not-yet
        // verified (deleted from the report) so a later pass retries it rather
        // than leaving a permanent ERROR in the audit.
        const msg = String((e && e.message) || e).split('\n')[0];
        delete report.checked[c.case_no];
        saveReport(report);
        consecutiveFails++;
        console.log(`[${done}/${todo.length}] ${c.case_no}  failed (${consecutiveFails}): ${msg}`);

        if (consecutiveFails >= FAILS_BEFORE_BACKOFF) {
          await standAside(`${consecutiveFails} cases in a row failed`);
          consecutiveFails = 0;
        } else {
          // probably a transient blip on one case - refresh the session cheaply
          try { pg = await scraper.login(ctx, () => {}); } catch (_) { /* handled by the counter */ }
        }
      }
    }
  } finally {
    await browser.close().catch(() => {});
  }

  summarise(report);
}

function summarise(report) {
  const all = Object.entries(report.checked);
  const by = {};
  all.forEach(([, v]) => { by[v.status] = (by[v.status] || 0) + 1; });
  console.log('\n=== PORTAL vs SUPABASE ===');
  console.log('verified so far :', all.length);
  Object.entries(by).sort((a, b) => b[1] - a[1]).forEach(([k, n]) => console.log(`  ${k.padEnd(20)} ${n}`));

  const differing = all.filter(([, v]) => v.status === 'DIFFERS');
  if (differing.length) {
    const fieldTally = {};
    differing.forEach(([, v]) => v.diffs.forEach((d) => { fieldTally[d.field] = (fieldTally[d.field] || 0) + 1; }));
    console.log('\n  which fields disagree:');
    Object.entries(fieldTally).sort((a, b) => b[1] - a[1])
      .forEach(([f, n]) => console.log(`    ${f.padEnd(18)} ${n}`));
    console.log('\n  first few:');
    differing.slice(0, 8).forEach(([cn, v]) => {
      console.log(`    ${cn}`);
      v.diffs.forEach((d) => console.log(`      ${d.field}: portal=${JSON.stringify(d.portal)} supabase=${JSON.stringify(d.supabase)}`));
    });
  }
  console.log(`\nfull report: ${REPORT}`);
}

main().catch((e) => { console.error('Audit failed:', e.message); process.exit(1); });
