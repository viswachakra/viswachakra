// Assign roles to the existing Supabase auth users.
//
// Run supabase-roles.sql in the Supabase SQL editor first (this script cannot
// create the table - the REST API does not do DDL).
//
// Mapping is by email so it is readable and auditable; the table itself keys on
// user_id, so changing an email later does not orphan the role.
//
// Usage:
//   node seed-roles.js            # dry run, shows what it would assign
//   node seed-roles.js --apply
require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const { createClient } = require('@supabase/supabase-js');

const APPLY = process.argv.includes('--apply');

// email -> role. Add a new scribe here, or set their role in the dashboard.
const ROLES = {
  'admin@vvistech.com': 'doctor',                     // Dr Saiprasad
  'viswachakramachilipatnam@gmail.com': 'scribe',
};

async function main() {
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
    auth: { persistSession: false },
  });

  const { data, error } = await supabase.auth.admin.listUsers();
  if (error) throw new Error(`listUsers failed: ${error.message}`);

  const rows = [];
  for (const u of data.users) {
    const email = (u.email || '').trim().toLowerCase();
    const role = ROLES[email];
    if (!role) {
      console.log(`  ${email.padEnd(36)} -> no mapping, SKIPPED`);
      continue;
    }
    console.log(`  ${email.padEnd(36)} -> ${role}`);
    rows.push({ user_id: u.id, role, updated_at: new Date().toISOString() });
  }

  if (!rows.length) { console.log('\nNothing to assign.'); return; }

  if (!APPLY) {
    console.log('\nDRY RUN - nothing written. Re-run with --apply.');
    return;
  }

  const { error: upErr } = await supabase.from('user_roles').upsert(rows, { onConflict: 'user_id' });
  if (upErr) {
    if (/relation .*user_roles.* does not exist/i.test(upErr.message)) {
      throw new Error('user_roles table not found - run supabase-roles.sql in the SQL editor first.');
    }
    throw new Error(`upsert failed: ${upErr.message}`);
  }
  console.log(`\nAssigned ${rows.length} role(s).`);
}

main().catch((e) => { console.error('Seed failed:', e.message); process.exit(1); });
