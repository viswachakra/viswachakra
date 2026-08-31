// Re-scrape the cases whose amounts cannot be repaired from local data.
//
// fix-claimed-amount.js repairs claimed_amount by reading the "Initiated" row
// from the local SQLite workflow. 231 cases have no local workflow at all, so
// their true raised amount is unknown here and their stored figures stay
// inconsistent (deduction > claimed, or claimed - paid != deduction). The only
// way to recover them is to pull their workflow from the portal again.
//
// Works out the affected cases itself: any case in Supabase with no local
// workflow whose stored amounts are self-contradictory (deduction > claimed, or
// claimed - paid != deduction). Pass --file to use a hand-built list instead.
// Scrapes in batches so a single failure does not lose the whole run, and
// pushes each batch as it completes.
//
// IMPORTANT: the portal allows ONE session per account. Disable the
// ViswachakraHourlySync task before running this, or the two will collide:
//   schtasks /change /tn "ViswachakraHourlySync" /disable
//   ...run this...
//   schtasks /change /tn "ViswachakraHourlySync" /enable
//
// Usage:
//   node rescrape-broken-amounts.js --dry-run        # show what would be done
//   node rescrape-broken-amounts.js                  # scrape all, batches of 25
//   node rescrape-broken-amounts.js --batch 25 --limit 50
require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { createClient } = require('@supabase/supabase-js');
const { rescrapeCases } = require('./scraper');
const { db } = require('./db');

// Cases that cannot be repaired locally: no workflow rows here, and the stored
// amounts disagree with themselves. Their true raised amount only exists on the
// portal, so the workflow has to be pulled again.
async function findBrokenCases() {
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
    auth: { persistSession: false },
  });
  const local = new Set(
    db.prepare('SELECT DISTINCT case_no FROM claim_workflow').all().map((r) => r.case_no)
  );
  let from = 0;
  let all = [];
  for (;;) {
    const { data, error } = await supabase
      .from('cases')
      .select('case_no,claimed_amount,paid_amount,deduction,is_paid')
      .range(from, from + 999);
    if (error) throw new Error(`read failed: ${error.message}`);
    all = all.concat(data);
    if (data.length < 1000) break;
    from += 1000;
  }
  return all
    .filter((c) => {
      if (local.has(c.case_no)) return false;
      const absurd = c.claimed_amount != null && (c.deduction || 0) > c.claimed_amount;
      const mismatch =
        c.is_paid && c.claimed_amount != null && c.paid_amount != null &&
        (c.deduction || 0) > 0 && c.claimed_amount - c.paid_amount !== c.deduction;
      return absurd || mismatch;
    })
    .map((c) => c.case_no);
}

function arg(name, fallback = null) {
  const i = process.argv.indexOf('--' + name);
  return i > -1 ? process.argv[i + 1] : fallback;
}

async function main() {
  const file = arg('file');
  let cases;
  if (file) {
    if (!fs.existsSync(file)) {
      console.error(`Case list not found: ${file}`);
      process.exit(1);
    }
    cases = JSON.parse(fs.readFileSync(file, 'utf8'));
  } else {
    console.log('Finding cases with unrepairable amounts...');
    cases = await findBrokenCases();
  }
  const limit = arg('limit') ? parseInt(arg('limit'), 10) : null;
  if (limit) cases = cases.slice(0, limit);
  const batchSize = parseInt(arg('batch', '25'), 10);

  console.log(`${cases.length} cases to re-scrape, in batches of ${batchSize}`);
  if (process.argv.includes('--dry-run')) {
    console.log('DRY RUN - nothing scraped. First few:', cases.slice(0, 5).join(', '));
    return;
  }

  let done = 0;
  for (let i = 0; i < cases.length; i += batchSize) {
    const batch = cases.slice(i, i + batchSize);
    console.log(`\n--- batch ${Math.floor(i / batchSize) + 1}: ${batch.length} cases (${done}/${cases.length} done) ---`);
    try {
      await rescrapeCases(batch, { headless: true });
    } catch (e) {
      // One bad batch must not abandon the rest - the portal drops sessions.
      console.error(`  batch failed: ${e.message} - continuing with the next batch`);
      continue;
    }
    done += batch.length;
    // Push this batch's freshly-scraped cases straight away, so progress
    // survives a later crash. --since-minutes keeps it to what we just wrote.
    try {
      execFileSync('node', ['push-to-supabase.js', '--since-minutes', '15'], {
        cwd: __dirname, stdio: 'inherit',
      });
    } catch (e) {
      console.error(`  push failed for this batch: ${e.message}`);
    }
  }
  console.log(`\nRe-scraped ${done}/${cases.length} cases.`);
  console.log('Now re-run:  node fix-claimed-amount.js --apply');
}

main().catch((e) => { console.error('Re-scrape failed:', e.message); process.exit(1); });
