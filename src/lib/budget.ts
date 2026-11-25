import type {
  Budget,
  BudgetBorrow,
  BudgetReallocation,
  BudgetScope,
  Transaction,
} from "./types";
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
 * Expense dihitung untuk kedua scope. Transfer ber-kategori menghitung leg
 * keluar satu kali pada anggaran kategori; leg masuk tidak menggandakan biaya
 * dan transfer tanpa kategori tidak memakai anggaran kategori. Transfer tidak
 * memakai anggaran vault karena hanya memindahkan saldo antar-vault.
 */

/**
 * Baris transaksi yang ikut terhitung pada satu anggaran -- sumber tunggal
 * untuk `budgetSpend` maupun daftar transaksi di kartu riwayat, supaya angka
 * terpakai dan isi daftarnya tidak mungkin berbeda.
 *
 * Predikatnya persis aturan `budgetSpend` lama: expense penuh untuk kedua
 * scope, transfer ber-kategori hanya leg keluar pada scope kategori, batas
 * tanggal inklusif dibandingkan leksikografis (kronologis untuk ISO, tanpa
 * perbedaan zona waktu).
 */
export function budgetTransactions<
  T extends Pick<Transaction, "type" | "amount" | "category_id" | "vault_id" | "date"> &
    Partial<Pick<Transaction, "transfer_direction">>
>(transactions: readonly T[], budget: Pick<Budget, "scope" | "scope_id" | "starts_on" | "ends_on">): T[] {
  const { starts_on: startsOn, ends_on: endsOn } = budget;
  return transactions.filter((tx) => {
    const isExpense = tx.type === "expense";
    const isCategorizedTransferOut =
      budget.scope === "category" &&
      tx.type === "transfer" &&
      tx.transfer_direction === "out";
    if (!isExpense && !isCategorizedTransferOut) return false;
    // Bandingkan string ISO YYYY-MM-DD secara leksikografis: sama dengan
    // kronologis, dan tidak terpengaruh zona waktu seperti Date parsing.
    if (tx.date < startsOn || tx.date > endsOn) return false;
    if (budget.scope === "category") return tx.category_id === budget.scope_id;
    return tx.vault_id === budget.scope_id;
  });
}

export function budgetSpend(
  transactions: readonly (
    Pick<Transaction, "type" | "amount" | "category_id" | "vault_id" | "date"> &
    Partial<Pick<Transaction, "transfer_direction">>
  )[],
  budget: Pick<Budget, "scope" | "scope_id" | "starts_on" | "ends_on">
): number {
  return budgetTransactions(transactions, budget).reduce((sum, tx) => sum + tx.amount, 0);
}

export type BudgetTransaction = Pick<
  Transaction,
  "type" | "amount" | "category_id" | "vault_id" | "date"
> &
  Partial<Pick<Transaction, "transfer_direction">> & {
    id?: number;
    group_id?: string | null;
  };

export interface ExpenseCandidate {
  amount: number;
  date: string;
  category_id: string | null;
  vault_id: string | null;
  type?: "expense" | "transfer";
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

export interface ReallocationTotals {
  reallocatedIn: number;
  reallocatedOut: number;
}

/** Baris `budget_borrows` -- hanya kolom yang dibutuhkan perhitungan. */
export type BudgetBorrowRow = Pick<BudgetBorrow, "from_budget_id" | "to_budget_id" | "amount">;

export type BudgetReallocationRow = Pick<
  BudgetReallocation,
  "from_budget_id" | "to_budget_id" | "amount" | "reversed_at"
>;

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

export function aggregateReallocations(
  reallocations: readonly BudgetReallocationRow[]
): Map<string, ReallocationTotals> {
  const totals = new Map<string, ReallocationTotals>();
  for (const row of reallocations) {
    if (row.reversed_at) continue;
    const from = totals.get(row.from_budget_id) ?? { reallocatedIn: 0, reallocatedOut: 0 };
    from.reallocatedOut += row.amount;
    totals.set(row.from_budget_id, from);
    const to = totals.get(row.to_budget_id) ?? { reallocatedIn: 0, reallocatedOut: 0 };
    to.reallocatedIn += row.amount;
    totals.set(row.to_budget_id, to);
  }
  return totals;
}

/**
 * Batas efektif sebuah anggaran.
 *
 * Pinjaman tidak mengubah `limit_amount` -- angka rencana yang dilihat
 * pemakai tetap apa adanya. Yang bergeser hanya kapasitas belanja baris
 * periode ini: limit awal + pinjaman masuk - pinjaman keluar + alokasi masuk -
 * alokasi keluar.
 *
 * `leftover_discarded` mencabut sisa anggaran: batas efektif turun ke angka yang
 * sudah terpakai, sehingga statusnya menjadi "penuh" dan pengeluaran baru dianggap
 * melebihi batas. Uangnya memang sudah dipindahkan lewat aksi transfer terpisah —
 * transfer keluar berkategori tetap memakai anggaran kategori, tetapi tidak
 * dihitung pada anggaran vault (lihat `budgetSpend`).
 *
 * Untuk anggaran yang belum ada terpakai sama sekali hasilnya 0: seluruh kuota
 * sudah dialihkan, tidak ada yang boleh dibelanjakan lagi. Angka yang sudah
 * kelewat batas tidak ditarik mundur, jadi batas efektif tidak pernah lebih besar
 * dari `limit_amount` maupun dari `spent` saat sisa ditutup.
 */
export function budgetEffectiveLimit(
  budget: Pick<Budget, "limit_amount"> & Partial<Pick<Budget, "leftover_discarded">>,
  spent: number,
  borrows?: BorrowTotals,
  reallocations?: ReallocationTotals
): number {
  const base = Math.max(
    0,
    budget.limit_amount +
      (borrows?.borrowedIn ?? 0) -
      (borrows?.borrowedOut ?? 0) +
      (reallocations?.reallocatedIn ?? 0) -
      (reallocations?.reallocatedOut ?? 0)
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
  linkedTotal: number,
  reallocations?: ReallocationTotals
): number {
  return Math.max(
    0,
    spent - budgetEffectiveLimit(budget, spent, borrows, reallocations) + linkedTotal
  );
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
  borrows?: ReadonlyMap<string, BorrowTotals>,
  excludeGroupId?: string | null,
  reallocations?: ReadonlyMap<string, ReallocationTotals>
): BudgetConflict | null {
  const amount = Number(candidate.amount);
  if (!Number.isFinite(amount) || amount <= 0) return null;

  let worst: BudgetConflict | null = null;

  for (const budget of budgets) {
    if (candidate.date < budget.starts_on || candidate.date > budget.ends_on) continue;
    if (candidate.type === "transfer" && budget.scope !== "category") continue;

    const matchesScope =
      budget.scope === "category"
        ? candidate.category_id === budget.scope_id
        : candidate.vault_id === budget.scope_id;
    if (!matchesScope) continue;

    const spent = budgetSpend(
      transactions.filter(
        (tx) =>
          (excludeTransactionId === undefined || tx.id !== excludeTransactionId) &&
          (excludeGroupId == null || tx.group_id !== excludeGroupId)
      ),
      budget
    );
    const effectiveLimit = budgetEffectiveLimit(
      budget,
      spent,
      borrows?.get(budget.id),
      reallocations?.get(budget.id)
    );
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
  date: string,
  reallocations: readonly BudgetReallocationRow[] = []
): BorrowLenderCandidate[] {
  if (borrower.leftover_discarded) return [];
  const totals = aggregateBorrows(borrows);
  const reallocationTotals = aggregateReallocations(reallocations);
  const candidates: BorrowLenderCandidate[] = [];
  for (const budget of budgets) {
    if (budget.id === borrower.id) continue;
    if (date < budget.starts_on || date > budget.ends_on) continue;
    if (budget.leftover_discarded) continue;
    const spent = budgetSpend(transactions, budget);
    const remaining = budgetLeftover(
      budgetEffectiveLimit(
        budget,
        spent,
        totals.get(budget.id),
        reallocationTotals.get(budget.id)
      ),
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
  borrows?: BorrowTotals,
  reallocations?: ReallocationTotals
): BudgetStatus {
  if (budget.leftover_discarded) return "full";
  return budgetStatus(
    spent,
    budgetEffectiveLimit(budget, spent, borrows, reallocations),
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

/**
 * Rentang gabungan seluruh periode anggaran yang sedang aktif hari ini.
 *
 * Dipakai sebagai periode hitung kontainer "tanpa batas" supaya angka
 * terpakainya sejalan dengan sisa yang ditampilkan anggaran berbatas di
 * atasnya. Bila beberapa anggaran aktif memakai rentang berbeda (siklus
 * gaji per kategori tidak seragam), hasilnya adalah cakupan terluas --
 * satu transaksi hanya dihitung sekali walau jatuh di tumpang tindih.
 *
 * `null` saat tidak ada satu pun anggaran aktif; pemanggil yang memutuskan
 * fallback-nya (misalnya bulan kalender berjalan).
 */
export function activePeriodRange(
  budgets: readonly Pick<Budget, "starts_on" | "ends_on">[],
  today: string = todayISO()
): BudgetPeriod | null {
  let startsOn: string | null = null;
  let endsOn: string | null = null;
  for (const budget of budgets) {
    if (budgetState(budget, today) !== "active") continue;
    if (startsOn === null || budget.starts_on < startsOn) startsOn = budget.starts_on;
    if (endsOn === null || budget.ends_on > endsOn) endsOn = budget.ends_on;
  }
  return startsOn === null || endsOn === null ? null : { startsOn, endsOn };
}

/**
 * Anggaran periode sebelumnya untuk scope yang sama.
 *
 * Dasar baris perbandingan di kartu riwayat: "periode lalu terpakai berapa".
 * Kandidat harus berbagi `scope` + `scope_id` dan sudah *berakhir sebelum*
 * periode ini dimulai (`ends_on < starts_on`), sehingga periode yang
 * tumpang-tindih atau masih berjalan tidak pernah terpilih. Yang terdekat
 * (`ends_on` terbesar) yang menang -- bukan yang terbaru secara mutlak --
 * supaya satu periode kosong di tengah tidak melompati pembanding terdekat.
 *
 * `null` bila belum ada periode sebelumnya (scope baru atau baru satu
 * periode); pemanggil menyembunyikan baris perbandingannya.
 */
export function findPreviousPeriodBudget<
  T extends Pick<Budget, "scope" | "scope_id" | "starts_on" | "ends_on">
>(budgets: readonly T[], current: T): T | null {
  let previous: T | null = null;
  for (const budget of budgets) {
    if (budget.scope !== current.scope || budget.scope_id !== current.scope_id) continue;
    if (budget.ends_on >= current.starts_on) continue;
    if (!previous || budget.ends_on > previous.ends_on) previous = budget;
  }
  return previous;
}

export interface UnlimitedCategorySpend {
  categoryId: string;
  spent: number;
}

/**
 * Pengeluaran per kategori expense yang tidak punya anggaran pada `period`.
 *
 * Untuk periode aktif, `categoryBudgets` berisi anggaran kategori yang sedang
 * aktif; untuk riwayat periode lewat, memakai `budgetsOverlappingPeriod` --
 * yang penting hanya cakupan scope: kategori yang tercakup anggaran mana pun
 * di periode itu dianggap berbatas.
 *
 * Kontainer "tanpa batas" dihitung, bukan disimpan: kategori bertransaksi
 * pada periode muncul sendiri tanpa baris `budgets`, dan guard pengeluaran
 * memang sudah mengizinkan kategori tanpa anggaran. Kategori yang terlihat
 * saja yang diproses -- daftar `categoryIds` datang dari state yang sudah
 * menyaring baris hidden, supaya kategori yang disembunyikan pengguna tidak
 * muncul kembali lewat pintu belakang.
 *
 * `spent` memakai `budgetSpend` dengan scope kategori, jadi aturannya sama
 * dengan anggaran berbatas: expense dihitung penuh dan transfer ber-kategori
 * menghitung leg keluar satu kali. Baris dengan pemakaian nol gugur -- kartu
 * tanpa batas hanya memuat kategori yang benar-benar bertransaksi pada
 * periode. Hasil diurutkan pemakaian menurun supaya kategori paling besar
 * terlihat lebih dulu tanpa pengurutan ulang di UI.
 */
export function unlimitedCategorySpends(
  transactions: readonly BudgetTransaction[],
  categoryIds: readonly string[],
  categoryBudgets: readonly Pick<Budget, "scope" | "scope_id">[],
  period: BudgetPeriod
): UnlimitedCategorySpend[] {
  const limited = new Set(
    categoryBudgets
      .filter((budget) => budget.scope === "category")
      .map((budget) => budget.scope_id)
  );
  const rows: UnlimitedCategorySpend[] = [];
  for (const categoryId of categoryIds) {
    if (limited.has(categoryId)) continue;
    const spent = budgetSpend(transactions, {
      scope: "category",
      scope_id: categoryId,
      starts_on: period.startsOn,
      ends_on: period.endsOn,
    });
    if (spent <= 0) continue;
    rows.push({ categoryId, spent });
  }
  rows.sort((a, b) => b.spent - a.spent);
  return rows;
}

/**
 * Anggaran yang tanggalnya tumpang-tindih dengan `period` (inklusif di
 * kedua tepi). Dipakai riwayat "Tanpa Batas" per periode lewat: kategori
 * dianggap berbatas selama periode itu bila ada anggaran kategori yang
 * membentang melintasinya -- termasuk anggaran panjang (mis. tahunan) yang
 * dimulai jauh sebelum periode dan berakhir sesudahnya.
 *
 * Scope vault ikut tersaring keluar; `unlimitedCategorySpends` memang hanya
 * membaca anggaran kategori.
 */
export function budgetsOverlappingPeriod<
  T extends Pick<Budget, "scope" | "starts_on" | "ends_on">
>(budgets: readonly T[], period: BudgetPeriod): T[] {
  return budgets.filter(
    (budget) =>
      budget.scope === "category" &&
      budget.starts_on <= period.endsOn &&
      budget.ends_on >= period.startsOn
  );
}
