-- Viswachakra claims repository - Supabase (Postgres) schema
-- Run this once in the Supabase SQL editor to create the tables the mobile app + scraper use.

create table if not exists cases (
  case_no             text primary key,
  claim_no            text,
  patient_name        text,
  card_no             text,
  district            text,
  mandal              text,
  village             text,
  contact_no          text,
  nwh_name            text,
  nwh_type            text,
  ip_no               text,
  ip_registration_dt  text,
  category            text,
  procedure_name      text,
  case_status         text,
  claim_status        text,
  source_registration text,
  status_date         text,
  workflow_note       text,
  deep_synced         timestamptz,
  last_synced         timestamptz,
  -- precomputed settlement summary (filled by the scraper / refresh scripts)
  claimed_amount      integer,
  paid_amount         integer,
  paid_date           text,
  settlement_days     integer,
  deduction           integer,
  is_paid             boolean default false,
  -- amount on the LAST "Recommended for Approval" row. Lets the app flag a claim
  -- approved below the amount raised months before the money actually lands.
  approved_amount     integer,
  latest_comment      text,
  latest_comment_by   text,
  latest_comment_date text
);

-- Migration for databases created before approved_amount existed.
alter table cases add column if not exists approved_amount integer;

create table if not exists claim_workflow (
  id        bigint generated always as identity primary key,
  case_no   text not null references cases(case_no) on delete cascade,
  row_index int  not null,
  date_time text,
  role_name text,
  remarks   text,
  action    text,
  amount    text,
  unique (case_no, row_index)
);

create table if not exists sync_runs (
  id           bigint generated always as identity primary key,
  started_at   timestamptz,
  finished_at  timestamptz,
  status       text,
  from_dt      text,
  to_dt        text,
  total_found  int default 0,
  deep_scraped int default 0,
  message      text
);

create index if not exists idx_workflow_case      on claim_workflow (case_no);
create index if not exists idx_cases_claim_status on cases (claim_status);
create index if not exists idx_cases_status_date  on cases (status_date);
create index if not exists idx_cases_is_paid       on cases (is_paid);

-- Row Level Security: lock the tables so only authenticated app users can read.
-- The scraper writes using the service_role key, which bypasses RLS.
alter table cases          enable row level security;
alter table claim_workflow enable row level security;
alter table sync_runs      enable row level security;

drop policy if exists "authenticated read cases"    on cases;
drop policy if exists "authenticated read workflow" on claim_workflow;
drop policy if exists "authenticated read runs"     on sync_runs;

create policy "authenticated read cases"    on cases          for select to authenticated using (true);
create policy "authenticated read workflow" on claim_workflow for select to authenticated using (true);
create policy "authenticated read runs"     on sync_runs      for select to authenticated using (true);
