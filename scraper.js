// Dr NTR Vaidya Seva portal scraper / sync engine
// CLI usage: node scraper.js [--from "01/07/2026 00:00"] [--to "06/07/2026 23:59"] [--limit 3] [--headless]
require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const { upsertCase, replaceWorkflowForCase, startRun, finishRun } = require('./db');

const BASE = 'https://app.drntrvaidyaseva.ap.gov.in/ASRI';
const DEBUG_DIR = path.join(__dirname, 'debug');
if (!fs.existsSync(DEBUG_DIR)) fs.mkdirSync(DEBUG_DIR);

function arg(name, fallback) {
  const i = process.argv.indexOf('--' + name);
  return i > -1 ? process.argv[i + 1] : fallback;
}

function fmt(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

async function shot(page, name) {
  await page.screenshot({ path: path.join(DEBUG_DIR, name + '.png'), fullPage: true }).catch(() => {});
}

function attachDialogHandler(page, log) {
  page.on('dialog', async (d) => {
    log('  [popup] ' + d.message().slice(0, 120) + ' -> OK');
    await d.accept().catch(() => {});
  });
}

async function login(context, log) {
  const page = await context.newPage();
  attachDialogHandler(page, log);
  log('Opening login page...');
  await page.goto(process.env.LOGIN_URL || BASE + '/', { waitUntil: 'domcontentloaded', timeout: 60000 });

  const user = process.env.VAIDYA_USERNAME;
  const pass = process.env.VAIDYA_PASSWORD;
  if (!user || !pass || pass === 'PUT_YOUR_PASSWORD_HERE') {
    throw new Error('Set VAIDYA_USERNAME and VAIDYA_PASSWORD in the .env file first.');
  }

  await page.locator('input[type="text"]:visible').first().fill(user);
  await page.locator('input[type="password"]:visible').first().fill(pass);
  log('Logging in...');
  await page.locator('button:has-text("Login"), input[value="Login"]').first().click();
  await page.waitForTimeout(6000);

  let dash = null;
  for (let attempt = 0; attempt < 5 && !dash; attempt++) {
    for (const p of context.pages()) {
      const body = (await p.textContent('body').catch(() => '')) || '';
      if (/Welcome/i.test(body) && /Signout|Sign out/i.test(body)) { dash = p; break; }
    }
    if (!dash) await page.waitForTimeout(3000);
  }
  if (!dash) {
    await shot(page, '01-after-login');
    throw new Error('Login failed - no window with "Welcome" found. See debug/01-after-login.png');
  }
  attachDialogHandler(dash, log);
  log('Logged in OK.');
  return dash;
}

async function gotoCasesSearch(page, log) {
  log('Opening Cases Search...');
  const url = BASE + '/authUserViewAction.do?actionVal=CasesSearchView&PersistFlag=N&procType=IP';
  let lastErr;
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await page.waitForTimeout(2000);
      return;
    } catch (e) {
      lastErr = e;
      const msg = String((e && e.message) || e).split('\n')[0];
      // transient network blips (ERR_NETWORK_CHANGED, connection reset, timeouts) — wait and retry
      if (/ERR_NETWORK|ERR_CONNECTION|ERR_TIMED_OUT|net::|Timeout|NS_ERROR/i.test(msg) && attempt < 5) {
        log(`  network hiccup opening search (attempt ${attempt}: ${msg}); retrying in ${attempt * 3}s...`);
        await page.waitForTimeout(attempt * 3000);
        continue;
      }
      throw e;
    }
  }
  throw lastErr;
}

async function setStatusDateRange(page, fromStr, toStr, log) {
  const datePanelVisible = await page.getByText('Status Date', { exact: false }).first().isVisible().catch(() => false);
  if (!datePanelVisible) {
    const visibleLink = page.locator('a:visible', { hasText: 'Click here' }).first();
    if (await visibleLink.count() > 0 && await visibleLink.isVisible().catch(() => false)) {
      await visibleLink.click();
    } else {
      await page.evaluate(() => { if (typeof showSearch === 'function') showSearch(); });
    }
    await page.waitForTimeout(1500);
  }

  const ok = await page.evaluate(({ fromStr, toStr }) => {
    const from = document.getElementById('StatusFrom');
    const to = document.getElementById('StatusTo');
    if (!from || !to) return { ok: false, reason: 'StatusFrom/StatusTo inputs not found' };
    const setVal = (input, v) => {
      input.removeAttribute('readonly');
      input.value = v;
      try {
        const evt = document.createEvent('HTMLEvents');
        evt.initEvent('change', true, false);
        input.dispatchEvent(evt);
      } catch (e) { /* portal onchange handlers (fnCompareDates etc.) may not be loaded yet - value is set, which is what matters */ }
    };
    setVal(from, fromStr);
    setVal(to, toStr);
    return { ok: true };
  }, { fromStr, toStr });

  if (!ok.ok) throw new Error('Could not set Status Date fields: ' + ok.reason);
  log(`Status Date set: ${fromStr} -> ${toStr}`);
}

async function runSearch(page, log, options = {}) {
  log('Clicking Search...');
  // fnSearch() calls the portal's fnCompareDates() internally; on a fresh page load
  // those scripts may not be defined yet ("fnCompareDates is not defined"). Wait for
  // both to exist before invoking, and retry the specific race a few times.
  let clicked = { ok: false };
  for (let attempt = 1; attempt <= 5; attempt++) {
    await page.waitForFunction(
      () => typeof fnSearch === 'function' && typeof fnCompareDates === 'function',
      { timeout: 20000 },
    ).catch(() => {});
    clicked = await page.evaluate(() => {
      try {
        if (typeof fnSearch === 'function' && typeof fnCompareDates === 'function') { fnSearch(); return { ok: true }; }
        const img = Array.from(document.querySelectorAll('img[src*="btn_search"]'))
          .find((el) => el.offsetWidth || el.offsetHeight);
        if (img) { img.click(); return { ok: true }; }
        return { ok: false, reason: 'search fns/button not ready' };
      } catch (e) { return { ok: false, reason: String((e && e.message) || e) }; }
    });
    if (clicked.ok) break;
    log(`  search not ready (attempt ${attempt}: ${clicked.reason}); waiting...`);
    await page.waitForTimeout(3000);
  }
  if (!clicked.ok) throw new Error('Search button (fnSearch / btn_search.gif) not ready: ' + (clicked.reason || 'unknown'));

  log('Waiting for results to load...');
  const deadline = Date.now() + 240000;
  let loaded = false;
  while (Date.now() < deadline && !loaded) {
    await page.waitForTimeout(10000);
    const state = await page.evaluate(() => ({
      hasResults: /Results\s+\d+\s*-\s*\d+\s+of\s+\d+|No\s+(records|results)\s+found/i.test(document.body ? document.body.textContent : ''),
    })).catch(() => null);
    if (state && state.hasResults) loaded = true;
  }
  await page.waitForTimeout(2000);
  await shot(page, '04-results');

  const body = (await page.textContent('body')) || '';
  const m = body.match(/Results\s+\d+\s*-\s*\d+\s+of\s+(\d+)/i);
  const total = m ? parseInt(m[1], 10) : 0;
  log('Total results: ' + (total || '(none)'));

  // count-only: the first results page already shows "... of N"; no need to load all rows.
  // Distinguish a genuine empty result ("No records found") from a failed/timed-out load.
  if (options.countOnly) {
    if (total === 0) {
      const genuineEmpty = await page.evaluate(
        () => /No\s+(records|results)\s+found/i.test(document.body ? document.body.textContent : ''),
      ).catch(() => false);
      if (!genuineEmpty) throw new Error('search returned no results table (timeout/blocked) - needs retry');
    }
    return total;
  }

  if (total > 10) {
    const link1000 = page.locator('a', { hasText: /^1000$/ }).first();
    if (await link1000.isVisible().catch(() => false)) {
      log('Switching to 1000 per page...');
      await link1000.click();
      // wait until the page shows ALL results on one page ("Results 1 - N of N")
      const deadline2 = Date.now() + 180000;
      while (Date.now() < deadline2) {
        await page.waitForTimeout(5000);
        const allShown = await page.evaluate((expected) => {
          const m = (document.body ? document.body.textContent : '').match(/Results\s+1\s*-\s*(\d+)\s+of\s+(\d+)/i);
          return !!m && m[1] === m[2] && parseInt(m[2], 10) === expected;
        }, total).catch(() => false); // evaluate fails while page is mid-reload - keep waiting
        if (allShown) break;
      }
      await page.waitForTimeout(2000);
    }
  }
  return total;
}

async function scrapeResultsList(page) {
  // retry: the page may still be navigating when we try to read it
  for (let attempt = 0; attempt < 6; attempt++) {
    const rows = await scrapeResultsListOnce(page).catch(() => null);
    if (rows && rows.length) return rows;
    await page.waitForTimeout(5000);
  }
  return (await scrapeResultsListOnce(page).catch(() => [])) || [];
}

async function scrapeResultsListOnce(page) {
  return page.evaluate(() => {
    const tables = Array.from(document.querySelectorAll('table')).filter((t) => {
      const firstRow = t.rows && t.rows[0];
      if (!firstRow || firstRow.cells.length < 6) return false;
      const h0 = (firstRow.cells[0].textContent || '').trim();
      const all = (firstRow.textContent || '');
      return /^Case No/i.test(h0) && /Claim\s*Status/i.test(all);
    });
    const resultTable = tables[tables.length - 1];
    if (!resultTable) return [];
    return Array.from(resultTable.rows).slice(1).map((tr) => {
      const cells = Array.from(tr.cells).map((td) => (td.textContent || '').trim().replace(/\s+/g, ' '));
      if (cells.length < 8 || !/^CASE\//i.test(cells[0])) return null;
      return {
        case_no: cells[0], claim_no: cells[1], patient_name: cells[2], card_no: cells[3],
        claim_status: cells[4], source_registration: cells[5], status_date: cells[6],
        ip_registration_dt: cells[7],
      };
    }).filter(Boolean);
  });
}

// true once the case DETAIL page is actually on screen (not the results list or a blank frame)
async function caseDetailLoaded(page) {
  return page.evaluate(() => {
    const t = document.body ? document.body.textContent || '' : '';
    return /Case Status\s*:/i.test(t) && /Case Sheet/i.test(t) && /Pre Auth Details/i.test(t);
  }).catch(() => false);
}

// click the case link and WAIT until the detail page loads; returns true/false
async function openCaseByText(page, caseNo) {
  const link = page.locator(`a:has-text("${caseNo}")`).first();
  if (await link.count() === 0) return false;
  await link.click().catch(() => {});
  const deadline = Date.now() + 30000; // portal detail pages can be slow
  while (Date.now() < deadline) {
    await page.waitForTimeout(2000);
    if (await caseDetailLoaded(page)) return true;
  }
  return false;
}

// search for a single case using the portal's CaseNo field (accepts the last "/"-segment, e.g. AP12287160)
async function searchCaseByNo(page, caseNo, log) {
  const seg = caseNo.split('/').pop();
  await gotoCasesSearch(page, log);
  await page.evaluate((v) => { const f = document.getElementById('CaseNo'); if (f) { f.value = v; } }, seg);
  await page.evaluate(() => { if (typeof fnSearch === 'function') fnSearch(); });
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    await page.waitForTimeout(3000);
    const state = await page.evaluate(() =>
      /Results\s+\d+\s*-\s*\d+\s+of\s+\d+|No\s+Records/i.test(document.body ? document.body.textContent : '')).catch(() => false);
    if (state) break;
  }
}

async function scrapeCaseDetails(page) {
  return page.evaluate(() => {
    const val = (labelRe) => {
      const els = Array.from(document.querySelectorAll('td, span, label, div'));
      const label = els.find((el) => labelRe.test((el.textContent || '').trim()) &&
                                     (el.textContent || '').trim().length < 40);
      if (!label) return '';
      const cell = label.closest('td') || label;
      let node = cell.nextElementSibling;
      while (node) {
        const input = node.querySelector && node.querySelector('input[type="text"], input:not([type])');
        if (input) return (input.value || '').trim();
        node = node.nextElementSibling;
      }
      return '';
    };
    const bodyText = document.body.textContent || '';
    const statusMatch = bodyText.match(/Case Status\s*:?\s*([^\n|]{5,120})/i);
    return {
      mandal: val(/^Mandal\s*:?$/i),
      village: val(/^Village\s*:?$/i),
      contact_no: val(/^Contact\s*No\s*:?$/i),
      district: val(/^District\s*:?$/i),
      card_no: val(/^Card No\s*:?$/i),
      claim_no: val(/^Claim No\s*:?$/i),
      nwh_name: val(/^NWH Name\s*:?$/i),
      ip_no: val(/^IP No\s*:?$/i),
      ip_registration_dt: val(/^IP\s*Registration/i),
      category: val(/^Category\s*:?$/i),
      procedure_name: val(/^Procedure\s*:?$/i),
      nwh_type: val(/^NWH Type\s*:?$/i),
      case_status: statusMatch ? statusMatch[1].trim() : '',
    };
  });
}

async function scrapeClaimWorkflow(page, log) {
  // wait for the Claim tab to appear, then click it (retry a few times - the tab strip loads late)
  let tabClicked = false;
  for (let attempt = 0; attempt < 8 && !tabClicked; attempt++) {
    tabClicked = await page.evaluate(() => {
      const isVisible = (el) => !!(el.offsetWidth || el.offsetHeight);
      const els = Array.from(document.querySelectorAll('a, td, li, span, div'))
        .filter((el) => (el.textContent || '').trim() === 'Claim' && isVisible(el));
      if (!els.length) return false;
      els[els.length - 1].click();
      return true;
    });
    if (!tabClicked) await page.waitForTimeout(3000);
  }
  if (!tabClicked) {
    // genuinely no Claim tab - confirm the detail page is loaded so we don't misreport a blank page
    const loaded = await caseDetailLoaded(page);
    return { rows: [], note: loaded
      ? 'No Claim tab (claim not started for this case yet)'
      : 'Case page did not load - claim tab not reached' };
  }
  await page.waitForTimeout(5000);

  const extract = () => {
    const tables = Array.from(document.querySelectorAll('table')).filter((t) => {
      const firstRow = t.rows && t.rows[0];
      return firstRow && /Date\s*&\s*Time/i.test(firstRow.textContent || '') &&
             /Role\s*&\s*Name/i.test(firstRow.textContent || '');
    });
    const wf = tables[tables.length - 1];
    if (!wf) return null;
    const cleanText = (td) => {
      const clone = td.cloneNode(true);
      clone.querySelectorAll('script, style').forEach((s) => s.remove());
      return (clone.textContent || '').trim().replace(/[ \t]+/g, ' ').replace(/\n{2,}/g, '\n');
    };
    const rows = Array.from(wf.rows).slice(1).map((tr) => {
      const cells = Array.from(tr.cells).map(cleanText);
      if (cells.length < 5) return null;
      return { date_time: cells[0], role_name: cells[1], remarks: cells[2], action: cells[3], amount: cells[4] };
    }).filter(Boolean);
    const note = /Processing of Claims not yet started/i.test(document.body.textContent || '')
      ? 'Processing of Claims not yet started for this case.' : '';
    return { rows, note };
  };

  for (let attempt = 0; attempt < 6; attempt++) {
    for (const frame of page.frames()) {
      const result = await frame.evaluate(extract).catch(() => null);
      if (result && result.rows.length) return result;
    }
    await page.waitForTimeout(3000);
  }
  return { rows: [], note: 'workflow table not found in any frame' };
}

/**
 * Run a full sync: search cases in the status-date window, save the list,
 * then deep-scrape each case (details + claim workflow).
 */
async function runSync(opts = {}) {
  const now = new Date();
  const defaultFrom = new Date(now.getTime() - (opts.hoursBack || 2) * 3600 * 1000);
  const fromStr = opts.from || fmt(defaultFrom);
  const toStr = opts.to || fmt(now);
  const limit = opts.limit === undefined ? Infinity : opts.limit;
  const headless = opts.headless !== undefined ? opts.headless : process.env.HEADLESS === 'true';
  const log = opts.log || console.log;

  log(`=== Sync | ${fromStr} -> ${toStr} | limit: ${limit === Infinity ? 'all' : limit} | headless: ${headless} ===`);
  const runId = startRun(fromStr, toStr);
  let totalFound = 0;
  let deepScraped = 0;

  const browser = await chromium.launch({ channel: 'chrome', headless });
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  context.on('page', (p) => attachDialogHandler(p, log));

  try {
    const page = await login(context, log);
    await gotoCasesSearch(page, log);
    await setStatusDateRange(page, fromStr, toStr, log);
    await runSearch(page, log);

    const list = await scrapeResultsList(page);
    totalFound = list.length;
    log(`Result list: ${list.length} cases.`);

    const syncTime = new Date().toISOString();
    for (const row of list) {
      upsertCase.run({
        case_no: row.case_no, claim_no: row.claim_no, patient_name: row.patient_name,
        card_no: row.card_no, district: '', mandal: '', village: '', contact_no: '',
        nwh_name: '', nwh_type: '', ip_no: '', ip_registration_dt: row.ip_registration_dt,
        category: '', procedure_name: '', case_status: '', claim_status: row.claim_status,
        source_registration: row.source_registration, status_date: row.status_date,
        workflow_note: '', deep_synced: null, last_synced: syncTime,
      });
    }

    const toVisit = list.slice(0, limit === Infinity ? list.length : limit);
    for (let i = 0; i < toVisit.length; i++) {
      const c = toVisit[i];
      log(`[${i + 1}/${toVisit.length}] Case ${c.case_no}...`);
      try {
        const opened = await openCaseByText(page, c.case_no);
        if (!opened) {
          // page never loaded - do NOT mark deep_synced, so the next run retries it
          log('  case page did not load - skipping (will retry next run)');
          await gotoCasesSearch(page, log);
          await setStatusDateRange(page, fromStr, toStr, log);
          await runSearch(page, log);
          continue;
        }
        const details = await scrapeCaseDetails(page);
        const wf = await scrapeClaimWorkflow(page, log);

        upsertCase.run({
          case_no: c.case_no, claim_no: details.claim_no || c.claim_no,
          patient_name: c.patient_name, card_no: details.card_no || c.card_no,
          district: details.district, mandal: details.mandal, village: details.village,
          contact_no: details.contact_no, nwh_name: details.nwh_name, nwh_type: details.nwh_type,
          ip_no: details.ip_no, ip_registration_dt: details.ip_registration_dt || c.ip_registration_dt,
          category: details.category, procedure_name: details.procedure_name,
          case_status: details.case_status, claim_status: c.claim_status,
          source_registration: c.source_registration, status_date: c.status_date,
          workflow_note: wf.note || '', deep_synced: new Date().toISOString(),
          last_synced: new Date().toISOString(),
        });
        if (wf.rows.length) replaceWorkflowForCase(c.case_no, wf.rows);
        deepScraped++;
        log(`  saved (${wf.rows.length} workflow rows)${wf.note ? ' - ' + wf.note : ''}`);
      } catch (caseErr) {
        log(`  ERROR on ${c.case_no}: ${caseErr.message} - re-opening search and continuing`);
        await gotoCasesSearch(page, log);
        await setStatusDateRange(page, fromStr, toStr, log);
        await runSearch(page, log);
        continue;
      }

      // back to the results list
      const backOk = await page.evaluate(() => {
        const isVisible = (el) => !!(el.offsetWidth || el.offsetHeight);
        const el = Array.from(document.querySelectorAll('input, button, a'))
          .find((e) => ((e.value || e.textContent || '').trim() === 'Back') && isVisible(e));
        if (el) { el.click(); return true; }
        return false;
      }).catch(() => false);
      if (backOk) {
        await page.waitForTimeout(3000);
        const hasList = await page.evaluate(() =>
          /Results\s+\d+\s*-\s*\d+\s+of\s+\d+/i.test(document.body ? document.body.textContent : '')).catch(() => false);
        if (hasList) continue;
      }
      await gotoCasesSearch(page, log);
      await setStatusDateRange(page, fromStr, toStr, log);
      await runSearch(page, log);
    }

    finishRun(runId, 'success', totalFound, deepScraped, '');
    log(`=== Sync done: ${totalFound} found, ${deepScraped} deep-scraped ===`);
    return { runId, totalFound, deepScraped };
  } catch (err) {
    finishRun(runId, 'failed', totalFound, deepScraped, err.message);
    throw err;
  } finally {
    await browser.close();
  }
}

/**
 * Re-scrape specific cases by Case No (targeted repair of gaps).
 * Logs in once, then searches each case individually and scrapes details + workflow.
 */
async function rescrapeCases(caseNos, opts = {}) {
  const headless = opts.headless !== undefined ? opts.headless : process.env.HEADLESS === 'true';
  const log = opts.log || console.log;
  log(`=== Re-scrape | ${caseNos.length} cases | headless: ${headless} ===`);
  const runId = startRun('rescrape', `${caseNos.length} cases`);
  let fixed = 0, stillMissing = 0;

  const browser = await chromium.launch({ channel: 'chrome', headless });
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  context.on('page', (p) => attachDialogHandler(p, log));

  try {
    // ONE login for the whole run - the portal rate-limits repeated logins ("Invalid User Id").
    // A short delay between cases keeps request-rate low enough to avoid session throttling.
    const page = await login(context, log);
    for (let i = 0; i < caseNos.length; i++) {
      const caseNo = caseNos[i];
      if (i > 0) await page.waitForTimeout(2500); // be gentle on the legacy portal
      log(`[${i + 1}/${caseNos.length}] ${caseNo}...`);
      try {
        await searchCaseByNo(page, caseNo, log);
        const opened = await openCaseByText(page, caseNo);
        if (!opened) { log('  page did not load'); stillMissing++; continue; }
        const details = await scrapeCaseDetails(page);
        const wf = await scrapeClaimWorkflow(page, log);
        upsertCase.run({
          case_no: caseNo, claim_no: details.claim_no || '', patient_name: '',
          card_no: details.card_no || '', district: details.district, mandal: details.mandal,
          village: details.village, contact_no: details.contact_no, nwh_name: details.nwh_name,
          nwh_type: details.nwh_type, ip_no: details.ip_no,
          ip_registration_dt: details.ip_registration_dt || '', category: details.category,
          procedure_name: details.procedure_name, case_status: details.case_status,
          claim_status: '', source_registration: '', status_date: '',
          workflow_note: wf.note || '', deep_synced: new Date().toISOString(),
          last_synced: new Date().toISOString(),
        });
        if (wf.rows.length) replaceWorkflowForCase(caseNo, wf.rows);
        if (wf.rows.length) fixed++; else stillMissing++;
        log(`  saved (${wf.rows.length} workflow rows)${wf.note ? ' - ' + wf.note : ''}`);
      } catch (e) {
        log(`  ERROR: ${e.message}`);
        stillMissing++;
      }
    }
    finishRun(runId, 'success', caseNos.length, fixed, `${fixed} fixed, ${stillMissing} still without workflow`);
    log(`=== Re-scrape done: ${fixed} now have workflow, ${stillMissing} without ===`);
    return { fixed, stillMissing };
  } catch (err) {
    finishRun(runId, 'failed', caseNos.length, fixed, err.message);
    throw err;
  } finally {
    await browser.close();
  }
}

/**
 * Count-only reconciliation helper: log in ONCE, then for each [from, to] window
 * read the portal's "Results N of N" total WITHOUT deep-scraping. Fast.
 * windows: array of [fromStr, toStr]. Returns [{ from, to, portal }].
 */
async function countRanges(windows, opts = {}) {
  const headless = opts.headless !== undefined ? opts.headless : process.env.HEADLESS === 'true';
  const log = opts.log || console.log;
  const reloginEvery = opts.reloginEvery || 40; // proactively re-login to beat session throttling
  const maxTries = opts.maxTries || 4;
  const onResult = opts.onResult; // optional callback(result, index) for live progress/persistence

  let browser = null;
  let page = null;
  async function fresh() {
    if (browser) await browser.close().catch(() => {});
    browser = await chromium.launch({ channel: 'chrome', headless });
    const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
    context.on('page', (p) => attachDialogHandler(p, log));
    page = await login(context, log);
  }
  await fresh();

  const out = [];
  try {
    for (let i = 0; i < windows.length; i++) {
      const [from, to] = windows[i];
      if (i > 0 && i % reloginEvery === 0) { log(`  [proactive re-login after ${reloginEvery} windows]`); await fresh(); }

      let portal = 0;
      let ok = false;
      for (let attempt = 1; attempt <= maxTries; attempt++) {
        try {
          await gotoCasesSearch(page, log);
          await setStatusDateRange(page, from, to, log);
          portal = await runSearch(page, log, { countOnly: true });
          ok = true;
          break;
        } catch (e) {
          log(`  [${from} -> ${to}] attempt ${attempt}/${maxTries} failed: ${String((e && e.message) || e).split('\n')[0]}`);
          if (attempt < maxTries) await fresh(); // session likely dead - re-login before retrying
        }
      }
      const result = { from, to, portal, ok };
      out.push(result);
      if (onResult) await onResult(result, i);
      await page.waitForTimeout(400); // stay gentle on the legacy portal
    }
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
  return out;
}

/**
 * List-only sweep: log in (with periodic re-login), and for each [from, to] window
 * return the FULL list of case numbers the portal shows (no deep-scrape). Retries on
 * failed/partial loads. Used to reconcile the SET of case numbers portal vs Supabase.
 * windows: array of [fromStr, toStr]. Returns [{ from, to, total, caseNos, ok }].
 */
async function listRanges(windows, opts = {}) {
  const headless = opts.headless !== undefined ? opts.headless : process.env.HEADLESS === 'true';
  const log = opts.log || console.log;
  const reloginEvery = opts.reloginEvery || 30; // list windows are heavier than count windows
  const maxTries = opts.maxTries || 4;
  const onResult = opts.onResult;

  let browser = null;
  let page = null;
  async function fresh() {
    if (browser) await Promise.race([browser.close().catch(() => {}), new Promise((r) => setTimeout(r, 15000))]);
    browser = await chromium.launch({ channel: 'chrome', headless });
    const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
    context.on('page', (p) => attachDialogHandler(p, log));
    page = await login(context, log);
  }
  await fresh();

  const out = [];
  try {
    for (let i = 0; i < windows.length; i++) {
      const [from, to] = windows[i];
      if (i > 0 && i % reloginEvery === 0) { log(`  [proactive re-login after ${reloginEvery} windows]`); await fresh(); }

      let caseNos = []; let records = []; let total = 0; let ok = false;
      for (let attempt = 1; attempt <= maxTries; attempt++) {
        try {
          await gotoCasesSearch(page, log);
          await setStatusDateRange(page, from, to, log);
          total = await runSearch(page, log); // full mode: switches to 1000/page so ALL rows load
          if (total === 0) {
            const genuineEmpty = await page.evaluate(
              () => /No\s+(records|results)\s+found/i.test(document.body ? document.body.textContent : ''),
            ).catch(() => false);
            if (!genuineEmpty) throw new Error('no results table (timeout/blocked) - needs retry');
            caseNos = []; records = []; ok = true; break;
          }
          const list = await scrapeResultsList(page);
          const nos = list.map((r) => r.case_no).filter(Boolean);
          if (nos.length < total) throw new Error(`partial list ${nos.length}/${total} - needs retry`);
          caseNos = nos; records = list; ok = true; break;
        } catch (e) {
          log(`  [${from} -> ${to}] attempt ${attempt}/${maxTries} failed: ${String((e && e.message) || e).split('\n')[0]}`);
          if (attempt < maxTries) await fresh();
        }
      }
      const result = { from, to, total, caseNos, records, ok };
      out.push(result);
      if (onResult) await onResult(result, i);
      await page.waitForTimeout(400);
    }
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
  return out;
}

/**
 * Workflow-only deep scrape: log in (with periodic re-login), and for each case number
 * search it, open it, and scrape ONLY its claim workflow (timeline). Returns
 * [{ case_no, rows, note, ok }]. Does not touch list fields. Retries + re-logins.
 */
async function scrapeCaseWorkflows(caseNos, opts = {}) {
  const headless = opts.headless !== undefined ? opts.headless : process.env.HEADLESS === 'true';
  const log = opts.log || console.log;
  const reloginEvery = opts.reloginEvery || 30;
  const maxTries = opts.maxTries || 3;
  const onResult = opts.onResult;

  const caseTimeoutMs = opts.caseTimeoutMs || 75000; // hard cap per case so a stuck op can't freeze the run
  let browser = null;
  let page = null;
  async function fresh() {
    if (browser) await Promise.race([browser.close().catch(() => {}), new Promise((r) => setTimeout(r, 15000))]);
    browser = await chromium.launch({ channel: 'chrome', headless });
    const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
    context.on('page', (p) => attachDialogHandler(p, log));
    page = await login(context, log);
  }
  // resilient (re)login: a single portal login hiccup must NOT crash the whole run
  async function freshResilient() {
    for (let a = 1; a <= 6; a++) {
      try { await fresh(); return; }
      catch (e) { log(`  [re-login attempt ${a}/6 failed: ${String((e && e.message) || e).split('\n')[0]}]`); await new Promise((r) => setTimeout(r, a * 5000)); }
    }
    throw new Error('re-login failed after 6 attempts (portal may be down)');
  }
  await freshResilient();

  const out = [];
  try {
    for (let i = 0; i < caseNos.length; i++) {
      const caseNo = caseNos[i];
      let rows = []; let note = ''; let ok = false;
      // per-iteration guard: NOTHING here may throw out and kill the whole run
      try {
        if (i > 0 && i % reloginEvery === 0) { log(`  [proactive re-login after ${reloginEvery} cases]`); await freshResilient(); }
        for (let attempt = 1; attempt <= maxTries; attempt++) {
          try {
            await Promise.race([
              (async () => {
                await searchCaseByNo(page, caseNo, log);
                const opened = await openCaseByText(page, caseNo);
                if (!opened) throw new Error('case page did not load');
                const wf = await scrapeClaimWorkflow(page, log);
                rows = wf.rows; note = wf.note || '';
              })(),
              new Promise((_, rej) => setTimeout(() => rej(new Error('case timed out after ' + caseTimeoutMs + 'ms')), caseTimeoutMs)),
            ]);
            ok = true;
            break;
          } catch (e) {
            log(`  [${caseNo}] attempt ${attempt}/${maxTries}: ${String((e && e.message) || e).split('\n')[0]}`);
            if (attempt < maxTries) await freshResilient();
          }
        }
      } catch (loopErr) {
        // re-login gave up / unexpected error: recover the browser and keep going (never crash the run)
        log(`  [${caseNo}] recovering: ${String((loopErr && loopErr.message) || loopErr).split('\n')[0]}`);
        try { await freshResilient(); } catch (e2) { log(`  [re-login still failing, pausing 30s: ${String((e2 && e2.message) || e2).split('\n')[0]}]`); await new Promise((r) => setTimeout(r, 30000)); }
      }
      const result = { case_no: caseNo, rows, note, ok };
      out.push(result);
      try { if (onResult) await onResult(result, i); } catch (e) { log(`  [onResult error ${caseNo}: ${String((e && e.message) || e).split('\n')[0]}]`); }
      await new Promise((r) => setTimeout(r, 2000)); // gentle; page-independent so a dead page can't throw here
    }
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
  return out;
}

module.exports = { runSync, rescrapeCases, fmt, countRanges, listRanges, scrapeCaseWorkflows };

if (require.main === module) {
  const limitArg = arg('limit', '');
  runSync({
    from: arg('from', undefined),
    to: arg('to', undefined),
    hoursBack: parseFloat(arg('hours', '2')),
    limit: limitArg === '' || limitArg === 'all' ? undefined : parseInt(limitArg, 10),
    headless: process.argv.includes('--headless') || undefined,
  }).catch((err) => {
    console.error('\nSync failed:', err.message);
    process.exit(1);
  });
}
