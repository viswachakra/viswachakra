-- Preauth-stage workflow and daily clinical notes, scraped from the case page's
-- "Pre Auth Details" and "Clinical Notes" tabs. Run once in the SQL Editor.
--
-- Tables created after 2026-10-30 get NO Data API grants automatically, so the
-- grants below are mandatory (apps read with anon/authenticated; the scraper
-- writes with service_role).

create table if not exists public.preauth_workflow (
  case_no    text not null,
  row_index  integer not null,
  date_time  text,
  role_name  text,
  remarks    text,
  action     text,
  amount     text,
  primary key (case_no, row_index)
);
create index if not exists idx_preauth_workflow_case on public.preauth_workflow (case_no);

create table if not exists public.clinical_notes (
  case_no        text not null,
  clinical_id    text not null,
  note_date      text,          -- dd/mm/yyyy as the portal shows it
  ward_type      text,
  progress_notes text,
  primary key (case_no, clinical_id)
);
create index if not exists idx_clinical_notes_case on public.clinical_notes (case_no);

-- Per-case summary columns derived from the two tables at push time.
alter table public.cases add column if not exists preauth_amount     integer;  -- PPD-approved amount
alter table public.cases add column if not exists preauth_status     text;     -- last preauth action
alter table public.cases add column if not exists preauth_query_open boolean;  -- Trust is waiting on the hospital at preauth stage
alter table public.cases add column if not exists notes_last_date    text;     -- newest clinical note, dd/mm/yyyy
alter table public.cases add column if not exists notes_count        integer;

-- Same read model as claim_workflow: signed-in app users read, the scraper writes.
alter table public.preauth_workflow enable row level security;
alter table public.clinical_notes   enable row level security;
drop policy if exists "read preauth_workflow" on public.preauth_workflow;
create policy "read preauth_workflow" on public.preauth_workflow for select to authenticated using (true);
drop policy if exists "read clinical_notes" on public.clinical_notes;
create policy "read clinical_notes" on public.clinical_notes for select to authenticated using (true);

grant select on public.preauth_workflow to anon, authenticated;
grant select, insert, update, delete on public.preauth_workflow to service_role;
grant select on public.clinical_notes to anon, authenticated;
grant select, insert, update, delete on public.clinical_notes to service_role;

notify pgrst, 'reload schema';
