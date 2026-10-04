// PASS A - completeness. Does the portal hold cases that Supabase does not?
//
// verify-against-portal.js (pass B) checks that the cases we HAVE are correct.
// It cannot find a case that was never scraped, because it only ever looks at
// case numbers Supabase already knows. That is the more dangerous gap: a claim
// the doctor cannot see at all.
//
// This walks the portal month by month over the whole history, lists every case
// number the Cases Search returns, and diffs that against Supabase.
//
// A note on Status Date: it is the date a case's status LAST changed, not a
// fixed event date. A case that changed in May and again in September only
// appears in the September window. So a month returning 0 is normal and does
// not mean that month had no activity - it means nothing is currently sitting
// with that status date. The union across all months is what matters.
//
// Read-only. Writes a report, nothing else.
//
// IMPORTANT: one session per account - disable ViswachakraHourlySync first.
//
// Usage:
//   node verify-completeness.js --from 2023-01 --to 2026-10
//   node verify-completeness.js                      # defaults to 2023-01..today
require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
const scraper = require('./scraper');

const arg = (n, d = null) => {
  const i = process.argv.indexOf('--' + n);
  return i > -1 ? process.argv[i + 1] : d;
};
const REPORT = arg('report', path.join(__dirname, 'portal-completeness.json'));
const pad = (n) => String(n).padStart(2, '0');

// month windows, inclusive
function monthWindows(fromYM, toYM) {
  const [fy, fm] = fromYM.split('-').map(Number);
  const [ty, tm] = toYM.split('-').map(Number);
  const out = [];
  let y = fy, m = fm;
  while (y < ty || (y === ty && m <= tm)) {
    const last = new Date(y, m, 0).getDate();
    out.push([`${pad(1)}/${pad(m)}/${y} 00:00`, `${pad(last)}/${pad(m)}/${y} 23:59`, `${y}-${pad(m)}`]);
    m++; if (m > 12) { m = 1; y++; }
  }
  return out;
}

function load() {
  if (!fs.existsSync(REPORT)) return { months: {}, started: new Date().toISOString() };
  try { return JSON.parse(fs.readFileSync(REPORT, 'utf8')); } catch { return { months: {}, started: new Date().toISOString() }; }
}
const save = (r) => fs.writeFileSync(REPORT, JSON.stringify(r, null, 1));

async function main() {
  const now = new Date();
  const FROM = arg('from', '2023-01');
  const TO = arg('to', `${now.getFullYear()}-${pad(now.getMonth() + 1)}`);

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
    auth: { persistSession: false },
  });
  console.log('Reading Supabase case list...');
  let from = 0; const known = new Set();
  for (;;) {
    const { data, error } = await supabase.from('cases').select('case_no').range(from, from + 999);
    if (error) throw new Error(error.message);
    data.forEach((c) => known.add(c.case_no));
    if (data.length < 1000) break;
    from += 1000;
  }
  console.log(`  Supabase knows ${known.size} cases\n`);

  const report = load();
  const windows = monthWindows(FROM, TO).filter((w) => !report.months[w[2]]);
  console.log(`months already done : ${Object.keys(report.months).length}`);
  console.log(`months to walk now  : ${windows.length}\n`);

  if (windows.length) {
    await scraper.listRanges(windows.map((w) => [w[0], w[1]]), {
      headless: true,
      log: (m) => process.stdout.write(`  ${m}\n`),
      onResult: (r) => {
        // r: { from, to, total, caseNos } (shape per scraper.listRanges)
        const label = windows.find((w) => w[0] === r.from)?.[2] || r.from;
        if (!r.ok) {
          // Do NOT record it: an unrecorded month is retried on the next run,
          // whereas recording a failed window would silently skip it forever
          // and the completeness claim would be false.
          console.log(`  ${label}: FAILED after retries - will be retried on the next run`);
          return;
        }
        const nos = r.caseNos || [];
        const unseen = nos.filter((n) => !known.has(n));
        report.months[label] = { total: r.total ?? nos.length, listed: nos.length, unseen };
        save(report);
        console.log(`  ${label}: portal ${nos.length} case(s)` + (unseen.length ? `  ** ${unseen.length} NOT IN SUPABASE **` : ''));
      },
    });
  }

  // ---- summary ----
  const months = Object.entries(report.months);
  let portalTotal = 0; const allUnseen = [];
  months.forEach(([, v]) => { portalTotal += v.listed; (v.unseen || []).forEach((n) => allUnseen.push(n)); });
  const uniqueUnseen = [...new Set(allUnseen)];

  console.log('\n=== COMPLETENESS: PORTAL vs SUPABASE ===');
  console.log('months walked          :', months.length);
  console.log('case rows seen on portal:', portalTotal, '(a case appears once, under its current status month)');
  console.log('Supabase knows         :', known.size);
  console.log('');
  if (uniqueUnseen.length === 0) {
    console.log('NO CASES MISSING — every case the portal listed is in Supabase.');
  } else {
    console.log(`** ${uniqueUnseen.length} CASES ON THE PORTAL ARE NOT IN SUPABASE **`);
    uniqueUnseen.slice(0, 40).forEach((n) => console.log('   ', n));
    if (uniqueUnseen.length > 40) console.log(`   ...and ${uniqueUnseen.length - 40} more`);
    console.log('\nThese are claims the doctor cannot see in the app.');
  }
  console.log(`\nfull report: ${REPORT}`);
}

main().catch((e) => { console.error('Completeness check failed:', e.message); process.exit(1); });
