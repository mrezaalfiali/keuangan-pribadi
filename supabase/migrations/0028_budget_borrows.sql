-- ============================================================
-- 0028_budget_borrows.sql
--
-- Pinjaman antar anggaran: saat pengeluaran ditolak karena kurang,
-- pemakai boleh meminjam sisa dari anggaran lain pada periode yang
-- sama. `limit_amount` tidak pernah diubah -- yang berubah hanya
-- batas efektif baris terkait:
--
--   efektif = limit_amount + dipinjam masuk - dipinjam keluar
--
-- Kolom `transaction_id` menautkan pinjaman ke transaksi yang
-- memicunya. FK-nya `on delete cascade`, jadi menghapus transaksi
-- otomatis mengembalikan sisa pemberi tanpa kode tambahan di aksi
-- hapus. Sebelum transaksi tersimpan (alur tambah) nilainya null;
-- `addTransaction` menautkannya setelah insert berhasil.
--
-- Idempoten: `create table if not exists` + `drop policy if exists`.
-- Policy per-op gaya 0001_init.sql. Reset data ikut bersih: RPC
-- reset menghapus budgets -> cascade membuang pinjamannya.
-- ============================================================

create table if not exists public.budget_borrows (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  from_budget_id uuid not null references public.budgets(id) on delete cascade,
  to_budget_id uuid not null references public.budgets(id) on delete cascade,
  transaction_id bigint references public.transactions(id) on delete cascade,
  amount integer not null check (amount > 0),
  created_at timestamptz not null default now(),
  check (from_budget_id <> to_budget_id)
);

create index if not exists idx_budget_borrows_user
  on public.budget_borrows(user_id);
-- FK cascade menghapus transaksi harus cepat menemukan baris terkait.
create index if not exists idx_budget_borrows_transaction
  on public.budget_borrows(transaction_id);

alter table public.budget_borrows enable row level security;

drop policy if exists "budget borrows select own" on public.budget_borrows;
create policy "budget borrows select own" on public.budget_borrows
  for select using (auth.uid() = user_id);
drop policy if exists "budget borrows insert own" on public.budget_borrows;
create policy "budget borrows insert own" on public.budget_borrows
  for insert with check (auth.uid() = user_id);
drop policy if exists "budget borrows update own" on public.budget_borrows;
create policy "budget borrows update own" on public.budget_borrows
  for update using (auth.uid() = user_id);
drop policy if exists "budget borrows delete own" on public.budget_borrows;
create policy "budget borrows delete own" on public.budget_borrows
  for delete using (auth.uid() = user_id);

grant select, insert, update, delete on public.budget_borrows to authenticated;

notify pgrst, 'reload schema';

-- ------------------------------------------------------------
-- SELF-CHECK
-- ------------------------------------------------------------
select
  to_regclass('public.budget_borrows') is not null as budget_borrows_table_exists,
  (select count(*)
     from pg_policies
    where schemaname = 'public'
      and tablename = 'budget_borrows'
      and policyname like 'budget borrows %') as budget_borrows_policy_count,
  exists (
    select 1
      from information_schema.table_constraints
     where table_schema = 'public'
       and table_name = 'budget_borrows'
       and constraint_type = 'FOREIGN KEY'
       and constraint_name like '%transaction_id%'
  ) as transaction_fk_exists,
  (select count(*) from public.budget_borrows) as existing_budget_borrows;
