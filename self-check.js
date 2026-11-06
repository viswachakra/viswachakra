// Daily self-check: is what the app shows the same as what the portal shows?
//
// Every error found by hand in November 2026 was the app holding an older
// status than the portal - a case filed, discharged or approved on the portal
// that the app still showed in yesterday's list. Nothing compared the two, so
// the first to notice was whoever looked at the patient.
//
// This asks the portal, status by status, "which cases are here right now?"
// for every status that feeds an Alerts tile, and compares that list with the
// app's own (Supabase). Where they differ it re-reads those cases and checks
// again. The outcome is stored for the web app's Sync History page and
// appended to logs/self-check.log.
//
//   node self-check.js              check, repair, report
//   node self-check.js --no-heal    check and report only
//   node self-check.js --headless   no browser window (the scheduled task uses this)
//
// One portal session per account: this stands in for the user for 10-20
// minutes, so it is scheduled for early morning.
require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { chromium } = require('playwright');
const { createClient } = require('@supabase/supabase-js');
const S = require('./scraper');

const HEAL = !process.argv.includes('--no-heal');
const HEADLESS = process.argv.includes('--headless') || process.env.HEADLESS === 'true';
const MAX_HEAL = 150; // more than this is not drift, it is a breakage: report, do not grind
const LOG = path.join(__dirname, 'logs', 'self-check.log');
// While this file exists the hourly sync stands aside (run-hourly-sync.ps1): the portal
// allows one session per account, and a second login would end this one mid-check.
const LOCK = path.join(__dirname, 'logs', 'self-check.lock');
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });

function log(m) {
  const line = `${new Date().toTimeString().slice(0, 8)} ${m}`;
  console.log(line);
  try { fs.appendFileSync(LOG, line + '\n'); } catch (e) { /* console still has it */ }
}

// ---- which portal statuses matter ---------------------------------------------
// The same patterns the Alerts page uses (webapp/index.html, the al* filters).
// A status feeds a tile when a case sitting in it appears in one of the lists.
const TILES = [
  ['Preauth queries open', /^Preauthorisation .*Pending/i],
  ['In ward after surgery', /^Surgery Update/i],
  ['Claims to file', /^Discharge Update/i],
  ['CTD / CEO pending', /Returned to NWH|Medco not updated/i],
  ['With the Trust', /^Claim sent to Claim Executive|^Claim sent to Panel Doctor|Recommend (Approval|Rejection) to (CTD|EO)|Claim Resubmitted by NWH/i],
  ['Awaiting CEO', /sent to ceo|forwarded to ceo/i],
  ['CEO approved', /^CEO Claim Approved/i],
  // not a tile, but the step before one: a stale row here is tomorrow's missing alert
  ['Preauth approved, surgery not posted', /^Preauthorisation (PPD|PTD) Approved/i],
];
const tileOf = (status) => { const t = TILES.find(([, re]) => re.test(status || '')); return t ? t[0] : null; };
// Settled statuses hold thousands of cases; a count is enough to see drift.
const COUNT_ONLY = /^Claim Paid( \(BDS\))?$|^Preauthorisation (PPD|PTD) Rejected$/i;

const bare = (caseNo) => String(caseNo || '').trim().replace(/^.*\//, '');

// 1,408 old cases are on the portal but deliberately not in the app: they are
// not in the doctor's own export and were removed on 5 Oct 2026 (backup in
// backup-extras.json). They are expected in the portal's counts, and a
// difference made only of them is never "repaired" back in.
const EXCLUDED = (() => {
  try {
    const b = JSON.parse(fs.readFileSync(path.join(__dirname, 'backup-extras.json'), 'utf8'));
    return new Map((b.cases || []).map((c) => [bare(c.case_no), c.claim_status || c.case_status || '']));
  } catch (e) { return new Map(); }
})();

async function fetchAppCases() {
  const out = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb.from('cases').select('case_no,claim_status,status_date,is_paid')
      .order('case_no').range(from, from + 999);
    if (error) throw new Error('Supabase read failed: ' + error.message);
    out.push(...data);
    if (data.length < 1000) break;
  }
  return out;
}

/** One status on the portal: every case in it, or just the count. */
async function portalStatus(page, values, countOnly) {
  const rows = new Map(); let total = 0;
  for (const value of values) { // a status text can sit under two option values
    let done = false, lastErr = null;
    for (let attempt = 1; attempt <= 3 && !done; attempt++) {
      try {
        await S.gotoCasesSearch(page, () => {});
        const set = await page.evaluate((v) => {
          const sel = document.querySelector('select[name=CaseStatus]');
          if (!sel) return false;
          sel.value = v; return sel.value === v;
        }, value);
        if (!set) throw new Error('Claim Status option ' + value + ' not found');
        const n = await S.runSearch(page, () => {}, { countOnly });
        if (!countOnly && n > 0) {
          const list = await S.scrapeResultsList(page);
          if (list.length < n) throw new Error(`partial list ${list.length}/${n}`);
          for (const r of list) rows.set(bare(r.case_no), r);
        } else if (n === 0) {
          const empty = await page.evaluate(() => /No\s+(records|results)\s+found/i.test(document.body ? document.body.textContent : '')).catch(() => false);
          if (!empty) throw new Error('no results table (timeout or blocked)');
        }
        total += n; done = true;
      } catch (e) { lastErr = e; await page.waitForTimeout(4000); }
    }
    if (!done) throw lastErr;
  }
  return { total, rows };
}

async function main() {
  const started = new Date();
  fs.writeFileSync(LOCK, started.toISOString());
  log(`===== self-check started ${started.toLocaleString('en-IN')} | heal: ${HEAL} =====`);
  const report = { at: started.toISOString(), ok: false, statuses: [], tiles: [], healed: [], remaining: [], notes: [] };

  const app = await fetchAppCases();
  const appBy = new Map(app.map((c) => [bare(c.case_no), c]));
  log(`app holds ${app.length} cases`);

  // ---- 1. ask the portal ----
  const browser = await chromium.launch({ channel: 'chrome', headless: HEADLESS });
  const portal = new Map(); // status text -> { total, rows }
  try {
    const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
    ctx.on('page', (p) => p.on('dialog', (d) => d.accept().catch(() => {})));
    const page = await S.login(ctx, () => {});
    await S.gotoCasesSearch(page, () => {});
    const options = await page.evaluate(() => {
      const sel = document.querySelector('select[name=CaseStatus]');
      return sel ? [...sel.options].map((o) => ({ value: o.value, text: o.text.trim() })) : [];
    });
    if (options.length < 50) throw new Error('Claim Status list did not load (' + options.length + ' options)');
    const byText = new Map();
    for (const o of options) { if (o.value === '-1') continue; if (!byText.has(o.text)) byText.set(o.text, []); byText.get(o.text).push(o.value); }

    // statuses to check: every one that feeds a tile, plus every one the app
    // currently holds an unsettled case in, plus the settled ones by count
    const appStatuses = new Set(app.filter((c) => !c.is_paid).map((c) => c.claim_status).filter(Boolean));
    const want = [...byText.keys()].filter((t) => tileOf(t) || appStatuses.has(t) || COUNT_ONLY.test(t));
    for (const t of appStatuses) if (!byText.has(t)) report.notes.push(`The app holds cases in "${t}", which the portal no longer offers as a status.`);
    log(`checking ${want.length} of ${byText.size} portal statuses`);

    for (let i = 0; i < want.length; i++) {
      const text = want[i], countOnly = COUNT_ONLY.test(text) && !tileOf(text);
      const r = await portalStatus(page, byText.get(text), countOnly);
      portal.set(text, { ...r, countOnly });
      if (r.total) log(`  [${i + 1}/${want.length}] ${text}: ${r.total}`);
    }
  } finally { await browser.close().catch(() => {}); }

  // ---- 2. compare ----
  const compare = (appNow) => {
    const out = []; const bad = new Set();
    const appByNow = new Map(appNow.map((c) => [bare(c.case_no), c]));
    for (const [text, p] of portal) {
      const mine = appNow.filter((c) => c.claim_status === text);
      const row = { status: text, tile: tileOf(text), portal: p.total, app: mine.length, missing: [], extra: [], dateDiff: [] };
      if (!p.countOnly) {
        for (const k of p.rows.keys()) { const c = appByNow.get(k); if (!c && EXCLUDED.has(k)) continue; if (!c || c.claim_status !== text) { row.missing.push(k); bad.add(k); } }
        for (const c of mine) { const k = bare(c.case_no); if (!p.rows.has(k)) { row.extra.push(k); bad.add(k); } }
        // the deadline arithmetic rests on the status date: it has to match too
        if (row.tile) for (const [k, r] of p.rows) { const c = appByNow.get(k); if (c && c.claim_status === text && r.status_date && (c.status_date || '').slice(0, 16) !== r.status_date.slice(0, 16)) { row.dateDiff.push(k); bad.add(k); } }
      }
      out.push(row);
    }
    return { rows: out, bad: [...bad] };
  };
  let cmp = compare(app);
  const before = cmp.bad.length;
  log(`differences: ${before} case(s)` + (before ? ' - ' + cmp.bad.slice(0, 12).join(', ') + (before > 12 ? ' …' : '') : ''));

  // ---- 3. repair what differs, then look again ----
  if (HEAL && before > 0 && before <= MAX_HEAL) {
    log(`re-reading ${before} case(s) from the portal`);
    try {
      await S.rescrapeCases(cmp.bad.map((k) => (appBy.get(k) ? appBy.get(k).case_no : 'CASE/5722/' + k)), { headless: HEADLESS, log: () => {} });
      execSync('node push-to-supabase.js --since-minutes 60', { cwd: __dirname, stdio: 'pipe' });
      const after = compare(await fetchAppCases());
      report.healed = cmp.bad.filter((k) => !after.bad.includes(k));
      cmp = after;
      log(`repaired ${report.healed.length}, still different ${cmp.bad.length}`);
    } catch (e) { report.notes.push('Repair did not finish: ' + String(e.message || e).split('\n')[0]); log('repair failed: ' + e.message); }
  } else if (before > MAX_HEAL) {
    report.notes.push(`${before} cases differ - too many to be ordinary drift, so nothing was re-read. The sync needs a look.`);
  }

  // ---- 4. report ----
  report.statuses = cmp.rows.filter((r) => r.portal || r.app).map((r) => ({ ...r, missing: r.missing.slice(0, 40), extra: r.extra.slice(0, 40), dateDiff: r.dateDiff.slice(0, 40) }));
  report.remaining = cmp.bad.slice(0, 100);
  report.before = before;
  report.checked = portal.size;
  report.tiles = TILES.map(([name]) => { const rs = cmp.rows.filter((r) => r.tile === name); return { tile: name, portal: rs.reduce((t, r) => t + r.portal, 0), app: rs.reduce((t, r) => t + r.app, 0), ok: rs.every((r) => !r.missing.length && !r.extra.length && !r.dateDiff.length) }; });
  // settled statuses are compared by count only
  for (const r of cmp.rows) {
    if (!portal.get(r.status).countOnly) continue;
    const old = [...EXCLUDED.entries()].filter(([k, st]) => st === r.status && !appBy.has(k)).length;
    const gap = r.portal - r.app - old;
    if (gap !== 0) report.notes.push(`"${r.status}": the portal lists ${r.portal}; the app holds ${r.app} and ${old} are old cases left out on purpose; ${Math.abs(gap)} ${gap > 0 ? 'on the portal are not accounted for' : 'more in the app than on the portal'}.`);
  }
  report.ok = cmp.bad.length === 0;
  report.minutes = Math.round((Date.now() - started) / 60000);

  // keep a short history so the page can show the last week at a glance
  let history = [];
  try { const { data } = await sb.from('app_settings').select('value').eq('key', 'self_check').maybeSingle(); if (data && data.value) history = JSON.parse(data.value).history || []; } catch (e) { /* first run */ }
  report.history = [{ at: report.at, ok: report.ok, before, healed: report.healed.length, remaining: cmp.bad.length }, ...history].slice(0, 14);
  const { error } = await sb.from('app_settings').upsert({ key: 'self_check', value: JSON.stringify(report), updated_at: new Date().toISOString(), updated_by: 'self-check' }, { onConflict: 'key' });
  if (error) log('could not store the report: ' + error.message);

  for (const t of report.tiles) log(`  ${t.ok ? 'OK  ' : 'DIFF'} ${t.tile}: portal ${t.portal}, app ${t.app}`);
  for (const n of report.notes) log('  note: ' + n);
  log(`===== self-check ${report.ok ? 'PASSED' : 'FOUND DIFFERENCES'}: ${before} differed, ${report.healed.length} repaired, ${cmp.bad.length} remaining | ${report.minutes} min =====`);
  return report;
}

const unlock = () => { try { fs.unlinkSync(LOCK); } catch (e) { /* already gone */ } };
if (require.main === module) {
  main().then((r) => { unlock(); process.exit(r.ok ? 0 : 2); }).catch(async (e) => {
    unlock();
    log('self-check FAILED: ' + (e.message || e));
    try { await sb.from('app_settings').upsert({ key: 'self_check_error', value: JSON.stringify({ at: new Date().toISOString(), error: String(e.message || e).split('\n')[0] }), updated_at: new Date().toISOString(), updated_by: 'self-check' }, { onConflict: 'key' }); } catch (x) { /* nothing more to do */ }
    process.exit(1);
  });
}
module.exports = { main };
