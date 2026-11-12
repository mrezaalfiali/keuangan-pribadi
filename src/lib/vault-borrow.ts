/**
 * Pinjaman uang antar vault (tabel `vault_borrows`, migrasi 0030).
 *
 * Berbeda dengan pinjaman anggaran -- yang hanya meminjam *izin* plafon tanpa
 * menyentuh uang -- pinjaman vault memindahkan uang nyata lewat transfer
 * internal, sehingga saldo dan kolam (sumber × vault) kedua vault benar-benar
 * berpindah. Utang yang belum dicatat di `vault_borrows.outstanding` dan
 * dilunasi lewat transfer balik, boleh bertahap.
 *
 * Semua fungsi di sini murni: menghitung dari ledger yang sudah diambil
 * pemanggil, tanpa menyentuh Supabase. Guard server mengulang perhitungan yang
 * sama dengan data yang sama -- angka UI tidak pernah dipercaya.
 */

import { computeSourceVaultBalances, sourceVaultBalance, type PairTransaction } from "./sources";
import { vaultBalanceDelta } from "./vault-ledger";
import type { Vault } from "./types";

/** Satu baris `vault_borrows`. */
export interface VaultBorrowRow {
  id: string;
  user_id: string;
  /** Vault pemberi pinjaman (uang keluar dari sini). */
  from_vault_id: string;
  /** Vault peminjam (uang masuk ke sini, wajib mengembalikan). */
  to_vault_id: string;
  funding_source_id: string | null;
  amount: number;
  outstanding: number;
  status: "open" | "repaid";
  /** Baris transfer keluar yang dibuat saat meminjam; null setelah dihapus. */
  transfer_out_id: number | null;
  created_at: string;
}

/** Kekurangan dana yang menutup satu pengeluaran; dasar nominal pinjaman. */
export interface VaultShortfallPayload {
  /** Vault tempat pengeluaran ditolak; UI memakainya sebagai peminjam. */
  vaultId: string;
  /** Berapa yang kurang setelah `min(saldo, kolam)` dipakai. */
  shortfall: number;
}

/** Saldo sebuah vault dari ledger: income/transfer-in plus, sisanya minus. */
export function vaultBalance(
  vaultId: string,
  transactions: readonly PairTransaction[]
): number {
  let total = 0;
  for (const tx of transactions) {
    if (tx.vault_id !== vaultId) continue;
    total += vaultBalanceDelta(tx.type, tx.amount, tx.transfer_direction);
  }
  return total;
}

/**
 * Kekurangan sebuah pengeluaran terhadap satu vault.
 *
 * Uang hanya benar-benar tersedia kalau *kedua* guard lolos: saldo vault
 * mencukupi DAN kolam (sumber, vault) mencukupi. Rumus `amount - min(saldo,
 * kolam)` memberi satu angka untuk dua penolakan guard
 * (`transactions.insufficient` saat saldonya kurang,
 * `transactions.sourceNotInVault` saat kolamnya kurang), sehingga UI cukup
 * memakai satu payload untuk menawarkan pinjaman.
 */
export function vaultShortfall(input: {
  amount: number;
  balance: number;
  pool: number;
}): number {
  return Math.max(0, input.amount - Math.min(input.balance, input.pool));
}

/** Versi yang membaca ledger sekali jalan -- dipakai guard server. */
export function computeVaultShortfall(
  transactions: readonly PairTransaction[],
  input: { vaultId: string; sourceId: string | null; amount: number }
): number {
  if (!input.sourceId) return 0;
  const pools = computeSourceVaultBalances(transactions as PairTransaction[]);
  return vaultShortfall({
    amount: input.amount,
    balance: vaultBalance(input.vaultId, transactions),
    pool: sourceVaultBalance(pools, input.sourceId, input.vaultId),
  });
}

export interface VaultBorrowLenderCandidate {
  vault: Pick<Vault, "id" | "slug" | "name" | "name_key" | "is_locked">;
  /** Maksimal yang bisa dipinjam dari vault ini untuk sumber dana ini. */
  capacity: number;
}

/**
 * Daftar vault yang boleh dipinjami untuk menutup kekurangan sebuah expense.
 *
 * Syaratnya sama dengan keputusan server di `borrowVault`: bukan vault
 * peminjamnya sendiri, tidak terkunci (invarian: saldo vault terkunci hanya
 * boleh bertambah), dan `min(saldo, kolam sumber)`-nya masih positif --
 * pemberi harus sanggup mengirim uang lewat transfer yang memakai sumber dana
 * yang sama dengan expense, bukan sekadar punya saldo.
 *
 * Urutan mengikuti urutan `vaults` yang diberikan (sudah terurut label di
 * kedua halaman); kandidat dengan kapasitas sebagian tetap ditawarkan, sama
 * seperti pinjaman anggaran yang boleh diambil bertahap sampai muat.
 */
export function eligibleVaultLenders(input: {
  borrowerVaultId: string;
  sourceId: string | null;
  vaults: readonly Pick<Vault, "id" | "slug" | "name" | "name_key" | "is_locked">[];
  transactions: readonly PairTransaction[];
}): VaultBorrowLenderCandidate[] {
  if (!input.sourceId) return [];
  const pools = computeSourceVaultBalances(input.transactions as PairTransaction[]);
  const candidates: VaultBorrowLenderCandidate[] = [];
  for (const vault of input.vaults) {
    if (vault.id === input.borrowerVaultId) continue;
    if (vault.is_locked) continue;
    const capacity = Math.min(
      vaultBalance(vault.id, input.transactions),
      sourceVaultBalance(pools, input.sourceId, vault.id)
    );
    if (capacity <= 0) continue;
    candidates.push({ vault, capacity });
  }
  return candidates;
}

/**
 * Memilih sumber dana untuk transfer pembayaran utang.
 *
 * Pembayaran dinilai hanya terhadap saldo vault peminjam -- uang yang harus
 * dikembalikan adalah uang, bukan milik satu sumber tertentu -- jadi sumber
 * dipilih secara otomatis, bukan diminta ke pemakai:
 *
 * 1. Sumber asli pinjaman diprioritaskan selama kolamnya sanggup menutup
 *    nominal penuh (mengembalikan uang ke "kantong" semula).
 * 2. Kalau tidak, sumber mana pun yang kolamnya sanggup, yang terbesar dulu.
 * 3. Kalau tidak ada yang sanggup (peminjam sudah membelanjakan uangnya),
 *    kolam yang terbesar tetap dipakai agar kolam yang jadi negatif sekecil
 *    mungkin. Kolam negatif hanya membuat sumber itu lebih ketat untuk
 *    pengeluaran berikutnya di vault itu -- saldo dan total per sumber tidak
 *    berubah, dan uang tidak pernah tercipta dari transfer.
 *
 * Mengembalikan `null` kalau tidak ada satu pun sumber pemasukan yang sah.
 */
export function pickRepaySource(input: {
  borrowerVaultId: string;
  storedSourceId: string | null;
  validSourceIds: readonly string[];
  transactions: readonly PairTransaction[];
  amount: number;
}): string | null {
  if (input.validSourceIds.length === 0) return null;
  const pools = computeSourceVaultBalances(input.transactions as PairTransaction[]);
  const poolOf = (sourceId: string) =>
    sourceVaultBalance(pools, sourceId, input.borrowerVaultId);

  // Sumber asli dulu saat membandingkan, supaya seri dimenangkan olehnya.
  const ordered = [
    ...(input.storedSourceId && input.validSourceIds.includes(input.storedSourceId)
      ? [input.storedSourceId]
      : []),
    ...input.validSourceIds.filter((id) => id !== input.storedSourceId),
  ];

  // Terbesar menang di antara yang sanggup; kalau tak ada yang sanggup,
  // kolam terbesar tetap yang dipakai agar negatifnya sekecil mungkin.
  // `ordered` menaruh sumber asli lebih dulu, jadi seri dimenangkan olehnya.
  let best = ordered[0];
  let bestPool = poolOf(best);
  for (const sourceId of ordered) {
    const pool = poolOf(sourceId);
    if (sourceId === input.storedSourceId && pool >= input.amount) {
      return sourceId;
    }
    if (pool > bestPool) {
      best = sourceId;
      bestPool = pool;
    }
  }
  return best;
}
