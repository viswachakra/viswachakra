// Upsert the master case list (logs/parsed-cases.json) into Supabase `cases`.
// Partial upsert: only the list-level columns present in the JSON, so it fills missing
// cases and refreshes list fields without clobbering workflow-derived summary columns.
require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const { createClient } = require('@supabase/supabase-js');
const s = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });

(async () => {
  const all = require('./logs/parsed-cases.json');
  const rows = all.map(c => ({
    case_no: c.case_no, claim_no: c.claim_no, patient_name: c.patient_name, card_no: c.card_no,
    claim_status: c.claim_status, source_registration: c.source_registration,
    status_date: c.status_date, ip_registration_dt: c.ip_registration_dt,
    claimed_amount: c.claimed_amount != null ? c.claimed_amount : null,
    is_paid: !!c.is_paid,
  })).filter(r => r.case_no);
  console.log('upserting', rows.length, 'master-list cases...');
  const chunk = 500;
  for (let i = 0; i < rows.length; i += chunk) {
    const { error } = await s.from('cases').upsert(rows.slice(i, i + chunk), { onConflict: 'case_no' });
    if (error) throw new Error('upsert at ' + i + ': ' + error.message);
    process.stdout.write('  ' + Math.min(i + chunk, rows.length) + '/' + rows.length + '\r');
  }
  const { count } = await s.from('cases').select('*', { count: 'exact', head: true });
  console.log('\nDone. cases table now has', count, 'rows.');
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
