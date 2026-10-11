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
