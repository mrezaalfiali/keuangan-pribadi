-- ============================================================
-- 0023 — Private personal notes
--
-- Run manually in the Supabase SQL Editor after migration 0022.
-- Re-running this migration is safe.
-- ============================================================

create table if not exists public.notes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  title text not null check (char_length(title) between 1 and 120),
  content text not null check (char_length(content) between 1 and 5000),
  kind text not null default 'general' check (kind in ('general', 'finance')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_notes_user_updated
  on public.notes(user_id, updated_at desc);

create or replace function public.set_notes_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists notes_updated_at on public.notes;
create trigger notes_updated_at
  before update on public.notes
  for each row execute function public.set_notes_updated_at();

alter table public.notes enable row level security;

drop policy if exists "notes own" on public.notes;
create policy "notes own" on public.notes
  for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

grant select, insert, update, delete on public.notes to authenticated;

notify pgrst, 'reload schema';

-- ------------------------------------------------------------
-- SELF-CHECK
-- ------------------------------------------------------------
select
  to_regclass('public.notes') is not null as notes_table_exists,
  exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'notes'
      and policyname = 'notes own'
  ) as notes_policy_exists,
  (select count(*) from public.notes) as existing_notes;
