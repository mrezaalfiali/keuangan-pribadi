# Nexora — Keuangan Pribadi

Aplikasi Next.js untuk pencatatan dan pengelolaan keuangan pribadi. Akun,
transaksi, vault, anggaran, alokasi, dan reward disimpan di Supabase.

## Menyiapkan Supabase

1. Buat proyek di [Supabase Dashboard](https://supabase.com/dashboard).
2. Buka **SQL Editor**:
    - Proyek baru: jalankan seluruh isi
      [`supabase/migrations/0001_init.sql`](./supabase/migrations/0001_init.sql),
      lalu migrasi `0002` sampai `0010` secara berurutan.
   - Proyek yang sudah memiliki sebagian tabel: jalankan
     [`supabase/migrations/0002_complete_supabase_schema.sql`](./supabase/migrations/0002_complete_supabase_schema.sql).
     Lanjutkan dengan migrasi `0003` sampai `0010` secara berurutan. Migrasi
     `0002` aman dijalankan berulang kali dan melengkapi tabel yang belum ada.
     Jangan jalankan ulang `0001` pada proyek yang sudah memiliki tabel karena
     beberapa kebijakan di dalamnya tidak dibuat secara idempoten.
- Proyek yang tabelnya dibuat oleh versi aplikasi lama: **jangan** jalankan
      `0001`. Jalankan
       [`0002_complete_supabase_schema.sql`](./supabase/migrations/0002_complete_supabase_schema.sql)
       lalu
       [`0003_align_legacy_schema.sql`](./supabase/migrations/0003_align_legacy_schema.sql)
       lalu
       [`0004_income_source_tracking.sql`](./supabase/migrations/0004_income_source_tracking.sql)
       lalu
       [`0005_budget_periods.sql`](./supabase/migrations/0005_budget_periods.sql),
       [`0006_transaction_split_groups.sql`](./supabase/migrations/0006_transaction_split_groups.sql),
       dan
       [`0007_transfer_directions.sql`](./supabase/migrations/0007_transfer_directions.sql),
       lalu
       [`0008_atomic_gamification_rewards.sql`](./supabase/migrations/0008_atomic_gamification_rewards.sql),
       dan
       [`0009_recurring_transaction_reminders.sql`](./supabase/migrations/0009_recurring_transaction_reminders.sql),
       lalu
       [`0010_transaction_edit_and_backup_restore.sql`](./supabase/migrations/0010_transaction_edit_and_backup_restore.sql).

      Alasannya: `0001` memakai `create table if not exists`, jadi pada tabel yang
      sudah ada setiap perintah itu dilewati tanpa mengubah apa pun. Skrip lalu
      berhenti di `create index ... (user_id, date desc)` dengan
      `ERROR: 42703: column "date" does not exist`. `0001` kini mendeteksi kondisi
      ini di awal dan berhenti dengan pesan yang menyebut `0002` dan `0003`.

      Karena `0001` berhenti di baris 100, tabel yang didefinisikan sesudah
      `transactions` (`allocation_slots`, `budgets`, `gamification_state`,
      `points_log`, `user_achievements`) belum tentu ada — itu sebabnya `0002`
      wajib dijalankan lebih dulu. `0003` menambahkan kolom yang hilang, memulihkan
      foreign key, dan memindahkan nilai data lama ke kolom baru tanpa menghapus
      apa pun. Aman dijalankan berulang kali; jalankan seluruh file dari atas
      sampai bawah, termasuk bila eksekusi sebelumnya berhenti di tengah.

      Langkah pertama `0003` melepas constraint `NOT NULL` lama yang tidak punya
      `DEFAULT` pada enam tabel yang ia perbaiki sendiri, karena kolom seperti
      itu akan menolak setiap insert yang tidak mengirimnya (error `23502`).
Kolom yang memang wajib diisi aplikasi dikembalikan menjadi `NOT NULL`
      setelah data lama dibackfill. Tabel yang dibuat `0002` tidak tersentuh.

      ### Sumber pemasukan

      `0004` menambahkan kolom `transactions.funding_source_id` supaya setiap
      pengeluaran bisa menyebut sumber pemasukan yang membayarnya. Sumber itu
      sendiri adalah baris `categories` bertipe `income` — termasuk lima sumber
      bawaan — dan pengguna bebas menambah sumber baru lewat dasbor. Pengeluaran
       lama dibiarkan `NULL`: tetap tampil dan tetap bisa dihapus, hanya
       pengeluaran baru yang wajib memilih sumber.

       ### Periode anggaran

       `0005` mengganti kolom `budgets.month` dengan rentang `starts_on` dan
       `ends_on`. Anggaran tidak lagi terkunci ke bulan kalender, sehingga bisa
       mengikuti siklus gaji — misalnya `2026-03-10` sampai `2026-04-09` untuk
       gaji tanggal 10. Baris lama dibackfill ke rentang bulan penuh yang sama,
       jadi perilakunya tidak berubah sampai periodenya diedit.

       Kolom `rolled_over_from` mencatat asal sisa periode. Sisa menambah *batas*
       periode berikutnya, tidak memindahkan uang dan tidak membuat transaksi,
       jadi tidak ada yang bisa terduplikasi di ledger.

       ### Transfer antar-vault

       `0006` menambahkan `transactions.group_id` untuk menghubungkan baris-baris
       pemasukan yang dipecah oleh alokasi otomatis. `0007` menambahkan
       `transactions.transfer_direction`. Jalankan migrasi ini sebelum memakai
       versi aplikasi yang mencatat arah transfer: `out` mengurangi saldo vault
       asal dan `in` menambah saldo vault tujuan. Baris transfer lama dibiarkan
       `NULL` karena arahnya tidak dapat ditentukan dengan aman dari data transaksi
       saja; rekonsiliasi data lama secara manual bila saldo historis harus akurat.

       ### Poin dan achievement

       `0008` memindahkan pemberian poin dan pembukaan achievement ke satu fungsi
       database atomik. Transaksi pertama pada hari tersebut memberi poin harian
       dan bonus streak; achievement yang kriterianya tercapai terbuka satu kali
       dan hadiahnya masuk ke total poin. Poin harian tetap hanya diberikan sekali
       sehari meskipun beberapa transaksi dicatat bersamaan. Migrasi ini juga
       mencabut izin tulis langsung pengguna ke saldo poin dan log reward; reward
       hanya dapat diubah lewat fungsi yang memeriksa sesi pengguna.

       Jalankan `0008` setelah `0007` sebelum deploy versi aplikasi ini. Bila
       pembaruan reward gagal sesudah transaksi tersimpan, transaksi tetap aman
       dan formulir menampilkan peringatan; periksa koneksi dan jalankan ulang
       migrasi `0008`.

       ### Pengingat transaksi berulang

       `0009` menambahkan jadwal transaksi mingguan/bulanan dan pengingat yang
       harus ditinjau pengguna. Aplikasi tidak pernah mencatat transaksi hanya
       karena jadwal jatuh tempo. Pengguna dapat menyesuaikan nominal, tanggal,
       kategori, sumber dana, vault, dan catatan sebelum mengonfirmasi; setiap
       jadwal hanya dapat mencatat satu transaksi per tanggal kejadian. Pengingat
       juga dapat ditunda sampai besok, dilewati, dijeda, diubah, atau dihapus.

       Pilihan **Mingguan** menghitung interval dari tanggal jadwal: "setiap 2"
       berarti setiap dua minggu. Pilihan **Bulanan** mengikuti tanggal kalender:
       tanggal 10 akan tetap tanggal 10, sedangkan tanggal 29–31 disesuaikan ke
       hari terakhir pada bulan yang lebih pendek lalu kembali ke tanggal semula
       saat tersedia. Jika beberapa jadwal terlewat, aplikasi menampilkannya
       satu per satu agar pengguna dapat meninjau atau melewatinya. Pengingat
       tampil di menu **Transaksi** saat aplikasi dibuka; fitur ini belum mengirim
       push notification.

       Jalankan `0009` setelah `0008` sebelum menggunakan fitur jadwal berulang.

       ### Edit transaksi dan cadangan

       `0010` menambahkan pengeditan untuk transaksi pemasukan/pengeluaran
       tunggal, serta pencadangan JSON lengkap dan pemulihan secara gabung
       (*merge-only*). Transfer dan transaksi yang menjadi bagian dari grup
       split tidak dapat diedit satu per satu. Mengedit transaksi tidak
       memberikan atau menarik kembali poin dan achievement.

       Cadangan mencakup profil, kategori, vault, transaksi, anggaran, aturan
       dan slot alokasi, jadwal berulang, serta arsip reward. Pemulihan hanya
       menerima cadangan dari akun yang sama dan hanya menambahkan baris yang
       belum ada; data yang ada tidak ditimpa atau dihapus. Data reward di dalam
       arsip tidak diterapkan kembali agar pemulihan tidak mengubah poin atau
       achievement yang sudah berjalan. Berkas cadangan maksimal 10 MB dan
       20.000 baris data.

       Jalankan `0010` setelah `0009`, lalu tunggu cache skema Supabase dimuat
       ulang sebelum menggunakan fitur edit dan pemulihan.
3. Dari **Project Settings → API**, salin Project URL serta anon/public key.
   Buat `.env.local` di root proyek:

   ```env
   NEXT_PUBLIC_SUPABASE_URL=https://your-project.supabase.co
   NEXT_PUBLIC_SUPABASE_ANON_KEY=your-anon-or-publishable-key
   ```

   Jangan gunakan atau membagikan `service_role` key.
4. Di **Authentication → URL Configuration**, atur Site URL ke
   `http://localhost:3000` dan tambahkan
   `http://localhost:3000/auth/callback` ke Redirect URLs.
5. Jalankan aplikasi:

   ```powershell
   npm install
   npm run dev
   ```

6. Buka [http://localhost:3000](http://localhost:3000), daftar, lalu ikuti
   tautan konfirmasi email bila konfirmasi email diaktifkan pada Supabase.

Setelah deploy, tambahkan URL callback domain produksi ke Supabase Redirect
URLs dan atur environment variables yang sama di platform hosting.

## Memahami vault, alokasi, dan anggaran

Empat menu ini sering tertukar, padahal masing-masing menjawab pertanyaan berbeda.

| Menu | Pertanyaan | Fungsi |
| --- | --- | --- |
| Vault | Uang ini untuk apa? | Menyimpan saldo per tujuan, bisa dikunci agar tidak tersentuh |
| Alokasi | Uang ini dibagi ke mana? | Memecah setiap pemasukan baru ke beberapa vault sesuai aturan aktif |
| Anggaran | Boleh berapa untuk ini? | Membatasi dan memberi peringatan, tanpa memindahkan uang |
| Sumber pemasukan | Uang ini datang dari mana? | Menunjukkan sisa saldo per sumber (Gaji, Magang, Hibah) |

### Alokasi

Setiap pemasukan yang baru dicatat dipecah ke beberapa vault sesuai aturan yang
aktif, sehingga saldo tiap tujuan bertambah tanpa dicatat manual. Setiap aturan
wajib punya **tepat satu** slot `Sisa` (method `remainder`) — slot itulah yang
menerima bagian yang tidak dialokasikan, sehingga tidak ada dana yang hilang.
Total persen boleh di bawah 100% karena sisanya masuk ke slot `Sisa`.

Aturan hanya berlaku untuk pemasukan baru. Pemasukan yang sudah tercatat
sebelumnya tidak diubah, jadi saldo vault lama tetap sama seperti catatannya.

### Anggaran

Anggaran hanya membatasi dan memberi peringatan. Nilainya selalu dihitung ulang
dari ledger, bukan disimpan, jadi tidak bisa basi ketika transaksi diedit atau
dihapus. Hanya `type = 'expense'` yang dihitung — transfer antar vault tidak
mengurangi batas, karena memindahkan uang bukan pengeluaran.

Anggaran terikat ke satu cakupan (kategori expense atau vault) dan satu bulan.
Karena itu batas bulan lalu otomatis tidak lagi berlaku saat bulan berganti;
tombol salin tersedia untuk memindahkan angkanya tanpa mengetik ulang.

## Data

RLS membatasi akses data berdasarkan pengguna yang sedang masuk. Data yang
pernah tersimpan pada versi lokal browser tidak diunggah otomatis ke Supabase;
ekspor atau salin data tersebut sebelum menghapus data browser.

## Pembuat

**Moh. Reza Alfi Ali** — Pembuat dan pengembang Nexora.

- [Instagram](https://www.instagram.com/mrezaaaxx/)
- [LinkedIn](https://www.linkedin.com/in/mohrezaalfiali/)
- [GitHub](https://github.com/mrezaalfiali)

## Pemecahan masalah

Halaman yang gagal memuat data selalu menampilkan pesan yang sama, berapa pun
penyebabnya. Buka **browser console** untuk melihat penyebab sebenarnya: setiap
kegagalan di-log sebagai `[finance.load]` atau `[tools.load]`, lengkap dengan
kode PostgREST-nya.

| Kode | Arti | Tindakan |
| --- | --- | --- |
| `42703`, `42P01`, `PGRST200`, `PGRST205` | Kolom, tabel, atau relasi tidak ada di database | Jalankan migrasi SQL yang belum dijalankan |
| `22P02` pada `transactions.type` | Kolom `type` bertipe enum yang tidak punya label `transfer` | Jalankan ulang `0003` |
| `23502` | Ada kolom `NOT NULL` yang tidak diisi oleh seed/aplikasi | Jalankan ulang `0003` |
| `42501` pada `funding_source_id` | Kolom `funding_source_id` ada tapi role `authenticated` belum diberi izin kolom | Jalankan ulang `0004` |
| `PGRST202` pada `award_transaction_rewards` | Fungsi reward belum ada atau cache schema belum diperbarui | Jalankan `0008` dan tunggu cache PostgREST dimuat ulang |
| `42501` saat memperbarui reward | Sesi tidak terautentikasi atau fungsi `0008` belum diberi izin | Pastikan pengguna masuk dan jalankan `0008` |
| `PGRST204` pada `budgets` | Kolom `starts_on`/`ends_on` belum ada, jadi `0005` belum dijalankan | Jalankan ulang `0005` |
| `23505` pada `budgets` | `0005` dijalankan dua kali dengan `starts_on` yang bentrok | Jalankan ulang `0005` (aman diulang) |
| `PGRST204` pada `transfer_direction` atau `group_id` | Kolom transaksi belum ditambahkan | Jalankan `0006` dan `0007` secara berurutan |
| `42501` pada `transfer_direction` atau `group_id` | Role `authenticated` belum mendapat izin kolom | Jalankan ulang migrasi yang menambahkan kolom tersebut |
| `PGRST202` pada `record_recurring_transaction` atau `PGRST205` pada `recurring_transactions` | Migrasi pengingat transaksi berulang belum dijalankan atau cache skema belum dimuat ulang | Jalankan `0009` setelah `0008` dan tunggu cache PostgREST dimuat ulang |
| `PGRST202` pada `edit_financial_transaction` atau `restore_financial_backup`, atau `PGRST204` pada `backup_key` | Migrasi edit/cadangan belum dijalankan atau cache skema belum dimuat ulang | Jalankan `0010` setelah `0009` dan tunggu cache PostgREST dimuat ulang |
| `42501` | Role tidak punya izin pada tabel | Periksa `grant` di migrasi |
| `PGRST301`, `JWTExpired` | Sesi login tidak valid | Login ulang |
| `Failed to fetch` | Tidak bisa menghubungi Supabase | Periksa jaringan, proxy, atau VPN |

`0003` juga mencetak peringatan (`NOTICE`/`WARNING`) di output SQL Editor. Baca
pesan itu setelah menjalankan migrasi: setiap `relaxed tabel.kolom` menunjukkan
constraint lama yang dilepas, dan setiap `%.% is still NOT NULL with no default`
memberi tahu ada kolom yang masih bisa menolak insert. `0004` mencetak peringatan
jika `public.transactions` tidak ditemukan, atau jika `funding_source_id` ada
tanpa hak akses untuk `authenticated`.
