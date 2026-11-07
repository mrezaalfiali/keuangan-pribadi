import type { Budget, BudgetBorrow, BudgetScope, Transaction } from "./types";
import { todayISO } from "./utils";

/**
 * Anggaran = batas pengeluaran, bukan aturan pemindahan uang.
 *
 * Setiap baris `budgets` diikat ke satu scope (kategori expense atau vault)
 * dan satu periode berupa rentang tanggal inklusif `starts_on`..`ends_on`.
 * Periode sengaja tidak dikunci ke bulan kalender: gaji datang tanggal 10, jadi
 * pengeluaran tanggal 1-9 memakai uang bulan sebelumnya dan tidak boleh ikut
 * terpotong periode yang gajinya baru cair.
 *
 * `spent` selalu dihitung ulang dari ledger, tidak disimpan, supaya tidak bisa
 * basi ketika transaksi lama diedit atau dihapus.
 *
 * Hanya `type === "expense"` yang dihitung, untuk kedua scope. Transfer keluar
 * dari vault mengurangi saldo vault, tetapi bukan pengeluaran — menghitungnya
 * akan membuat batas "makan bulanan" ikut berkurang setiap kali uang pindah.
 */
export function budgetSpend(
  transactions: readonly Pick<Transaction, "type" | "amount" | "category_id" | "vault_id" | "date">[],
  budget: Pick<Budget, "scope" | "scope_id" | "starts_on" | "ends_on">
): number {
  const { starts_on: startsOn, ends_on: endsOn } = budget;
  return transactions.reduce((sum, tx) => {
    if (tx.type !== "expense") return sum;
    // Bandingkan string ISO YYYY-MM-DD secara leksikografis: sama dengan
    // kronologis, dan tidak terpengaruh zona waktu seperti Date parsing.
    if (tx.date < startsOn || tx.date > endsOn) return sum;
    if (budget.scope === "category") return tx.category_id === budget.scope_id ? sum + tx.amount : sum;
    return tx.vault_id === budget.scope_id ? sum + tx.amount : sum;
  }, 0);
}

export type BudgetTransaction = Pick<
  Transaction,
  "type" | "amount" | "category_id" | "vault_id" | "date"
> & { id?: number };

export interface ExpenseCandidate {
  amount: number;
  date: string;
  category_id: string | null;
  vault_id: string | null;
}

export interface BudgetConflict {
  budget: Pick<Budget, "id" | "scope" | "scope_id" | "limit_amount" | "starts_on" | "ends_on"> &
    Partial<Pick<Budget, "leftover_discarded">>;
  /** Pemakaian sebelum transaksi baru, tanpa baris yang sedang diedit. */
  spent: number;
  /** Sisa sebelum transaksi baru; tidak pernah negatif. */
  remaining: number;
  /** Pemakaian setelah transaksi baru ditambahkan. */
  projected: number;
  /** Batas efektif (sudah memperhitungkan pinjaman) saat konflik terjadi. */
  effectiveLimit: number;
}

/** Jumlah pinjaman yang menempel pada satu baris anggaran. */
export interface BorrowTotals {
  borrowedIn: number;
  borrowedOut: number;
}

/** Baris `budget_borrows` -- hanya kolom yang dibutuhkan perhitungan. */
export type BudgetBorrowRow = Pick<BudgetBorrow, "from_budget_id" | "to_budget_id" | "amount">;

/**
 * Menjumlahkan pinjaman per baris anggaran: keluar dari pemberi,
 * masuk ke peminjam. Dipakai guard, UI, dan aksi server supaya semua
 * membaca angka efektif yang sama.
 */
export function aggregateBorrows(
  borrows: readonly BudgetBorrowRow[]
): Map<string, BorrowTotals> {
  const totals = new Map<string, BorrowTotals>();
  for (const row of borrows) {
    const from = totals.get(row.from_budget_id) ?? { borrowedIn: 0, borrowedOut: 0 };
    from.borrowedOut += row.amount;
    totals.set(row.from_budget_id, from);
    const to = totals.get(row.to_budget_id) ?? { borrowedIn: 0, borrowedOut: 0 };
    to.borrowedIn += row.amount;
    totals.set(row.to_budget_id, to);
  }
  return totals;
}

/**
 * Batas efektif sebuah anggaran.
 *
 * Pinjaman tidak mengubah `limit_amount` -- angka rencana yang dilihat
 * pemakai tetap apa adanya. Yang bergeser hanya kapasitas belanja baris
 * periode ini: `limit_amount + dipinjam masuk - dipinjam keluar`.
 *
 * `leftover_discarded` mencabut sisa anggaran: batas efektif turun ke angka yang
 * sudah terpakai, sehingga statusnya menjadi "penuh" dan pengeluaran baru dianggap
 * melebihi batas. Uangnya memang sudah dipindahkan lewat aksi transfer terpisah —
 * transfer sendiri tidak pernah dihitung sebagai belanja (lihat `budgetSpend`).
 *
 * Untuk anggaran yang belum ada terpakai sama sekali hasilnya 0: seluruh kuota
 * sudah dialihkan, tidak ada yang boleh dibelanjakan lagi. Angka yang sudah
 * kelewat batas tidak ditarik mundur, jadi batas efektif tidak pernah lebih besar
 * dari `limit_amount` maupun dari `spent` saat sisa ditutup.
 */
export function budgetEffectiveLimit(
  budget: Pick<Budget, "limit_amount"> & Partial<Pick<Budget, "leftover_discarded">>,
  spent: number,
  borrows?: BorrowTotals
): number {
  const base = Math.max(
    0,
    budget.limit_amount + (borrows?.borrowedIn ?? 0) - (borrows?.borrowedOut ?? 0)
  );
  if (!budget.leftover_discarded) return base;
  return Math.max(0, Math.min(base, Math.trunc(spent)));
}

/**
 * Pinjaman minimum dari transaksi ini yang harus tetap terpasang pada sebuah
 * anggaran peminjam setelah transaksi diedit, supaya guard pengeluaran tetap
 * lolos dengan batas efektif baru.
 *
 * Identitasnya: guard lolos bila `spent <= effectiveLimit`, dan batas efektif
 * memuat `+ borrowedIn - borrowedOut` di mana `linkedTotal` (baris yang
 * menempel pada transaksi ini) bagian dari `borrowedIn`. Diurutkan menjadi
 * `need = spent - effectiveLimit + linkedTotal`. Hasil ditalang ke 0 karena
 * kebutuhan tidak pernah di bawah nol. Karena guard pre-edit sudah memakai
 * total pinjaman yang sama dengan data pasca-edit, hasilnya selalu
 * `<= linkedTotal`: pengecilan tidak pernah menambah pinjaman.
 */
export function requiredBorrowTotal(
  budget: Pick<Budget, "limit_amount"> & Partial<Pick<Budget, "leftover_discarded">>,
  spent: number,
  borrows: BorrowTotals | undefined,
  linkedTotal: number
): number {
  return Math.max(0, spent - budgetEffectiveLimit(budget, spent, borrows) + linkedTotal);
}

export interface BorrowShrinkPlan {
  deleteIds: string[];
  updates: Array<{ id: string; amount: number }>;
}

/**
 * Rencana pengecilan pinjaman setelah sebuah transaksi diedit menjadi lebih
 * kecil. `needs` memuat `requiredBorrowTotal` per anggaran peminjam, `rows`
 * hanya baris yang menempel pada transaksi itu.
 *
 * Per anggaran, total baris diturunkan tepat ke kebutuhannya -- dibatasi
 * total yang ada, sehingga tidak pernah menambah dan tidak pernah di bawah
 * nol. Baris terkecil lebih dulu dihapus; baris penyerap sisanya dipotong
 * sebagian lewat update supaya hasilnya pas. Kebutuhan 0 menghapus seluruh
 * baris anggaran itu.
 */
export function planBorrowShrink(
  rows: readonly (BudgetBorrowRow & { id: string })[],
  needs: ReadonlyMap<string, number>
): BorrowShrinkPlan {
  const groups = new Map<string, (BudgetBorrowRow & { id: string })[]>();
  for (const row of rows) {
    const group = groups.get(row.to_budget_id);
    if (group) group.push(row);
    else groups.set(row.to_budget_id, [row]);
  }

  const plan: BorrowShrinkPlan = { deleteIds: [], updates: [] };
  for (const [budgetId, group] of groups) {
    const total = group.reduce((sum, row) => sum + row.amount, 0);
    const target = Math.min(total, Math.max(0, needs.get(budgetId) ?? 0));
    let surplus = total - target;
    if (surplus <= 0) continue;
    for (const row of [...group].sort((a, b) => a.amount - b.amount)) {
      if (surplus <= 0) break;
      if (row.amount <= surplus) {
        plan.deleteIds.push(row.id);
        surplus -= row.amount;
      } else {
        plan.updates.push({ id: row.id, amount: row.amount - surplus });
        surplus = 0;
      }
    }
  }
  return plan;
}

/**
 * Cari anggaran yang akan terlampaui oleh satu pengeluaran.
 *
 * Periode dipilih dari tanggal transaksi, bukan hari ini, sehingga transaksi
 * bertanggal mundur tetap dicek terhadap anggaran periode yang benar. Baris
 * yang sedang diedit dikeluarkan lewat `excludeTransactionId` agar nominal
 * lamanya tidak dihitung dua kali.
 *
 * `borrows` (hasil `aggregateBorrows`) menggeser batas efektif: pemberi yang
 * sudah meminjamkan sebagian sisanya menolak lebih awal, peminjam mendapat
 * ruang tambahan. Tanpa argumen, perilakunya sama persis dengan sebelum ada
 * pinjaman.
 *
 * Tepat sama dengan batas masih dianggap aman; hanya nilai di atas batas yang
 * mengembalikan konflik. "Batas" di sini batas efektif: anggaran yang sisa-
 * nya sudah ditutup menolak begitu pemakaiannya naik di atas angka terpakai.
 */
export function findExceededBudget(
  transactions: readonly BudgetTransaction[],
  budgets: readonly (Pick<
    Budget,
    "id" | "scope" | "scope_id" | "limit_amount" | "starts_on" | "ends_on"
  > &
    Partial<Pick<Budget, "leftover_discarded">>)[],
  candidate: ExpenseCandidate,
  excludeTransactionId?: number,
  borrows?: ReadonlyMap<string, BorrowTotals>
): BudgetConflict | null {
  const amount = Number(candidate.amount);
  if (!Number.isFinite(amount) || amount <= 0) return null;

  let worst: BudgetConflict | null = null;

  for (const budget of budgets) {
    if (candidate.date < budget.starts_on || candidate.date > budget.ends_on) continue;

    const matchesScope =
      budget.scope === "category"
        ? candidate.category_id === budget.scope_id
        : candidate.vault_id === budget.scope_id;
    if (!matchesScope) continue;

    const spent = budgetSpend(
      transactions.filter(
        (tx) => excludeTransactionId === undefined || tx.id !== excludeTransactionId
      ),
      budget
    );
    const effectiveLimit = budgetEffectiveLimit(budget, spent, borrows?.get(budget.id));
    const projected = spent + amount;
    if (projected <= effectiveLimit) continue;

    const conflict: BudgetConflict = {
      budget,
      spent,
      remaining: budgetLeftover(effectiveLimit, spent),
      projected,
      effectiveLimit,
    };
    if (
      !worst
      || conflict.projected - conflict.effectiveLimit
        > worst.projected - worst.effectiveLimit
    ) {
      worst = conflict;
    }
  }

  return worst;
}

export interface BorrowLenderCandidate {
  budget: Pick<
    Budget,
    "id" | "scope" | "scope_id" | "limit_amount" | "starts_on" | "ends_on"
  > &
    Partial<Pick<Budget, "leftover_discarded">>;
  /** Sisa efektif pemberi setelah pinjaman yang sudah berjalan. */
  remaining: number;
}

/**
 * Daftar anggaran yang boleh dipinjami untuk menutup kekurangan sebuah transaksi.
 *
 * Syarat yang sama dengan keputusan server di `borrowBudget`:
 * periodenya mencakup tanggal transaksi, sisa-ditutup dilarang, dan sisa
 * efektifnya masih positif. Anggaran itu sendiri dikeluarkan -- meminjam
 * dari diri sendiri tidak menambah apa pun. Pinjaman bebas lintas scope
 * (kategori boleh dipinjam dari vault dan sebaliknya): yang dipinjam adalah
 * izin plafon, bukan uang.
 *
 * Tanpa pinjaman yang tercatat, hasilnya daftar sisa biasa; begitu ada
 * yang dipinjamkan, kapasitas pemberi di daftar ini langsung menyusut.
 */
export function eligibleBorrowLenders(
  borrower: Pick<Budget, "id" | "scope"> & Partial<Pick<Budget, "leftover_discarded">>,
  budgets: readonly (Pick<
    Budget,
    "id" | "scope" | "scope_id" | "limit_amount" | "starts_on" | "ends_on"
  > &
    Partial<Pick<Budget, "leftover_discarded">>)[],
  transactions: readonly BudgetTransaction[],
  borrows: readonly BudgetBorrowRow[],
  date: string
): BorrowLenderCandidate[] {
  if (borrower.leftover_discarded) return [];
  const totals = aggregateBorrows(borrows);
  const candidates: BorrowLenderCandidate[] = [];
  for (const budget of budgets) {
    if (budget.id === borrower.id) continue;
    if (date < budget.starts_on || date > budget.ends_on) continue;
    if (budget.leftover_discarded) continue;
    const spent = budgetSpend(transactions, budget);
    const remaining = budgetLeftover(
      budgetEffectiveLimit(budget, spent, totals.get(budget.id)),
      spent
    );
    if (remaining <= 0) continue;
    candidates.push({ budget, remaining });
  }
  return candidates;
}

export type BudgetStatus = "ok" | "warning" | "full" | "exceeded";

/**
 * `alert_threshold` default-nya 0,8, jadi 80% dari batas sudah memicu peringatan
 * sebelum terlanjur habis. Batas nol tidak mungkin terjadi (CHECK di database),
 * tapi dijaga agar tidak menghasilkan Infinity di UI.
 */
export function budgetStatus(
  spent: number,
  limit: number,
  threshold = 0.8
): BudgetStatus {
  if (limit <= 0) return "ok";
  if (spent > limit) return "exceeded";
  if (spent === limit) return "full";
  if (spent >= limit * threshold) return "warning";
  return "ok";
}

/**
 * Status yang ditampilkan kartu anggaran, memperhitungkan sisa yang sudah ditutup
 * dan pinjaman yang sedang berjalan.
 *
 * Sisa yang dicabut membuat anggaran seketika terlihat "penuh" berapa pun angka
 * terpakainya, termasuk nol — kuotanya sudah dialihkan habis, tidak ada sisa yang
 * menunggu. Pemberi yang sudah meminjamkan seluruh sisanya juga terlihat penuh:
 * kapasitas belanjanya memang sudah dipakai peminjam. `budgetStatus` sendiri tidak
 * diubah karena batas nol tetap dimaknai aman di sana (sudah dikunci test).
 */
export function budgetDisplayStatus(
  budget: Pick<Budget, "limit_amount" | "alert_threshold"> &
    Partial<Pick<Budget, "leftover_discarded">>,
  spent: number,
  borrows?: BorrowTotals
): BudgetStatus {
  if (budget.leftover_discarded) return "full";
  return budgetStatus(
    spent,
    budgetEffectiveLimit(budget, spent, borrows),
    Number(budget.alert_threshold)
  );
}

/** Skema warna progress bar + teks status, dipakai oleh kartu anggaran. */
export function budgetRatio(spent: number, limit: number): number {
  if (limit <= 0) return 0;
  return spent / limit;
}
export const BUDGET_SCOPES: BudgetScope[] = ["category", "vault"];

const DAY_MS = 86_400_000;

/** `YYYY-MM-DD` -> `Date` UTC, atau `null` bila format/tanggalnya tidak valid. */
function parseISODate(value: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const monthIndex = Number(match[2]) - 1;
  const day = Number(match[3]);
  if (monthIndex < 0 || monthIndex > 11 || day < 1 || day > 31) return null;
  const date = new Date(Date.UTC(year, monthIndex, day));
  // Date.UTC meluncur 2026-02-31 menjadi 2 Maret; tolak tanggal yang tidak ada.
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== monthIndex ||
    date.getUTCDate() !== day
  ) {
    return null;
  }
  return date;
}

function formatISODate(date: Date): string {
  const year = date.getUTCFullYear();
  const month = `${date.getUTCMonth() + 1}`.padStart(2, "0");
  const day = `${date.getUTCDate()}`.padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export interface BudgetPeriod {
  startsOn: string;
  endsOn: string;
}

export function isValidPeriod(period: BudgetPeriod): boolean {
  const start = parseISODate(period.startsOn);
  const end = parseISODate(period.endsOn);
  if (!start || !end) return false;
  return end >= start;
}

/** Jumlah hari pada bulan tertentu, dalam UTC. */
function daysInMonth(year: number, monthIndex: number): number {
  return new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
}

/**
 * Periode berikutnya yang mengikuti pola tanggal, tepat setelah periode ini berakhir.
 *
 * Yang dipertahankan adalah *tanggal akhir*, bukan jumlah hari. Untuk siklus
 * gaji 10..9 itu penting: 10 Mar..9 Apr dilanjutkan 10 Apr..9 Mei, bukan
 * 10 Apr..10 Mei. Mempertahankan panjang hari justru akan menggeser siklus
 * setiap kali panjang bulan berbeda, dan periode 31 hari bisa menabrak bulan
 * yang hanya 30 hari.
 *
 * Bila periode menutup tepat di akhir bulan, pola "sampai hari terakhir"
 * diprioritaskan agar tidak memotong bulan lebih pendek. Satu hari tetap satu
 * hari.
 *
 * Hasilnya dijamin valid: `nextPeriod` tidak pernah mengembalikan rentang
 * terbalik, karena dipanggil juga oleh jalur yang menulis ke database yang
 * menolak `ends_on < starts_on`.
 */
export function nextPeriod(period: BudgetPeriod): BudgetPeriod | null {
  if (!isValidPeriod(period)) return null;
  const start = parseISODate(period.startsOn);
  const end = parseISODate(period.endsOn);
  if (!start || !end) return null;

  if (start.getTime() === end.getTime()) {
    const next = new Date(end.getTime() + DAY_MS);
    return { startsOn: formatISODate(next), endsOn: formatISODate(next) };
  }

  const endDay = end.getUTCDate();
  const endIsMonthEnd = endDay === daysInMonth(end.getUTCFullYear(), end.getUTCMonth());

  const nextStart = new Date(end.getTime() + DAY_MS);

  // Dua pola periode butuh penanganan berbeda, dan bedanya adalah apakah
  // periode awal menutup di bulan yang sama dengan awal mulainya.
  //
  //   - Periode satu bulan penuh (1..31 Mar) menutup di bulan yang sama dengan
  //     awal, jadi periode berikutnya juga berakhir di bulan `nextStart`:
  //     1 Apr..30 Apr. Kalau dihitung satu bulan lebih, hasilnya 1 Apr..31 Mei
  //     dan setiap periode justru bertambah panjang.
  //   - Periode payday (10 Mar..9 Apr) melintasi bulan, jadi periode berikutnya
  //     berakhir satu bulan setelah `nextStart`: 10 Apr..9 Mei. Di sini pola
  //     tanggal akhir yang harus terjaga, bukan jumlah hari.
  const spansMonths =
    end.getUTCFullYear() !== start.getUTCFullYear() ||
    end.getUTCMonth() !== start.getUTCMonth();

  const year = nextStart.getUTCFullYear();
  const monthIndex = nextStart.getUTCMonth() + (spansMonths ? 1 : 0);
  const lastDay = daysInMonth(year, monthIndex);
  const day = endIsMonthEnd ? lastDay : Math.min(endDay, lastDay);
  let nextEnd = new Date(Date.UTC(year, monthIndex, day));

  // Pola "hari akhir yang sama" tidak muat untuk periode yang lebih pendek dari
  // sebulan dan tidak menutup di akhir bulan: `day` bisa jatuh sebelum
  // `nextStart`, sehingga rentang berikutnya terbalik dan ditolak CHECK
  // `budgets_period_ordered` di database. Periode yang tidak muat memakai pola
  // kedua yang tersedia -- mempertahankan panjangnya -- karena itu satu-satunya
  // pola yang selalu menghasilkan rentang valid, tidak bergantung pada hari mana
  // yang kebetulan tersedia di bulan berikutnya.
  if (nextEnd.getTime() < nextStart.getTime()) {
    const lengthDays = Math.round((end.getTime() - start.getTime()) / DAY_MS) + 1;
    nextEnd = new Date(nextStart.getTime() + (lengthDays - 1) * DAY_MS);
  }

  return { startsOn: formatISODate(nextStart), endsOn: formatISODate(nextEnd) };
}

/**
 * Sisa anggaran yang belum terpakai, tidak pernah negatif.
 *
 * Periode yang sudah lewat batasnya tidak punya sisa untuk dibawa, dan negatif
 * harus dibulatkan ke 0: kalau dibiarkan, tombol "alokasikan sisa" akan
 * membuat batas periode berikutnya justru berkurang.
 */
export function budgetLeftover(limit: number, spent: number): number {
  return Math.max(0, Math.trunc(limit - spent));
}

/**
 * Periode default untuk anggaran baru: satu bulan penuh mulai hari ini.
 *
 * Dipakai form "Atur Batas" supaya yang terisi bukan rentang 1-2 hari. Yang
 * penting adalah panjangnya satu bulan; kedua tanggalnya tetap bisa dikoreksi
 * manual supaya sesuai tanggal gajian.
 */
export function defaultBudgetPeriod(today: string = todayISO()): BudgetPeriod | null {
  const start = parseISODate(today);
  if (!start) return null;
  // Satu bulan penuh: hari yang sama di bulan berikutnya, dikurangi satu hari.
  // Tidak lewat `nextPeriod`, karena itu mempertahankan *pola tanggal akhir* dan
  // akan menghasilkan rentang satu hari lagi kalau diberi input satu hari.
  const targetYear = start.getUTCFullYear();
  const targetMonth = start.getUTCMonth() + 1;
  const targetDay = Math.min(
    start.getUTCDate(),
    daysInMonth(targetYear, targetMonth % 12)
  );
  // `Date.UTC` menormalkan bulan 12 menjadi tahun berikutnya, jadi bulan selalu
  // dimodulo dulu sebelum dipakai menghitung hari terakhir.
  const endsOn = new Date(Date.UTC(targetYear, targetMonth, targetDay));
  endsOn.setUTCDate(endsOn.getUTCDate() - 1);
  return { startsOn: today, endsOn: formatISODate(endsOn) };
}

const MONTH_NAMES_ID = [
  "Januari", "Februari", "Maret", "April", "Mei", "Juni",
  "Juli", "Agustus", "September", "Oktober", "November", "Desember",
];

const MONTH_NAMES_EN = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/**
 * Label bulan gaji, misal "Maret 2026".
 *
 * Ambil dari `starts_on` — bulan tempat gaji masuk. Kalau periode 10 Mar..9 Apr
 * ditampilkan sebagai "Maret", itu masih terbaca sebagai satu bulan, bukan
 * rentang dua bulan yang membuat orang mengira mereka punya dua anggaran.
 */
export function paydayLabel(period: BudgetPeriod, locale: string): string {
  const start = parseISODate(period.startsOn);
  if (!start) return period.startsOn;
  const names = locale === "id" ? MONTH_NAMES_ID : MONTH_NAMES_EN;
  return `${names[start.getUTCMonth()]} ${start.getUTCFullYear()}`;
}

/**
 * Rentang tanggal ringkas, misal "10 Mar - 9 Apr".
 *
 * Tahun hanya ditampilkan kalau berbeda dari `year`, supaya periode gajian
 * yang sedang berjalan tidak jadi penuh dengan "2026" di setiap baris.
 */
export function periodRange(period: BudgetPeriod, locale: string, year?: number): string {
  const start = parseISODate(period.startsOn);
  const end = parseISODate(period.endsOn);
  if (!start || !end) return `${period.startsOn} - ${period.endsOn}`;

  const names = locale === "id" ? MONTH_NAMES_ID : MONTH_NAMES_EN;
  const startMonth = names[start.getUTCMonth()].slice(0, 3);
  const endMonth = names[end.getUTCMonth()].slice(0, 3);

  const startText = `${start.getUTCDate()} ${startMonth}`;
  const endText = `${end.getUTCDate()} ${endMonth}`;
  const crossYear = start.getUTCFullYear() !== end.getUTCFullYear();
  if (crossYear) return `${startText} ${start.getUTCFullYear()} - ${endText} ${end.getUTCFullYear()}`;
  if (year !== undefined && year !== start.getUTCFullYear()) {
    return `${startText} ${start.getUTCFullYear()} - ${endText}`;
  }
  return `${startText} - ${endText}`;
}

export type BudgetPeriodState = "upcoming" | "active" | "ended";

/**
 * Posisi periode terhadap hari ini. "ended" adalah satu-satunya periode yang
 * eligible untuk carry-over: sisa periode aktif masih bisa dibelanjakan.
 */
export function budgetState(
  budget: Pick<Budget, "starts_on" | "ends_on">,
  today: string = todayISO()
): BudgetPeriodState {
  if (today < budget.starts_on) return "upcoming";
  if (today > budget.ends_on) return "ended";
  return "active";
}
