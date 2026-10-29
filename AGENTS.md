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
- Status terakhir: `0020` menggabungkan baris kategori bersufiks, `0021` menyelaraskan katalog bersama, `0022` menambahkan `category_overrides` untuk rename/hide sumber per akun, `0023` menambahkan catatan privat per akun, dan `0024` menambahkan achievement baru, pembaruan pencocokan vault darurat/tabungan, serta fungsi `check_user_achievements` (jalankan manual setelah migrasi sebelumnya). Verifikasi yang diharapkan: 4 policy `categories`, 27 baris `user_id is null`, 0 baris duplikat, 1 tabel + 1 policy `category_overrides`, 1 tabel + 1 policy `notes`, 17 baris katalog `achievements`, fungsi `check_user_achievements` dan `award_transaction_rewards`.

## Invarian kategori

- Baris `categories` dengan `user_id IS NULL` adalah katalog bersama untuk semua akun. Policy select harus selalu memuat `user_id is null`; kalau tidak, `ensureDefaultCategories` akan menyalin katalog ke tiap akun dan label bisa tampil ganda.
- `src/lib/system-categories.ts` — `dedupeCategories` menyatukan baris per `(type, slug ternormalisasi)`; `ensureDefaultCategories` hanya menyalin baris bawaan yang tidak terlihat sama sekali.
- `src/lib/labels.ts` — `stripGeneratedSuffix` membuang sufiks buatan `0003` (mis. `hiburan-d22c0e0e` → `hiburan`) saat menampilkan label, sehingga dedupe dan tampilan harus memakai ekspresi normalisasi yang sama.
