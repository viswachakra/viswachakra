// SQLite database for the case repository
const Database = require('better-sqlite3');
const path = require('path');

const db = new Database(path.join(__dirname, 'cases.db'));
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS cases (
  case_no             TEXT PRIMARY KEY,
  claim_no            TEXT,
  patient_name        TEXT,
  card_no             TEXT,
  district            TEXT,
  mandal              TEXT,
  village             TEXT,
  contact_no          TEXT,
  nwh_name            TEXT,
  nwh_type            TEXT,
  ip_no               TEXT,
  ip_registration_dt  TEXT,
  category            TEXT,
  procedure_name      TEXT,
  case_status         TEXT,
  claim_status        TEXT,
  source_registration TEXT,
  status_date         TEXT,
  workflow_note       TEXT,
  deep_synced         TEXT,
  last_synced         TEXT
);

CREATE TABLE IF NOT EXISTS claim_workflow (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  case_no   TEXT NOT NULL,
  row_index INTEGER NOT NULL,
  date_time TEXT,
  role_name TEXT,
  remarks   TEXT,
  action    TEXT,
  amount    TEXT,
  UNIQUE (case_no, row_index)
);

CREATE TABLE IF NOT EXISTS sync_runs (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at   TEXT,
  finished_at  TEXT,
  status       TEXT,
  from_dt      TEXT,
  to_dt        TEXT,
  total_found  INTEGER DEFAULT 0,
  deep_scraped INTEGER DEFAULT 0,
  message      TEXT
);

CREATE INDEX IF NOT EXISTS idx_workflow_case ON claim_workflow (case_no);
CREATE INDEX IF NOT EXISTS idx_cases_status ON cases (claim_status);
CREATE INDEX IF NOT EXISTS idx_cases_status_date ON cases (status_date);
`);

// migrations for databases created before these columns existed
for (const col of ['workflow_note TEXT', 'deep_synced TEXT']) {
  try { db.exec(`ALTER TABLE cases ADD COLUMN ${col}`); } catch (e) { /* already exists */ }
}

const upsertCase = db.prepare(`
INSERT INTO cases (case_no, claim_no, patient_name, card_no, district, mandal, village,
                   contact_no, nwh_name, nwh_type, ip_no, ip_registration_dt, category,
                   procedure_name, case_status, claim_status, source_registration,
                   status_date, workflow_note, deep_synced, last_synced)
VALUES (@case_no, @claim_no, @patient_name, @card_no, @district, @mandal, @village,
        @contact_no, @nwh_name, @nwh_type, @ip_no, @ip_registration_dt, @category,
        @procedure_name, @case_status, @claim_status, @source_registration,
        @status_date, @workflow_note, @deep_synced, @last_synced)
ON CONFLICT(case_no) DO UPDATE SET
  claim_no            = COALESCE(NULLIF(excluded.claim_no, ''), claim_no),
  patient_name        = COALESCE(NULLIF(excluded.patient_name, ''), patient_name),
  card_no             = COALESCE(NULLIF(excluded.card_no, ''), card_no),
  district            = COALESCE(NULLIF(excluded.district, ''), district),
  mandal              = COALESCE(NULLIF(excluded.mandal, ''), mandal),
  village             = COALESCE(NULLIF(excluded.village, ''), village),
  contact_no          = COALESCE(NULLIF(excluded.contact_no, ''), contact_no),
  nwh_name            = COALESCE(NULLIF(excluded.nwh_name, ''), nwh_name),
  nwh_type            = COALESCE(NULLIF(excluded.nwh_type, ''), nwh_type),
  ip_no               = COALESCE(NULLIF(excluded.ip_no, ''), ip_no),
  ip_registration_dt  = COALESCE(NULLIF(excluded.ip_registration_dt, ''), ip_registration_dt),
  category            = COALESCE(NULLIF(excluded.category, ''), category),
  procedure_name      = COALESCE(NULLIF(excluded.procedure_name, ''), procedure_name),
  case_status         = COALESCE(NULLIF(excluded.case_status, ''), case_status),
  claim_status        = COALESCE(NULLIF(excluded.claim_status, ''), claim_status),
  source_registration = COALESCE(NULLIF(excluded.source_registration, ''), source_registration),
  status_date         = COALESCE(NULLIF(excluded.status_date, ''), status_date),
  workflow_note       = COALESCE(NULLIF(excluded.workflow_note, ''), workflow_note),
  deep_synced         = COALESCE(excluded.deep_synced, deep_synced),
  last_synced         = excluded.last_synced
`);

const replaceWorkflowForCase = db.transaction((caseNo, rows) => {
  db.prepare('DELETE FROM claim_workflow WHERE case_no = ?').run(caseNo);
  const ins = db.prepare(`
    INSERT INTO claim_workflow (case_no, row_index, date_time, role_name, remarks, action, amount)
    VALUES (?, ?, ?, ?, ?, ?, ?)`);
  rows.forEach((r, i) => ins.run(caseNo, i, r.date_time, r.role_name, r.remarks, r.action, r.amount));
});

// Preauth-stage workflow (the case page's "Pre Auth Details" tab) and the daily
// clinical notes ("Clinical Notes" tab). Added 2026-11 for the doctor's alerts:
// preauth queries, preauth-vs-final amount, and patients missing today's notes.
db.exec(`
CREATE TABLE IF NOT EXISTS preauth_workflow (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  case_no   TEXT NOT NULL,
  row_index INTEGER NOT NULL,
  date_time TEXT,
  role_name TEXT,
  remarks   TEXT,
  action    TEXT,
  amount    TEXT,
  UNIQUE (case_no, row_index)
);
CREATE TABLE IF NOT EXISTS clinical_notes (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  case_no        TEXT NOT NULL,
  clinical_id    TEXT NOT NULL,
  note_date      TEXT,
  ward_type      TEXT,
  progress_notes TEXT,
  UNIQUE (case_no, clinical_id)
);
CREATE INDEX IF NOT EXISTS idx_preauth_case ON preauth_workflow (case_no);
CREATE INDEX IF NOT EXISTS idx_notes_case ON clinical_notes (case_no);
`);

const replacePreauthForCase = db.transaction((caseNo, rows) => {
  db.prepare('DELETE FROM preauth_workflow WHERE case_no = ?').run(caseNo);
  const ins = db.prepare(`
    INSERT INTO preauth_workflow (case_no, row_index, date_time, role_name, remarks, action, amount)
    VALUES (?, ?, ?, ?, ?, ?, ?)`);
  rows.forEach((r, i) => ins.run(caseNo, i, r.date_time, r.role_name, r.remarks, r.action, r.amount));
});

const replaceNotesForCase = db.transaction((caseNo, rows) => {
  db.prepare('DELETE FROM clinical_notes WHERE case_no = ?').run(caseNo);
  const ins = db.prepare(`
    INSERT OR REPLACE INTO clinical_notes (case_no, clinical_id, note_date, ward_type, progress_notes)
    VALUES (?, ?, ?, ?, ?)`);
  rows.forEach((r) => ins.run(caseNo, r.clinical_id, r.note_date, r.ward_type, r.progress_notes));
});

const startRun = (fromDt, toDt) =>
  db.prepare(`INSERT INTO sync_runs (started_at, status, from_dt, to_dt) VALUES (?, 'running', ?, ?)`)
    .run(new Date().toISOString(), fromDt, toDt).lastInsertRowid;

const finishRun = (id, status, totalFound, deepScraped, message) =>
  db.prepare(`UPDATE sync_runs SET finished_at = ?, status = ?, total_found = ?, deep_scraped = ?, message = ? WHERE id = ?`)
    .run(new Date().toISOString(), status, totalFound, deepScraped, message || '', id);

module.exports = { db, upsertCase, replaceWorkflowForCase, replacePreauthForCase, replaceNotesForCase, startRun, finishRun };
