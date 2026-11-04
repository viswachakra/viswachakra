-- Second portal password.
--
-- The hospital alternates between TWO portal passwords (the portal forces a
-- reset and staff flip between them). The scraper tries the primary first and
-- the alternate on failure, and swaps them so the one that worked is primary.
-- Run this once in the Supabase SQL Editor, after supabase-app-settings.sql.

-- Hide the alternate from the browser as well (service key still reads both).
drop policy if exists "read non-secret settings" on public.app_settings;
create policy "read non-secret settings" on public.app_settings
  for select to authenticated
  using (key not in ('vaidya_password', 'vaidya_password_alt'));

create or replace function public.set_portal_password_alt(new_password text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  who text := coalesce(auth.jwt() ->> 'email', '');
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;
  insert into public.app_settings (key, value, updated_at, updated_by)
    values ('vaidya_password_alt', new_password, now(), who)
    on conflict (key) do update set value = excluded.value, updated_at = now(), updated_by = who;
  insert into public.app_settings (key, value, updated_at, updated_by)
    values ('vaidya_password_alt_meta', who, now(), who)
    on conflict (key) do update set value = excluded.value, updated_at = now(), updated_by = who;
end;
$$;

revoke all on function public.set_portal_password_alt(text) from public, anon;
grant execute on function public.set_portal_password_alt(text) to authenticated;

notify pgrst, 'reload schema';

-- Database size for the Settings tab. Security definer so a logged-in user can
-- read pg_database_size without table-level grants. Returns bytes.
create or replace function public.db_size()
returns table(name text, bytes bigint)
language sql
security definer
set search_path = public
as $$
  select 'database' as name, pg_database_size(current_database()) as bytes
  union all
  select c.relname::text, pg_total_relation_size(c.oid)
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind = 'r'
  order by bytes desc;
$$;
revoke all on function public.db_size() from public, anon;
grant execute on function public.db_size() to authenticated;

notify pgrst, 'reload schema';
