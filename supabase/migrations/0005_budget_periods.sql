-- ============================================================
-- 0005 — Budget periods
--
-- WHAT THIS FILE DOES
-- Replaces the single calendar `month` column on public.budgets with an
-- explicit `starts_on` / `ends_on` range, and adds `rolled_over_from` so
-- unspent budget can be carried into the next period exactly once.
--
-- WHY A RANGE INSTEAD OF A MONTH
-- Payday is not the 1st. Someone paid on the 10th spends on the 1st-9th out of
-- the previous month's money, so a calendar-month budget charges those expenses
-- to a period whose income has not arrived yet. A range lets the period follow
-- the actual cash cycle: 2026-10-10 .. 2026-11-09.
--
-- Ranges are per budget, not global. Different categories can have genuinely
-- different cycles (a quarterly insurance premium is not a monthly thing), and
-- a single global payday would force a lie onto those.
--
-- WHY CARRY-OVER ADJUSTS A LIMIT, NOT A BALANCE
-- A budget is a spending cap, not a pot of money. Carrying "sisa" forward means
-- the next period may spend up to (its own limit + leftover). No money moves and
-- no transaction is written, so there is nothing to double-count and nothing to
-- roll back. `rolled_over_from` is the idempotency guard: one source period can
-- feed at most one successor, checked in carryOverBudget.
--
-- GUARANTEES
--   - Nothing is dropped. No table, no row, no limit_amount.
--   - Existing rows keep their limit and gain a range covering the same month:
--     2026-10-01 .. 2026-10-31. Behaviour is unchanged until you edit a period.
--   - Every statement is idempotent; re-running this file is a no-op.
--
-- Run this in the Supabase SQL Editor. It is safe to run repeatedly.
-- ============================================================


do $$
begin
  if to_regclass('public.budgets') is null then
    raise warning 'skipping budget periods — public.budgets does not exist (run 0001/0003 first)';
    return;
  end if;

  alter table public.budgets add column if not exists starts_on date;
  alter table public.budgets add column if not exists ends_on date;
  alter table public.budgets add column if not exists rolled_over_from uuid;

  -- Backfill before the NOT NULL is applied, otherwise a table holding rows
  -- would fail the ALTER. `month` is always the 1st (currentMonthISO), but the
  -- expression does not assume that: it derives a full calendar month from it.
  --
  -- Dijaga cek keberadaan kolom `month` karena blok ini boleh dijalankan ulang.
  -- Pada penjalanan kedua `month` sudah dilepas di blok paling bawah, dan
  -- merujuknya akan gagal dengan 42703 sekaligus membatalkan sisa blok.
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'budgets' and column_name = 'month'
  ) then
    update public.budgets
       set starts_on = coalesce(starts_on, month)
     where starts_on is null;

    update public.budgets
       set ends_on = coalesce(ends_on, (month + interval '1 month - 1 day')::date)
     where ends_on is null;
  end if;

  -- Bila `month` sudah tidak ada tapi kolom periode masih kosong, isikan dengan
  -- rentang bulan penuh yang memuat hari ini. Ini hanya mungkin pada tabel yang
  -- datanya hilang, tapi lebih baik daripada menggagalkan NOT NULL dengan pesan
  -- yang tidak menjelaskan apa pun.
  update public.budgets
     set starts_on = date_trunc('month', current_date)::date
   where starts_on is null;

  update public.budgets
     set ends_on = (date_trunc('month', current_date) + interval '1 month - 1 day')::date
   where ends_on is null;

  alter table public.budgets alter column starts_on set not null;
  alter table public.budgets alter column ends_on set not null;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.budgets'::regclass
      and conname = 'budgets_period_ordered'
  ) then
    alter table public.budgets
      add constraint budgets_period_ordered check (ends_on >= starts_on);
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.budgets'::regclass
      and conname = 'budgets_rolled_over_from_fkey'
  ) then
    -- on delete set null, not cascade: deleting the source period must not
    -- delete the period that inherited its leftover.
    alter table public.budgets
      add constraint budgets_rolled_over_from_fkey
      foreign key (rolled_over_from) references public.budgets(id) on delete set null;
  end if;
end $$;


-- ------------------------------------------------------------
-- UNIQUENESS AND INDEXES
--
-- 0001 declared `unique (user_id, scope, scope_id, month)` unnamed, so
-- PostgreSQL named it budgets_user_id_scope_scope_id_month_key. Uniqueness
-- moves to starts_on: one period per scope, identified by where it begins.
-- ------------------------------------------------------------

do $$
begin
  if to_regclass('public.budgets') is null then
    raise warning 'skipping budget index work — public.budgets does not exist';
    return;
  end if;

  alter table public.budgets drop constraint if exists budgets_user_id_scope_scope_id_month_key;
  drop index if exists public.idx_budgets_user;

  create index if not exists idx_budgets_user
    on public.budgets (user_id, starts_on);

  -- Melayani cek idempotensi di carryOverBudget ("apakah periode ini sudah punya
  -- satu periode penerus?") tanpa memindai semua anggaran milik pengguna.
  --
  -- UNIQUE, bukan index biasa. Dua klik bersamaan bisa saja sama-sama lolos cek
  -- `alreadyCarried` sebelum salah satunya menulis baris, dan tanpa batasan di
  -- database keduanya akan menambah sisa sehingga batas periode berikutnya naik
  -- dua kali dalam satu klik. Unique partial di sini yang menutup celah itu —
  -- cek di aplikasi hanya pelonggaran, bukan jaminan.
  create unique index if not exists idx_budgets_rollover_source
    on public.budgets (rolled_over_from)
    where rolled_over_from is not null;

  create unique index if not exists budgets_user_scope_start
    on public.budgets (user_id, scope, scope_id, starts_on);
end $$;


-- ------------------------------------------------------------
-- DROP THE OLD COLUMN
--
-- Last, so the backfill above still had `month` to read. Everything that
-- referenced it has been migrated to the range first.
-- ------------------------------------------------------------

do $$
begin
  if to_regclass('public.budgets') is null then
    raise warning 'skipping budgets.month drop — public.budgets does not exist';
    return;
  end if;

  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'budgets' and column_name = 'month'
  ) then
    alter table public.budgets drop column month;
  end if;
end $$;


-- ------------------------------------------------------------
-- GRANTS
--
-- 0003 granted table-level select/insert/update/delete, which in PostgreSQL
-- already covers columns added later. These explicit column grants are kept
-- only to match the existing 0003/0004 convention, so that revoking a column
-- privilege later stays possible per column. Harmless if redundant.
-- ------------------------------------------------------------

do $$
begin
  if to_regclass('public.budgets') is null then
    raise warning 'skipping budgets column grants — public.budgets does not exist';
    return;
  end if;

  execute 'grant select (starts_on, ends_on, rolled_over_from), '
       || 'insert (starts_on, ends_on, rolled_over_from), '
       || 'update (starts_on, ends_on, rolled_over_from) '
       || 'on public.budgets to authenticated';
end $$;


-- PostgREST caches its schema; without this the new columns and the dropped
-- one stay invisible and the app keeps reading the old shape.
notify pgrst, 'reload schema';


-- ------------------------------------------------------------
-- SELF-CHECK
--
-- Four failure modes that would all surface later as an opaque app error:
-- a NULL range, an inverted range, the old column still present, or a NULL row
-- surviving the backfill. Each is a warning here instead of a broken page.
-- ------------------------------------------------------------

do $$
declare
  total           integer;
  null_range      integer;
  inverted        integer;
  still_has_month boolean;
begin
  if to_regclass('public.budgets') is null then
    raise warning 'public.budgets does not exist — budget periods were not applied';
    return;
  end if;

  select count(*) into total from public.budgets;

  select count(*) into null_range
    from public.budgets where starts_on is null or ends_on is null;

  select count(*) into inverted
    from public.budgets where ends_on < starts_on;

  select exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'budgets' and column_name = 'month'
  ) into still_has_month;

  if null_range > 0 then
    raise warning
      'public.budgets has % row(s) with a NULL period — budget ranges are broken', null_range;
  end if;

  if inverted > 0 then
    raise warning
      'public.budgets has % row(s) where ends_on < starts_on — budget ranges are inverted', inverted;
  end if;

  if still_has_month then
    raise warning
      'public.budgets still has a month column — 0005 did not finish';
  end if;

  if null_range = 0 and inverted = 0 and not still_has_month then
    raise notice
      'budget periods applied: % row(s) now carry starts_on/ends_on', total;
  end if;
end $$;
