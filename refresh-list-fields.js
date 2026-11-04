// List-only refresh for cases already swept before the sweep learned to read
// the search-results row: for each case, search by number, read its results
// row (claim status, status date, patient name, ...) and update the local row,
// then push to Supabase. Never opens the case page.
//   node refresh-list-fields.js --from-progress     # the sweep's done list
//   node refresh-list-fields.js CASE/5722/AP... ...
require('dotenv').config({ path: require('path').join(__dirname, '.env'), quiet: true });
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { chromium } = require('playwright');
const scraper = require('./scraper');
const { db, upsertCase } = require('./db');

const log = (m) => { const line = new Date().toTimeString().slice(0, 8) + ' ' + m; console.log(line); fs.appendFileSync(path.join(__dirname, 'logs', 'sweep.log'), line + '\n'); };

async function main() {
  let caseNos = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  if (process.argv.includes('--from-progress')) {
    caseNos = JSON.parse(fs.readFileSync(path.join(__dirname, 'sweep-progress.json'), 'utf8')).done;
  }
  caseNos = caseNos.map(scraper.canonicalCaseKey);
  log(`list-refresh: ${caseNos.length} cases`);
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  let page;
  try {
    page = await scraper.login(context, log);
  } catch (e) { log('login failed: ' + e.message); await browser.close(); process.exit(2); }
  let n = 0, miss = 0;
  const upd = db.prepare(`UPDATE cases SET claim_status = COALESCE(NULLIF(@claim_status,''), claim_status),
    status_date = COALESCE(NULLIF(@status_date,''), status_date),
    patient_name = COALESCE(NULLIF(@patient_name,''), patient_name),
    claim_no = COALESCE(NULLIF(@claim_no,''), claim_no),
    card_no = COALESCE(NULLIF(@card_no,''), card_no),
    last_synced = @now WHERE case_no = @case_no`);
  for (const key of caseNos) {
    const bare = key.replace(/^CASE\/\d+\//, '');
    try {
      await scraper.searchCaseByNo(page, bare, log);
      const row = (await scraper.scrapeResultsListOnce(page)).find((r) => scraper.canonicalCaseKey(r.case_no) === key);
      if (!row) { miss++; log(`  ${key}: no results row`); continue; }
      upd.run({ ...row, case_no: key, now: new Date().toISOString() });
      n++;
      if (n % 25 === 0) log(`  ${n}/${caseNos.length} refreshed`);
    } catch (e) { miss++; log(`  ${key}: ERROR ${e.message.slice(0, 120)}`); }
    await page.waitForTimeout(800);
  }
  await browser.close();
  log(`list-refresh done: ${n} refreshed, ${miss} missed`);
  try { execSync('node push-to-supabase.js --since-minutes 120', { cwd: __dirname, stdio: 'pipe' }); log('pushed'); }
  catch (e) { log('push failed: ' + (e.stderr || e.message).toString().slice(0, 200)); }
}
main();
