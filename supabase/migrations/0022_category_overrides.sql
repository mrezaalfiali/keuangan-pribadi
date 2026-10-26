-- ============================================================
-- 0022 — Per-account income source overrides
--
-- WHAT THIS FILE DOES
-- Lets every account rename or hide the shared income-source catalog
-- (`categories.user_id IS NULL`) without changing the row other accounts
-- read. A default source is still shared until an account overrides it;
-- after that, only that account sees the new name or the hidden state.
--
-- WHY NOT UPDATE / DELETE THE SHARED ROW
-- The defaults are one catalog for every account. Editing the shared row
-- would rename it for everyone, and deleting it would remove it for everyone.
-- This table keeps the catalog intact while storing the account's choice.
--
-- GUARANTEES
--   - Nothing in public.categories is dropped or rewritten.
--   - Only the calling account can read or write its overrides.
--   - Every statement is idempotent; re-running this file is a no-op.
--
-- Run this in the Supabase SQL Editor. It is safe to run repeatedly.
-- ============================================================

do $$
begin
  if to_regclass('public.categories') is null then
    raise warning
      'skipping category overrides — public.categories does not exist (run 0001 first)';
    return;
  end if;

  create table if not exists public.category_overrides (
    user_id uuid not null references auth.users(id) on delete cascade,
    category_id uuid not null references public.categories(id) on delete cascade,
    custom_name text check (custom_name is null or char_length(custom_name) between 1 and 80),
    hidden boolean not null default false,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    primary key (user_id, category_id)
  );

  alter table public.category_overrides enable row level security;

  execute 'drop policy if exists "category overrides own" on public.category_overrides';
  execute $policy$
    create policy "category overrides own" on public.category_overrides
      for all
      using (user_id = auth.uid())
      with check (
        user_id = auth.uid()
        and exists (
          select 1
          from public.categories c
          where c.id = category_id
            and (c.user_id is null or c.user_id = auth.uid())
        )
      )
  $policy$;

  execute 'grant select, insert, update, delete on public.category_overrides to authenticated';
end $$;

notify pgrst, 'reload schema';


-- ------------------------------------------------------------
-- SELF-CHECK
-- ------------------------------------------------------------
do $$
declare
  has_table  boolean;
  has_policy boolean;
  total      integer;
begin
  select to_regclass('public.category_overrides') is not null into has_table;

  if not has_table then
    raise warning
      'public.category_overrides is missing — default sources cannot be renamed or hidden';
    return;
  end if;

  select exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'category_overrides'
      and policyname = 'category overrides own'
  ) into has_policy;

  if not has_policy then
    raise warning
      'public.category_overrides has no RLS policy — overrides are unreadable or unsafe';
  end if;

  select count(*) into total from public.category_overrides;

  raise notice
    'category overrides ready: 1 table, 1 policy, % existing row(s)', total;
end $$;
