-- ============================================================
-- 0004 — Income source tracking
--
-- WHAT THIS FILE DOES
-- Lets every expense name which income source paid for it, so the
-- dashboard can show a running balance per source ("Gaji", "Magang",
-- "Hibah") and a new expense can be rejected when the chosen source
-- cannot cover it.
--
-- WHY THE SOURCE IS `categories`
-- The source is an income-type row in public.categories, the same table
-- the transaction form already uses for the category dropdown. That table
-- already carries slug / name_key / icon / color, already has RLS letting
-- each user create their own rows, and already holds the five system rows
-- (gaji, freelance, investasi, bisnis, lainnya-in). No new table, so no new
-- RLS policy, no new grants, and no second seeding path to keep in sync.
--
-- GUARANTEES
--   - Nothing is dropped. No table, no column, no row.
--   - Every statement is idempotent; re-running this file is a no-op.
--   - Existing expenses keep funding_source_id = null. They were recorded
--     before sources existed, so they stay visible in the transaction list
--     and remain deletable. Only NEW expenses must pick a source — that
--     rule lives in addTransaction, not in a NOT NULL constraint, because
--     a constraint would reject the legacy rows on the next write.
--
-- Run this in the Supabase SQL Editor. It is safe to run repeatedly.
-- ============================================================


-- ------------------------------------------------------------
-- COLUMN — funding_source_id
--
-- on delete set null, not cascade: deleting a source must not delete the
-- expenses that were paid from it. A deleted source turns its expenses
-- back into "no source", which the app already renders and deletes fine.
-- ------------------------------------------------------------

do $$
begin
  if to_regclass('public.transactions') is null then
    raise warning
      'skipping funding_source_id — public.transactions does not exist (run 0002 first)';
    return;
  end if;

  if to_regclass('public.categories') is null then
    raise warning
      'skipping funding_source_id — public.categories does not exist (run 0002 first)';
    return;
  end if;

  alter table public.transactions add column if not exists funding_source_id uuid;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.transactions'::regclass
      and conname = 'transactions_funding_source_id_fkey'
  ) then
    alter table public.transactions
      add constraint transactions_funding_source_id_fkey
      foreign key (funding_source_id) references public.categories(id) on delete set null;
  end if;
end $$;


-- ------------------------------------------------------------
-- INDEX — per-user, per-source
--
-- The dashboard groups every transaction by source, and the server-side
-- balance check in addTransaction scans the user's rows for one source.
-- Both are (user_id, funding_source_id) lookups.
-- ------------------------------------------------------------

do $$
begin
  if to_regclass('public.transactions') is null then
    raise warning
      'skipping index on public.transactions — table does not exist (run 0002 first)';
    return;
  end if;

  if to_regclass('public.idx_transactions_funding_source') is null then
    create index idx_transactions_funding_source
      on public.transactions (user_id, funding_source_id);
  end if;
end $$;


-- ------------------------------------------------------------
-- GRANTS
--
-- 0003 granted table-level privileges on public.transactions. Those grants
-- cover the whole table as it existed then; a column added afterwards is
-- NOT covered by them. PostgREST would then reject an insert that names
-- funding_source_id with 42501 permission denied for the table, which
-- reads exactly like an auth bug and is very hard to spot from the app.
--
-- Guarded by to_regclass for the same reason 0003 guards its grants: on a
-- legacy database public.transactions may not exist yet.
-- ------------------------------------------------------------

do $$
begin
  if to_regclass('public.transactions') is null then
    raise warning
      'skipping column grants on public.transactions — table does not exist (run 0002)';
    return;
  end if;

  execute 'grant select (funding_source_id), insert (funding_source_id), update (funding_source_id) '
       || 'on public.transactions to authenticated';
end $$;


-- PostgREST caches its schema; without this the new column and foreign
-- key stay invisible and PGRST200/42703 keep firing.
notify pgrst, 'reload schema';


-- ------------------------------------------------------------
-- SELF-CHECK
--
-- Two things this migration can silently fail to deliver, both of which
-- would surface later as an opaque app error rather than a SQL error:
-- the column not existing, and the column grant not existing. A warning in
-- the SQL Editor output is far cheaper to act on than either.
-- ------------------------------------------------------------

do $$
declare
  has_column boolean;
  granted boolean;
begin
  select exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = 'transactions'
      and column_name = 'funding_source_id'
  ) into has_column;

  if not has_column then
    raise warning
      'public.transactions.funding_source_id is missing — income sources cannot be tracked';
    return;
  end if;

  -- Read from information_schema rather than has_column_privilege(): the
  -- three-argument form takes a role name and is not available on every
  -- PostgreSQL build the app may be checked against.
  select exists (
    select 1 from information_schema.column_privileges
    where grantee = 'authenticated'
      and table_schema = 'public'
      and table_name = 'transactions'
      and column_name = 'funding_source_id'
  ) into granted;

  if not granted then
    raise warning
      'authenticated lacks select on public.transactions.funding_source_id — inserts naming the column will fail with 42501';
  end if;
end $$;