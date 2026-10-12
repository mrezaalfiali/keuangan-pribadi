# Nexora — Keuangan Pribadi

Aplikasi Next.js untuk pencatatan dan pengelolaan keuangan pribadi. Akun,
transaksi, vault, anggaran, alokasi, dan reward disimpan di Supabase.

## Menyiapkan Supabase

1. Buat proyek di [Supabase Dashboard](https://supabase.com/dashboard).
2. Buka **SQL Editor**:
    - Proyek baru: jalankan seluruh isi
      [`supabase/migrations/0001_init.sql`](./supabase/migrations/0001_init.sql),
      lalu migrasi `0002` sampai `0019` secara berurutan.
   - Proyek yang sudah memiliki sebagian tabel: jalankan
     [`supabase/migrations/0002_complete_supabase_schema.sql`](./supabase/migrations/0002_complete_supabase_schema.sql).
     Lanjutkan dengan migrasi `0003` sampai `0019` secara berurutan. Migrasi
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
       [`0010_transaction_edit_and_backup_restore.sql`](./supabase/migrations/0010_transaction_edit_and_backup_restore.sql),
       [`0011_expense_vault_enforcement.sql`](./supabase/migrations/0011_expense_vault_enforcement.sql),
       [`0012_source_vault_pools.sql`](./supabase/migrations/0012_source_vault_pools.sql),
       [`0013_recurring_recording_fix.sql`](./supabase/migrations/0013_recurring_recording_fix.sql),
       [`0014_reset_financial_data.sql`](./supabase/migrations/0014_reset_financial_data.sql),
       [`0015_legacy_enum_to_text.sql`](./supabase/migrations/0015_legacy_enum_to_text.sql),
       lalu
       [`0016_profiles_on_signup.sql`](./supabase/migrations/0016_profiles_on_signup.sql),
       dan
       [`0017_preserve_user_categories_on_reset.sql`](./supabase/migrations/0017_preserve_user_categories_on_reset.sql),
       lalu
       [`0018_restore_system_categories.sql`](./supabase/migrations/0018_restore_system_categories.sql),
       lalu
       [`0019_add_expense_categories.sql`](./supabase/migrations/0019_add_expense_categories.sql).

      Jalankan migrasi `0017` untuk memperbarui fitur reset agar tetap menghapus
      transaksi dan data keuangan lainnya, tetapi mempertahankan kategori buatan
      pengguna. Migrasi ini menggantikan fungsi reset dari `0014`; data kategori
      yang terhapus oleh reset sebelumnya harus dipulihkan dari file backup.

      Jalankan `0018` untuk memastikan katalog kategori bawaan tersedia bagi
      semua akun. Migrasi ini aman dijalankan ulang dan tidak mengubah atau
      menghapus kategori buatan pengguna. Kategori buatan pengguna yang sudah
      terhapus sebelum `0017` tetap hanya dapat dikembalikan dari backup.

      Saat halaman keuangan dibuka, aplikasi juga memastikan 27 kategori bawaan
      tersimpan untuk akun yang sedang masuk. Jadi kategori yang hilang tetap
      dipulihkan pada akun tersebut tanpa membuat kategori duplikat, dan transaksi
      tetap menyimpan referensi kategori database yang valid.

      Migrasi `0019` dan katalog aplikasi menambahkan kategori pengeluaran umum
      seperti Self Reward, Keluarga, Anak, Rumah Tangga, Perawatan Diri,
      Komunikasi & Internet, Kendaraan, Hewan Peliharaan, Hadiah, Donasi,
      Langganan, Olahraga, Liburan, dan Pajak. Kategori ini otomatis dilengkapi
      untuk akun yang membuka halaman keuangan; migrasi `0019` menambahkannya
      sebagai kategori bawaan bersama.

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

       ### Pengeluaran wajib keluar dari vault

       `0011` menutup celah pengeluaran yang bisa dicatat tanpa vault. Sebelumnya
       pengeluaran hanya diperiksa terhadap saldo *sumber* pemasukan, bukan
       terhadap vault tempat uang itu benar-benar disimpan. Baris dengan
       `vault_id = null` dilewati oleh buku besar vault, jadi vault yang dikunci
       tetap menyimpan saldonya sementara sumbernya berkurang — uang yang sama
       terhitung dua kali dan penguncian tidak berguna.

       Aturannya kini: pengeluaran wajib menunjuk vault milik pengguna yang tidak
       dikunci dan saldonya cukup. Pemasukan tetap punya aturan sendiri (boleh
       dipecah alokasi, dan boleh mendarat di vault yang dikunci).

       ### Saldo per (sumber, vault)

       `0012` mempersempit pemeriksaan sumber menjadi *per pool*. Pemeriksaan
       sebelumnya menjumlah sumber pemasukan di semua vault lalu membandingkannya
       dengan pengeluaran, sehingga dua vault bisa menyimpan sumber yang sama dan
       uang di "Tabungan" bisa membayar pengeluaran dari "Darat" selama total
       sumbernya cukup. Sekarang pengeluaran harus ditutup oleh pool
       (sumber, vault) yang disebutnya lewat fungsi
       `transaction_source_vault_balance`. Pemeriksaan saldo vault tetap dipakai
       sebagai pengaman.

       Migrasi ini juga mengisi sumber untuk baris lama yang belum punya: transfer
       mendapat sumber sistem "Lainnya", dan pemasukan tanpa kategori mendapat
       sumber yang sama. Keduanya tanpa efek bila datanya sudah lengkap. Jalankan
       `0012` setelah `0011`.

       ### Perbaikan pencatatan transaksi berulang

       `0013` memperbaiki dua hal yang berakar pada skema lama. Pertama,
       `public.transactions.id` bertipe `uuid` pada database legacy, sementara
       seluruh repo mengasumsikan `bigint`; ketidakcocokan itu membuat "Tinjau &
       catat" gagal `22P02` dan mengganggu edit transaksi. Tidak ada foreign key
       yang menunjuk kolom itu, jadi menyelaraskannya ke `bigint` aman. Kedua,
       `record_recurring_transaction` kini menyimpan `funding_source_id` pada
       pengeluaran dan menerima mode alokasi eksplisit (`auto` mengikuti aturan
       aktif, `single` memilih satu vault).

       ### Reset data keuangan

       `0014` menambahkan fungsi `reset_financial_data` untuk menghapus seluruh
       data keuangan milik pengguna yang sedang masuk: transaksi, vault, kategori
       pribadi, anggaran, aturan dan slot alokasi, jadwal berulang, serta reward.
       Profil dan kategori bawaan sistem tetap dipertahankan. Aksi ini tersedia di
       **Pengaturan → Zona berbahaya** dan hanya berjalan setelah pengguna mengetik
       `RESET`. Fungsi berjalan sebagai `security definer` agar dapat membersihkan
       reward, tetapi tetap dibatasi pada `auth.uid()` pengguna.

       ### Kolom enum legacy menjadi teks

       `0015` mengubah kolom yang pada database legacy dideklarasikan sebagai
       enum PostgreSQL (yang utama: `transactions.type` dengan tipe
       `transaction_type`) menjadi `text` biasa berikut `CHECK` constraint, sama
       seperti skema aplikasi. Postgres meng-cast literal menjadi enum secara
       implisit, sehingga insert lewat PostgREST tetap berjalan, tetapi **tidak**
       meng-cast variabel `text` di dalam PL/pgSQL. Akibatnya setiap fungsi yang
       memasukkan kolom itu sebagai variabel gagal:

       ```
       42804: column "type" is of type transaction_type but expression is of type text
       ```

       Inilah penyebab "Pulihkan cadangan" gagal di database legacy. Jalankan
       `0015` setelah `0014` lalu tunggu cache skema PostgREST dimuat ulang.

       ### Profil dibuat saat akun mendaftar

       `0016` menambahkan trigger `on_auth_user_created` pada `auth.users` yang
       membuat baris `profiles` setiap akun baru, plus mengisi profil untuk akun
       lama yang belum punya. Sebelumnya pembuatan profil hanya dilakukan aplikasi
       dan bergantung pada `data.session`; bila email perlu dikonfirmasi sesi
       kosong, sehingga baris profil tak terbentuk dan penyimpanan nama tampilan
       (`PGRST116: 0 rows`) gagal. Jalankan `0016` setelah `0015`; operasi sisi
       aplikasi kini memakai `upsert` agar akun tanpa baris profil tetap aman.

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
| `42804` pada `transactions.type` (`column ... is of type transaction_type but expression is of type text`) | Kolom `type` masih bertipe enum legacy, sehingga fungsi PL/pgSQL gagal menyisipkannya | Jalankan `0015` lalu tunggu cache skema PostgREST dimuat ulang |
| `22P02` saat "Tinjau & catat" transaksi berulang | `public.transactions.id` masih bertipe `uuid`, bukan `bigint` | Jalankan `0013` |
| `PGRST202` pada `transaction_source_vault_balance` | Pemeriksaan pool sumber-vault belum ada | Jalankan `0012` setelah `0011` |
| `PGRST202` pada `record_recurring_transaction` (signature lama) | RPC berubah jumlah argumennya | Jalankan `0013` dan deploy versi aplikasi terbaru |
| `PGRST202` pada `reset_financial_data` | Fungsi reset belum ada | Jalankan `0014` |
| `transactions.expenseVaultRequired`, `transactions.lockedError`, `transactions.insufficient`, atau `transactions.sourceNotInVault` | Aturan pengeluaran (0011/0012) menolak transaksi: vault tidak ada/terkunci atau pool (sumber, vault) tidak cukup | Pilih vault dan sumber dana yang saldonya mencukupi; bukan masalah migrasi |
| `transactions.allocationRuleRequired` | Pemasukan mode alokasi otomatis dicatat tanpa aturan alokasi aktif (atau slotnya tidak bisa dipakai), sehingga tidak ada vault tujuan | Aktifkan aturan di menu **Alokasi**, atau catat dengan mode satu vault tujuan; bukan masalah migrasi |
| `PGRST116` saat menyimpan nama tampilan di **Pengaturan → Profil** | Akun dibuat sebelum trigger `0016` sehingga belum punya baris `profiles` | Jalankan `0016`; penyimpanan kini memakai `upsert` sehingga akun tanpa profil tetap aman |
| `42501` | Role tidak punya izin pada tabel | Periksa `grant` di migrasi |
| `PGRST301`, `JWTExpired` | Sesi login tidak valid | Login ulang |
| `Failed to fetch` | Tidak bisa menghubungi Supabase | Periksa jaringan, proxy, atau VPN |

`0003` juga mencetak peringatan (`NOTICE`/`WARNING`) di output SQL Editor. Baca
pesan itu setelah menjalankan migrasi: setiap `relaxed tabel.kolom` menunjukkan
constraint lama yang dilepas, dan setiap `%.% is still NOT NULL with no default`
memberi tahu ada kolom yang masih bisa menolak insert. `0004` mencetak peringatan
jika `public.transactions` tidak ditemukan, atau jika `funding_source_id` ada
tanpa hak akses untuk `authenticated`.
