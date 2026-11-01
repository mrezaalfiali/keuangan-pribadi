import type { TxType } from "./types";

export type TransferDirection = "out" | "in" | null;

export function vaultBalanceDelta(
  type: TxType,
  amount: number,
  transferDirection: TransferDirection | undefined = null
): number {
  if (type === "expense" || (type === "transfer" && transferDirection === "out")) {
    return -amount;
  }
  return amount;
}

export type ExpenseVaultError =
  | "transactions.expenseVaultRequired"
  | "transactions.lockedError"
  | "transactions.insufficient";

/**
 * Kode error untuk pengeluaran yang tidak boleh keluar dari vault-nya, atau
 * `null` kalau sah. Dipakai bersama aksi server dan RPC supaya aturan yang
 * sama berlaku di jalur manual maupun berulang.
 *
 * `vault` bernilai `null` saat tidak ada vault yang dipilih atau vault itu
 * tidak ditemukan: keduanya sama-sama berarti pengeluaran tak punya sumber
 * dana yang jelas, jadi ditolak dengan pesan yang sama.
 */
export function expenseVaultError(
  vault: { is_locked: boolean; balance: number } | null,
  amount: number
): ExpenseVaultError | null {
  if (!vault) return "transactions.expenseVaultRequired";
  if (vault.is_locked) return "transactions.lockedError";
  if (vault.balance < amount) return "transactions.insufficient";
  return null;
}

/**
 * Guard kunci vault untuk jalur edit pemasukan.
 *
 * Invarian: saldo vault terkunci hanya boleh bertambah, tidak pernah
 * berkurang. Edit ditolak (lockedError) bila vault lamanya terkunci DAN
 * uangnya keluar — pindah vault (tujuan berbeda, termasuk dikosongkan)
 * atau penurunan nominal. Ubah catatan/tanggal/kategori dan kenaikan
 * nominal tetap diizinkan; `""` dan `null` sama-sama "tanpa vault".
 *
 * Hanya untuk pemasukan: expense dijalankan lewat guard terpisah di RPC
 * (target harus vault tidak terkunci) dan tidak memakai fungsi ini.
 */
export function incomeLockedVaultError(input: {
  oldVaultId: string | null;
  oldVaultLocked: boolean;
  newVaultId: string | null;
  oldAmount: number;
  newAmount: number;
}): "transactions.lockedError" | null {
  if (!input.oldVaultLocked) return null;
  const oldVault = input.oldVaultId || null;
  const newVault = input.newVaultId || null;
  if (newVault !== oldVault || input.newAmount < input.oldAmount) {
    return "transactions.lockedError";
  }
  return null;
}

/**
 * Guard kunci vault untuk jalur hapus baris transaksi.
 *
 * Menghapus baris membuat saldo vault terkunci berkurang hanya kalau baris
 * itu terhitung uang masuk: income, atau transfer masuk (transfer lawas
 * tanpa arah ikut terhitung masuk — mengikuti `vaultBalanceDelta`).
 * Expense dan transfer-keluar boleh dihapus: efeknya saldo naik, bukan
 * berkurang. `rows` mewakili semua baris yang akan terhapus (satu baris
 * atau seluruh baris dalam satu group).
 */
export function deleteReducesLockedVaultError(
  rows: Array<{ type: TxType; vault_id: string | null; transfer_direction?: TransferDirection }>,
  lockedVaultIds: Iterable<string>
): "transactions.lockedError" | null {
  const locked = new Set(lockedVaultIds);
  for (const row of rows) {
    const countsAsIncoming =
      row.type === "income" ||
      (row.type === "transfer" && row.transfer_direction !== "out");
    if (!countsAsIncoming || !row.vault_id) continue;
    if (locked.has(row.vault_id)) return "transactions.lockedError";
  }
  return null;
}
