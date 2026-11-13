<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

## Perintah proyek

- `npm test` (vitest), `npm run lint` (eslint), `npm run build` — ketiganya wajib lolos sebelum push.
- `next.config.ts` menonaktifkan `ignoreBuildErrors`, jadi `npm run build` menjalankan type-check TypeScript dan gagal bila ada kesalahan tipe.
- `npm run dev` untuk server lokal; Supabase diarahkan lewat `.env.local` (ter-ignore, cukup `NEXT_PUBLIC_SUPABASE_URL` + `NEXT_PUBLIC_SUPABASE_ANON_KEY`).

## Migrasi basis data

- Tidak ada Supabase CLI dan tidak ada ledger `supabase_migrations.schema_migrations`. Setiap file di `supabase/migrations/` dijalankan manual lewat SQL Editor, berurutan dari `0001`.
- **Jangan jalankan `supabase db push`** — akan mengeksekusi ulang seluruh migrasi dari awal terhadap data berisi.
- Migrasi baru = file bernomor berikutnya. Harus idempoten (aman dijalankan ulang), diakhiri query verifikasi bila menyentuh data, dan policy yang dibuat harus konsisten dengan `0001_init.sql`.
- Status terakhir: `0031` menulis ulang `restore_financial_backup` untuk memuat `category_overrides` (catatan rename/sembunyi kategori per akun ikut dipulihkan; validasi jumlah baris kunci opsional, loop setelah `categories` karena FK `category_id`, baris dengan kategori tak ditemukan dilewati, `on conflict (user_id, category_id) do nothing`), setelah `0030` yang menambahkan tabel `vault_borrows` (pinjaman uang antar vault: uang berpindah lewat transfer internal 2 baris dalam satu group, `outstanding` menyimpan sisa utang dan boleh dibayar sebagian lewat `repayVaultBorrow`, `transfer_out_id` FK `on delete set null` sehingga hapus transaksi yang menutup utang boleh terjadi setelah lunas saja) sekaligus menulis ulang `restore_financial_backup` untuk memuatnya (validasi jumlah baris kunci opsional `vault_borrows`, loop restore dengan `transfer_backup_key` yang diresolusi ke `transactions.backup_key`), setelah `0029` yang memperluas fungsi `restore_financial_backup` untuk menyertakan `budget_borrows` (resolusi relasi anggaran dan transaksi via `transaction_backup_key`, baris tak-terekonsiliasi dilewati), setelah `0028` yang menambahkan tabel `budget_borrows` (pinjaman antar anggaran: `limit_amount` tidak diubah, hanya batas efektif `limit + dipinjam masuk - dipinjam keluar`; `transaction_id` FK `on delete cascade` sehingga hapus transaksi otomatis mengembalikan sisa pemberi), `0027` menambahkan guard kunci vault pada edit pemasukan (pindah vault / turun nominal dari vault terkunci ditolak), `0026` menambahkan kolom `budgets.leftover_discarded` (keputusan "tutup sisa": sisa dicabut sehingga batas efektif turun ke angka terpakai, status jadi "penuh", dan pengeluaran baru ditolak; berlaku untuk anggaran berjalan maupun periode berakhir, tanpa menghitung transfer sebagai belanja), `0025` menjadikan `vault_id` wajib pada edit pemasukan (guard `edit_financial_transaction`), setelah `0024` yang menambahkan achievement baru, pembaruan pencocokan vault darurat/tabungan, serta fungsi `check_user_achievements` (jalankan manual setelah migrasi sebelumnya). Verifikasi yang diharapkan: 4 policy `categories`, 27 baris `user_id is null`, 0 baris duplikat, 1 tabel + 1 policy `category_overrides`, 1 tabel + 1 policy `notes`, 17 baris katalog `achievements`, fungsi `check_user_achievements` dan `award_transaction_rewards`, `pg_get_functiondef(edit_financial_transaction)` memuat guard `p_vault_id is null` pada branch pemasukan DAN ekspresi `is distinct from v_transaction.vault_id`, 0 baris `type='income'` tanpa `vault_id`, kolom `budgets.leftover_discarded boolean not null default false`, tabel `budget_borrows` dengan 4 policy `budget borrows *`, FK `transaction_id` ke `transactions`, 0 baris `budget_borrows`, tabel `vault_borrows` dengan 4 policy `vault borrows *`, FK `transfer_out_id` ke `transactions`, 0 baris `vault_borrows`, serta `pg_get_functiondef(restore_financial_backup)` memuat `budget_borrows`, `vault_borrows`, `category_overrides`, dan `transaction_backup_key`.

## Invarian kategori

- Baris `categories` dengan `user_id IS NULL` adalah katalog bersama untuk semua akun. Policy select harus selalu memuat `user_id is null`; kalau tidak, `ensureDefaultCategories` akan menyalin katalog ke tiap akun dan label bisa tampil ganda.
- `src/lib/system-categories.ts` — `dedupeCategories` menyatukan baris per `(type, slug ternormalisasi)`; `ensureDefaultCategories` hanya menyalin baris bawaan yang tidak terlihat sama sekali.
- `src/lib/labels.ts` — `stripGeneratedSuffix` membuang sufiks buatan `0003` (mis. `hiburan-d22c0e0e` → `hiburan`) saat menampilkan label, sehingga dedupe dan tampilan harus memakai ekspresi normalisasi yang sama.
