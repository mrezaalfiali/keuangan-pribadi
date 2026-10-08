import type { Budget, BudgetScope, Transaction } from "./types";
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
  transactions: Pick<Transaction, "type" | "amount" | "category_id" | "vault_id" | "date">[],
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

export type BudgetStatus = "ok" | "warning" | "exceeded";

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
  if (spent >= limit * threshold) return "warning";
  return "ok";
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
