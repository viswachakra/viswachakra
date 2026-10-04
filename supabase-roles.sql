-- Roles for the Viswachakra apps.
--
-- Until now the role was inferred by string-matching 'admin@vvistech.com' in
-- three separate places (webapp/index.html, mobile lib/data.dart and
-- lib/notifications.dart). That meant adding a user needed a code change and an
-- app release, and changing the doctor's email would silently break two apps.
--
-- Two roles:
--   doctor - Dr Saiprasad. Sees everything, including rupee figures. Decides
--            what a claim reply should say.
--   scribe - Enters the doctor's reply into the Aarogyasri portal. Sees the
--            work queue and case details, but NOT the money.
--
-- Run this in the Supabase SQL editor.

create table if not exists public.user_roles (
  user_id    uuid primary key references auth.users (id) on delete cascade,
  role       text not null check (role in ('doctor', 'scribe')),
  updated_at timestamptz not null default now()
);

alter table public.user_roles enable row level security;

-- A signed-in user may read their OWN role and nobody else's. The apps only
-- ever need "what am I?", so this is deliberately narrow.
drop policy if exists "read own role" on public.user_roles;
create policy "read own role" on public.user_roles
  for select
  using (auth.uid() = user_id);

-- No insert/update/delete policy: roles are assigned with the service key
-- (seed-roles.js) or from the Supabase dashboard, never by the apps.

comment on table public.user_roles is
  'Who is a doctor and who is a scribe. Replaces the hardcoded admin email check.';
