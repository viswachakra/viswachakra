-- App settings: lets the admin change the portal password from the web UI (Settings tab)
-- instead of editing .env by hand. Run this once in the Supabase SQL Editor.
--
-- Security model:
--   * The web app uses the ANON key + a logged-in session. RLS below lets an authenticated
--     user WRITE any setting, and READ every setting EXCEPT the secret password row --
--     so the browser can show "last updated" but can never read the password back.
--   * The scraper uses the SERVICE_ROLE key, which bypasses RLS, so it (and only it)
--     can read 'vaidya_password'.

create table if not exists public.app_settings (
  key         text primary key,
  value       text,
  updated_at  timestamptz not null default now(),
  updated_by  text
);

alter table public.app_settings enable row level security;

-- Read everything EXCEPT the secret password row.
drop policy if exists "read non-secret settings" on public.app_settings;
create policy "read non-secret settings" on public.app_settings
  for select to authenticated
  using (key <> 'vaidya_password');

-- Create settings rows.
drop policy if exists "insert settings" on public.app_settings;
create policy "insert settings" on public.app_settings
  for insert to authenticated
  with check (true);

-- Update settings rows (upsert-on-conflict uses this).
drop policy if exists "update settings" on public.app_settings;
create policy "update settings" on public.app_settings
  for update to authenticated
  using (true) with check (true);
