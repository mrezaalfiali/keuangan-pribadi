-- ============================================================
-- 0026_budget_leftover_discarded.sql
--
-- Menambahkan penanda keputusan "sisa periode ini tidak saya bawa" pada
-- baris anggaran.
--
-- Tanpa kolom ini, periode berakhir yang masih punya sisa selalu tampil
-- di daftar "menunggu keputusan" -- tidak ada cara menutupnya kecuali
-- membawa sisa atau menghabiskan batasnya. Dengan `leftover_discarded`,
-- baris keluar dari tampilan default dan masuk ke riwayat, tetapi
-- keputusan bisa dibatalkan (toggle) tanpa kehilangan data apa pun.
--
-- Idempoten: `add column if not exists`. Tidak ada perubahan policy:
-- keempat policy budgets dari 0001/0002 (select/insert/update/delete own)
-- sudah mencakup kolom baru di baris yang sama.
-- Tidak ada data yang dimigrasi; kolom default false = semua anggaran
-- lama dianggap "belum diputuskan".
-- ============================================================

alter table public.budgets
  add column if not exists leftover_discarded boolean not null default false;

-- ------------------------------------------------------------
-- Verifikasi: satu kolom boolean, not null, default false.
-- ------------------------------------------------------------
select column_name, data_type, is_nullable, column_default
from information_schema.columns
where table_schema = 'public'
  and table_name = 'budgets'
  and column_name = 'leftover_discarded';
