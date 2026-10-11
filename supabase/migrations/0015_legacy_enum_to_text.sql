-- ============================================================
-- 0015_legacy_enum_to_text.sql
--
-- WHY THIS FILE EXISTS
-- A legacy database can model some columns as PostgreSQL enums instead of
-- text. The one that actually bites is `transactions.type`, historically
-- declared as an enum named `transaction_type` (0003_align_legacy_schema.sql
-- already warns about it). The app schema (0001_init.sql) uses plain `text`
-- plus a CHECK constraint instead.
--
-- Postgres casts an *unknown literal* to an enum implicitly, which is why the
-- app's PostgREST inserts kept working on the enum. It does NOT cast a `text`
-- variable, so every PL/pgSQL function that inserts one into an enum column
-- dies with:
--
--   42804: column "type" is of type transaction_type but expression is of type text
--
-- That is what broke public.restore_financial_backup (backup restore). The same
-- mismatch also threatens the other writers that build `type` in a text
-- variable: record_recurring_transaction and the transaction inserts in
-- 0009/0011/0012/0013.
--
-- Aligning the column type with the fresh schema fixes all of them at once,
-- which is cheaper and safer than casting inside every function.
--
-- GUARANTEES
--   - Nothing is dropped. No row is touched; enum labels survive verbatim
--     as text (`income`/`expense`/`transfer` stay the same strings).
--   - Idempotent: re-running is a no-op once the columns are text.
--   - Only enum columns are converted; a database already on `text` is left
--     exactly as it was.
--
-- Run this in the Supabase SQL Editor. It is safe to run repeatedly.
-- ============================================================


-- ------------------------------------------------------------
-- STEP 1 — convert the enum columns to text
--
-- Two dependencies have to be lifted before the type can change, or the
-- ALTER aborts:
--
--   1. the DEFAULT. A stored 'expense'::transaction_type cannot cross the
--      change ("default for column cannot be cast automatically").
--   2. every CHECK involving the column. A legacy check stores enum-typed
--      literals, e.g. `type = ANY (ARRAY['income'::transaction_type, ...])`.
--      Once the column is text, rebuilding that expression gives
--      `text = transaction_type` and Postgres raises 42883 because no such
--      operator exists.
--
-- Both are dropped here and the canonical checks are re-added in STEP 3.
-- ------------------------------------------------------------

do $$
declare
  target record;
  att smallint;
  con record;
begin
  for target in
    select * from (values
      ('transactions',           'type'),
      ('recurring_transactions', 'type'),
      ('recurring_transactions', 'frequency'),
      ('categories',             'type')
    ) as t(table_name, column_name)
  loop
    if to_regclass('public.' || target.table_name) is null then
      continue;
    end if;

    -- Only an enum column needs this; att is null for text/anything else.
    select a.attnum into att
    from pg_attribute a
    join pg_type ty on ty.oid = a.atttypid
    where a.attrelid = ('public.' || target.table_name)::regclass
      and a.attname = target.column_name
      and ty.typtype = 'e'
      and a.attnum > 0
      and not a.attisdropped;
    if att is null then
      continue;
    end if;

    execute format(
      'alter table public.%I alter column %I drop default',
      target.table_name, target.column_name
    );

    for con in
      select conname
      from pg_constraint
      where conrelid = ('public.' || target.table_name)::regclass
        and contype = 'c'
        and att = any(conkey)
    loop
      execute format(
        'alter table public.%I drop constraint %I',
        target.table_name, con.conname
      );
      raise notice 'dropped check %.%', target.table_name, con.conname;
    end loop;

    execute format(
      'alter table public.%I alter column %I type text using %I::text',
      target.table_name, target.column_name, target.column_name
    );
    raise notice 'converted %.% from enum to text',
      target.table_name, target.column_name;
  end loop;
end $$;


-- ------------------------------------------------------------
-- STEP 2 — restore the defaults the fresh schema declares
--
-- Only categories.type carries one ('expense', see 0003).
-- ------------------------------------------------------------

do $$
begin
  if to_regclass('public.categories') is not null then
    alter table public.categories alter column type set default 'expense';
  end if;
end $$;


-- ------------------------------------------------------------
-- STEP 3 — make sure the CHECK constraints match 0001
--
-- On a legacy database these were never created (0003 skips the text CHECK
-- when the column is an enum). `not valid` then `validate` mirrors 0003's
-- style: new rows are checked immediately, while an unexpected legacy label
-- downgrades to a warning instead of aborting the whole migration.
-- ------------------------------------------------------------

do $$
begin
  if to_regclass('public.transactions') is null then return; end if;
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.transactions'::regclass
      and conname = 'transactions_type_check'
  ) then
    alter table public.transactions
      add constraint transactions_type_check
      check (type in ('income', 'expense', 'transfer')) not valid;
  end if;
exception when others then
  raise warning 'could not add transactions_type_check: %', sqlerrm;
end $$;

do $$
begin
  if to_regclass('public.transactions') is null then return; end if;
  alter table public.transactions validate constraint transactions_type_check;
exception when others then
  raise warning
    'transactions_type_check left NOT VALID (unexpected legacy value): %', sqlerrm;
end $$;

do $$
begin
  if to_regclass('public.recurring_transactions') is null then return; end if;
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.recurring_transactions'::regclass
      and conname = 'recurring_transactions_type_check'
  ) then
    alter table public.recurring_transactions
      add constraint recurring_transactions_type_check
      check (type in ('income', 'expense')) not valid;
  end if;
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.recurring_transactions'::regclass
      and conname = 'recurring_transactions_frequency_check'
  ) then
    alter table public.recurring_transactions
      add constraint recurring_transactions_frequency_check
      check (frequency in ('weekly', 'monthly')) not valid;
  end if;
exception when others then
  raise warning 'could not add recurring_transactions checks: %', sqlerrm;
end $$;

do $$
begin
  if to_regclass('public.recurring_transactions') is null then return; end if;
  alter table public.recurring_transactions validate constraint recurring_transactions_type_check;
  alter table public.recurring_transactions validate constraint recurring_transactions_frequency_check;
exception when others then
  raise warning
    'recurring_transactions checks left NOT VALID (unexpected legacy value): %', sqlerrm;
end $$;

do $$
begin
  if to_regclass('public.categories') is null then return; end if;
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.categories'::regclass
      and conname = 'categories_type_check'
  ) then
    alter table public.categories
      add constraint categories_type_check
      check (type in ('income', 'expense')) not valid;
  end if;
exception when others then
  raise warning 'could not add categories_type_check: %', sqlerrm;
end $$;

do $$
begin
  if to_regclass('public.categories') is null then return; end if;
  alter table public.categories validate constraint categories_type_check;
exception when others then
  raise warning
    'categories_type_check left NOT VALID (unexpected legacy value): %', sqlerrm;
end $$;


-- PostgREST caches its schema; without this the changed column types stay
-- invisible and the same 42804 keeps firing from the cached plan.
notify pgrst, 'reload schema';


-- ------------------------------------------------------------
-- SELF-CHECK — report any enum column still left in an app table
--
-- The restore function only writes the four columns above, so those are the
-- ones that had to change. Anything else still enum is a latent 42804 for the
-- next text-variable insert; a warning here is far cheaper than another
-- failed restore to discover it.
-- ------------------------------------------------------------

do $$
declare
  leftover record;
begin
  for leftover in
    select c.table_name, c.column_name, c.udt_name
    from information_schema.columns c
    join pg_type ty
      on ty.typname = c.udt_name
    join pg_namespace ns
      on ns.oid = ty.typnamespace and ns.nspname = c.udt_schema
    where c.table_schema = 'public'
      and ty.typtype = 'e'
      and c.table_name in (
        'profiles', 'categories', 'vaults', 'transactions',
        'allocation_rules', 'allocation_slots', 'budgets',
        'recurring_transactions', 'gamification_state', 'points_log'
      )
    order by c.table_name, c.column_name
  loop
    raise warning
      '%.% is still an enum (%) — a text variable insert will fail with 42804',
      leftover.table_name, leftover.column_name, leftover.udt_name;
  end loop;
end $$;
