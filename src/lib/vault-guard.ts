import type { SupabaseClient } from "@supabase/supabase-js";
import type { PairTransaction } from "@/src/lib/sources";
import { computeVaultShortfall, type VaultShortfallPayload } from "@/src/lib/vault-borrow";

/**
 * Melengkapi penolakan guard dana vault dengan `vaultShortfall`.
 *
 * Guard (`transactions.insufficient` dari cek saldo, `transactions.sourceNotInVault`
 * dari cek kolam) hanya mengembalikan kode error; payload ini dihitung terpisah
 * dari ledger terkini sehingga UI tahu *berapa* yang kurang dan vault mana yang
 * kurang -- dasar untuk menawarkan pinjaman antar vault.
 *
 * Mengembalikan `null` kalau tidak ada vault/sumber (penolakannya bukan soal
 * dana, jadi tidak ada yang bisa dipinjam), ledger gagal dibaca (pesan error
 * biasa lebih aman daripada angka salah), atau ternyata tidak kurang.
 */
export async function loadVaultShortfall(
  supabase: SupabaseClient,
  userId: string,
  input: {
    vaultId: string | null;
    fundingSourceId: string | null;
    amount: number;
    /**
     * Baris yang sedang diedit dikeluarkan dari perhitungan: guard RPC menilai
     * terhadap ledger *tanpa* baris lama, supaya angka yang ditawarkan sama
     * dengan yang akan divalidasi ulang saat simpan diulang.
     */
    excludeTransactionId?: number;
  }
): Promise<VaultShortfallPayload | null> {
  if (!input.vaultId || !input.fundingSourceId) return null;

  const { data, error } = await supabase
    .from("transactions")
    .select("id, type, amount, category_id, funding_source_id, vault_id, transfer_direction")
    .eq("user_id", userId);
  if (error) {
    console.error("Supabase ledger load failed during vault shortfall.", error);
    return null;
  }

  const rows = ((data ?? []) as Array<PairTransaction & { id: number }>).filter(
    (row) => row.id !== input.excludeTransactionId
  );
  const shortfall = computeVaultShortfall(rows, {
    vaultId: input.vaultId,
    sourceId: input.fundingSourceId,
    amount: input.amount,
  });
  return shortfall > 0 ? { vaultId: input.vaultId, shortfall } : null;
}
