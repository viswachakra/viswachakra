// Safe pagination for Supabase reads.
//
// WHY THIS EXISTS: `.range(from, from+999)` with no ORDER BY has no stable row
// order in Postgres. Pages then overlap and skip, and the scan silently returns
// fewer rows than the table holds - with no error.
//
// This bit us on 2026-10-04: an audit read 4,160 of 4,831 cases and reported
// 671 as absent. The table was fine; the reader was wrong. It had worked at
// 3,521 rows (4 pages) and only started dropping rows at 5 pages, which is
// exactly how this kind of bug hides.
//
// Always order by something unique. For `cases` that is case_no; for
// claim_workflow it takes case_no + row_index together.
//
// Every paginated read in this repo should go through here.

const ORDER_BY = {
  cases: ['case_no'],
  claim_workflow: ['case_no', 'row_index'],
  sync_runs: ['id'],
  app_settings: ['key'],
  user_roles: ['user_id'],
};

/**
 * Read an entire table, ordered so pagination is stable.
 * @param {object} supabase  client
 * @param {string} table
 * @param {string} cols      comma-separated column list
 * @param {object} [opts]    { order: ['col', ...], pageSize, filter: q => q }
 * @returns {Promise<object[]>}
 */
async function pageAll(supabase, table, cols, opts = {}) {
  const order = opts.order || ORDER_BY[table] || ['id'];
  const size = opts.pageSize || 1000;
  const out = [];
  for (let from = 0; ; from += size) {
    let q = supabase.from(table).select(cols);
    if (opts.filter) q = opts.filter(q);
    for (const col of order) q = q.order(col, { ascending: true });
    const { data, error } = await q.range(from, from + size - 1);
    if (error) throw new Error(`${table}: ${error.message}`);
    out.push(...data);
    if (data.length < size) break;
  }
  return out;
}

/**
 * Exact row count straight from Postgres - cheap, and the thing to trust when a
 * paginated read looks surprising.
 */
async function countRows(supabase, table) {
  const { count, error } = await supabase.from(table).select('*', { count: 'exact', head: true });
  if (error) throw new Error(`${table} count: ${error.message}`);
  return count;
}

/**
 * Read a table and assert the result matches the server's own count. Use this
 * anywhere a wrong total would produce a wrong conclusion - an audit saying
 * "these records are missing" when they were merely not read.
 */
async function pageAllChecked(supabase, table, cols, opts = {}) {
  const rows = await pageAll(supabase, table, cols, opts);
  if (!opts.filter) {
    const expected = await countRows(supabase, table);
    if (rows.length !== expected) {
      throw new Error(
        `${table}: read ${rows.length} rows but the table holds ${expected}. ` +
        'Pagination is dropping rows - do not trust any result derived from this.',
      );
    }
  }
  return rows;
}

module.exports = { pageAll, pageAllChecked, countRows };
