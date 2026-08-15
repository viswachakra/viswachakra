// Run supabase-schema.sql against the DB pointed to by DATABASE_URL in .env.
// One-off helper for standing up a fresh Supabase project.
require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

(async () => {
  const url = process.env.DATABASE_URL;
  if (!url) { console.error('No DATABASE_URL in .env'); process.exit(2); }
  const sql = fs.readFileSync(path.join(__dirname, 'supabase-schema.sql'), 'utf8');
  const client = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  try {
    await client.connect();
    await client.query(sql);
    // verify
    const r = await client.query("select table_name from information_schema.tables where table_schema='public' order by table_name");
    console.log('OK — schema applied. Tables now present:', r.rows.map(x => x.table_name).join(', '));
    const cols = await client.query("select count(*) n from information_schema.columns where table_schema='public' and table_name='cases'");
    console.log('cases table column count:', cols.rows[0].n);
  } catch (e) {
    console.error('SCHEMA RUN FAILED:', e.message);
    process.exit(1);
  } finally {
    await client.end().catch(() => {});
  }
})();
