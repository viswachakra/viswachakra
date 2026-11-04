// One-time full re-read of EVERY case, newest status date first.
//
// Why: the Pre Auth Details and Clinical Notes tabs were never scraped, and the
// doctor wants preauth-vs-final history across all claims, so each case is
// opened once with --force (the paid-in-full skip is deliberately bypassed).
//
// Runs in batches: one portal login per batch, a push to Supabase after each,
// and a checkpoint file so a killed run resumes where it stopped. If the login
// fails (someone else is using the account - one session per account) it
// stands aside for 10 minutes and tries again rather than fighting for it.
//
//   node sweep-all.js                 # resume / start
//   node sweep-all.js --batch 40      # cases per login (default 50)
//   node sweep-all.js --reset         # forget progress and start over
//
// Disable ViswachakraHourlySync before starting; re-enable when it finishes.
require('dotenv').config({ path: require('path').join(__dirname, '.env'), quiet: true });
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { createClient } = require('@supabase/supabase-js');
const { pageAllChecked } = require('./supabase-page');
const scraper = require('./scraper');

const STATE = path.join(__dirname, 'sweep-progress.json');
const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i > -1 ? process.argv[i + 1] : d; };
const BATCH = parseInt(arg('batch', '50'), 10);
const log = (m) => console.log(`${new Date().toISOString().slice(11, 19)} ${m}`);

const keyOf = (d) => { const m = String(d || '').match(/(\d{2})\/(\d{2})\/(\d{4})(?:\s+(\d{2}):(\d{2}))?/); return m ? `${m[3]}${m[2]}${m[1]}${m[4] || '00'}${m[5] || '00'}` : ''; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  if (process.argv.includes('--reset') && fs.existsSync(STATE)) fs.unlinkSync(STATE);
  const state = fs.existsSync(STATE) ? JSON.parse(fs.readFileSync(STATE, 'utf8')) : { done: [], failed: [] };
  const done = new Set(state.done);

  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });
  const all = await pageAllChecked(sb, 'cases', 'case_no,status_date');
  all.sort((a, b) => keyOf(b.status_date).localeCompare(keyOf(a.status_date)));
  const todo = all.map((c) => c.case_no.replace(/^CASE\/\d+\//, '')).filter((c) => !done.has(c));
  log(`cases in Supabase: ${all.length} | already done: ${done.size} | to do: ${todo.length} | batch ${BATCH}`);

  const t0 = Date.now();
  let processed = 0;
  for (let i = 0; i < todo.length; i += BATCH) {
    const batch = todo.slice(i, i + BATCH);
    let ok = false;
    for (let attempt = 1; attempt <= 3 && !ok; attempt++) {
      try {
        await scraper.rescrapeCases(batch, { force: true, headless: true, log: (m) => { if (/saved|ERROR|did not load|Logged in|failed/i.test(m)) log('  ' + m); } });
        ok = true;
      } catch (e) {
        log(`batch failed (attempt ${attempt}/3): ${e.message}`);
        if (/login|Welcome|Invalid User/i.test(e.message)) { log('  portal busy or password rejected - standing aside 10 min'); await sleep(10 * 60 * 1000); }
        else await sleep(60 * 1000);
      }
    }
    if (!ok) { state.failed.push(...batch); fs.writeFileSync(STATE, JSON.stringify(state)); continue; }

    try { execSync('node push-to-supabase.js --since-minutes 90', { cwd: __dirname, stdio: 'pipe' }); }
    catch (e) { log('  push failed: ' + (e.stderr || e.message).toString().slice(0, 200)); }

    batch.forEach((c) => done.add(c));
    state.done = [...done];
    fs.writeFileSync(STATE, JSON.stringify(state));
    processed += batch.length;
    const rate = processed / ((Date.now() - t0) / 60000);
    const left = todo.length - processed;
    log(`progress ${done.size}/${all.length} | ${rate.toFixed(1)} cases/min | ~${Math.round(left / Math.max(rate, 0.1))} min left`);
  }
  log(`=== sweep finished: ${done.size} done, ${state.failed.length} failed ===`);
  if (state.failed.length) log('failed cases: ' + state.failed.join(' '));
}

main().catch((e) => { console.error('sweep failed:', e.message); process.exit(1); });
