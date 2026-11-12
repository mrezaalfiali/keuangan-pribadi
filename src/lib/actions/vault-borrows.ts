"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/src/lib/supabase/server";
import {
  computeSourceVaultBalances,
  sourceVaultBalance,
  type PairTransaction,
} from "@/src/lib/sources";
import { pickRepaySource, vaultBalance } from "@/src/lib/vault-borrow";

export interface VaultBorrowActionResult {
  ok: boolean;
  error?: string;
  /** Id baris `vault_borrows` yang baru dibuat; dipakai UI untuk baris optimistis. */
  borrowId?: string;
}

function isUUID(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

/**
 * Ledger lengkap satu pengguna untuk perhitungan saldo vault dan kolam
 * (sumber × vault). Guard menghitung ulang dari sini -- angka UI tidak
 * pernah dipercaya.
 */
async function loadLedger(
  supabase: Awaited<ReturnType<typeof createClient>>,
  userId: string
): Promise<PairTransaction[] | null> {
  const { data, error } = await supabase
    .from("transactions")
    .select("type, amount, category_id, funding_source_id, vault_id, transfer_direction")
    .eq("user_id", userId);
  if (error) {
    console.error("Supabase ledger load failed during vault borrow.", error);
    return null;
  }
  return (data ?? []) as PairTransaction[];
}

/** Memindahkan poin ke dompet setelah ledger berubah; gagal tidak membatalkan aksi. */
async function awardRewards(
  supabase: Awaited<ReturnType<typeof createClient>>
): Promise<void> {
  const { error } = await supabase.rpc("award_transaction_rewards");
  if (error) {
    console.error("Supabase transaction reward update failed.", {
      code: error.code,
      message: error.message,
    });
  }
}

/**
 * Meminjam uang dari satu vault ke vault lain untuk menutup pengeluaran yang
 * ditolak guard dana.
 *
 * Uang benar-benar berpindah lewat transfer internal (2 baris dalam satu
 * group, memakai sumber dana expense yang sama, jadi kolam kedua vault ikut
 * berpindah dan kedua guard -- saldo vault maupun kolam sumber -- terpenuhi
 * setelahnya). Utangnya dicatat di `vault_borrows` dan dilunasi manual lewat
 * `repayVaultBorrow`; menghapus transaksi yang memicunya TIDAK menghapus utang.
 *
 * Semua syarat divalidasi ulang di server: pemberi harus tidak terkunci dan
 * `min(saldo, kolam)`-nya sanggup menutup nominal yang dipinta. UI hanya
 * memilih vault dan menampilkan batasnya.
 */
export async function borrowVault(
  locale: string,
  input: {
    borrowerVaultId: string;
    lenderVaultId: string;
    fundingSourceId: string;
    amount: number;
  }
): Promise<VaultBorrowActionResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "err.auth" };

  if (
    !Number.isSafeInteger(input.amount) ||
    !Number.isFinite(input.amount) ||
    input.amount <= 0
  ) {
    return { ok: false, error: "err.vaultBorrowAmount" };
  }
  if (
    !isUUID(input.borrowerVaultId) ||
    !isUUID(input.lenderVaultId) ||
    !isUUID(input.fundingSourceId)
  ) {
    return { ok: false, error: "err.vaultBorrowNotFound" };
  }
  if (input.borrowerVaultId === input.lenderVaultId) {
    return { ok: false, error: "err.vaultBorrowSame" };
  }
  const amount = Math.trunc(input.amount);

  // Transfer memakai sumber dana expense, jadi sumbernya wajib kategori
  // pemasukan milik pengguna (atau baris katalog bersama).
  const { data: source, error: sourceError } = await supabase
    .from("categories")
    .select("id, type")
    .eq("id", input.fundingSourceId)
    .or(`user_id.is.null,user_id.eq.${user.id}`)
    .maybeSingle();
  if (sourceError) return { ok: false, error: "err.generic" };
  if (!source || source.type !== "income") {
    return { ok: false, error: "transactions.noSource" };
  }

  const { data: vaults, error: vaultError } = await supabase
    .from("vaults")
    .select("id, name, name_key, is_locked")
    .eq("user_id", user.id)
    .in("id", [input.borrowerVaultId, input.lenderVaultId]);
  if (vaultError) return { ok: false, error: "err.generic" };
  const lender = (vaults ?? []).find((row) => row.id === input.lenderVaultId);
  const borrower = (vaults ?? []).find((row) => row.id === input.borrowerVaultId);
  if (!lender || !borrower) return { ok: false, error: "err.vaultBorrowNotFound" };
  // Invarian: saldo vault terkunci hanya boleh bertambah, jadi uang tidak
  // boleh keluar darinya -- termasuk untuk dipinjamkan.
  if (lender.is_locked) return { ok: false, error: "transactions.lockedError" };

  const ledger = await loadLedger(supabase, user.id);
  if (!ledger) return { ok: false, error: "err.generic" };
  const pools = computeSourceVaultBalances(ledger);
  // Pemberi harus sanggup di dua sisi sekaligus: saldonya cukup DAN kolam
  // (sumber, pemberi) cukup. Tanpa syarat kedua, transfernya sendiri pasti
  // ditolak guard transfer, jadi pinjaman semacam ini tidak boleh ditawarkan.
  if (vaultBalance(input.lenderVaultId, ledger) < amount) {
    return { ok: false, error: "err.vaultLenderBalance" };
  }
  if (sourceVaultBalance(pools, input.fundingSourceId, input.lenderVaultId) < amount) {
    return { ok: false, error: "err.vaultLenderPool" };
  }

  const lenderName = lender.name || lender.name_key || "";
  const note =
    locale === "id"
      ? lenderName
        ? `Pinjam dari ${lenderName}`
        : "Pinjam dari vault lain"
      : lenderName
        ? `Borrowed from ${lenderName}`
        : "Borrowed from another vault";

  const date = new Date().toISOString().slice(0, 10);
  const groupId = crypto.randomUUID();
  const { data: inserted, error: transferError } = await supabase
    .from("transactions")
    .insert([
      {
        user_id: user.id,
        type: "transfer",
        transfer_direction: "out",
        group_id: groupId,
        amount,
        date,
        vault_id: input.lenderVaultId,
        funding_source_id: input.fundingSourceId,
        note,
      },
      {
        user_id: user.id,
        type: "transfer",
        transfer_direction: "in",
        group_id: groupId,
        amount,
        date,
        vault_id: input.borrowerVaultId,
        funding_source_id: input.fundingSourceId,
        note,
      },
    ])
    .select("id, transfer_direction");
  if (transferError) {
    console.error("Supabase vault borrow transfer insert failed.", transferError);
    return { ok: false, error: "err.generic" };
  }
  const transferOutId = (inserted ?? []).find(
    (row) => row.transfer_direction === "out"
  )?.id;
  if (!transferOutId) {
    console.error("Supabase vault borrow transfer insert returned no out-row.");
    return { ok: false, error: "err.generic" };
  }

  const { data: borrowRow, error: borrowError } = await supabase
    .from("vault_borrows")
    .insert({
      user_id: user.id,
      from_vault_id: input.lenderVaultId,
      to_vault_id: input.borrowerVaultId,
      funding_source_id: input.fundingSourceId,
      amount,
      outstanding: amount,
      status: "open",
      transfer_out_id: transferOutId,
    })
    .select("id")
    .single();
  if (borrowError || !borrowRow) {
    if (borrowError) console.error("Supabase vault borrow insert failed.", borrowError);
    // Transfer sudah terlanjur masuk tanpa catatan utangnya: hapus kembali
    // grupnya supaya tidak ada uang berpindah tanpa jejak pinjaman.
    const { error: cleanupError } = await supabase
      .from("transactions")
      .delete()
      .eq("user_id", user.id)
      .eq("group_id", groupId);
    if (cleanupError) {
      console.error("Supabase vault borrow transfer cleanup failed.", cleanupError);
    }
    return { ok: false, error: "err.generic" };
  }

  await awardRewards(supabase);
  revalidatePath(`/${locale}/dashboard`);
  revalidatePath(`/${locale}/transactions`);
  revalidatePath(`/${locale}/vaults`);
  return { ok: true, borrowId: borrowRow.id };
}

/**
 * Membayar sebagian atau seluruh utang pinjaman antar vault.
 *
 * Uang keluar dari vault peminjam (`to_vault_id`) kembali ke vault pemberi
 * lewat transfer, dan `outstanding` berkurang -- boleh bertahap, yang penting
 * tidak melebihi sisa utang. Syarat pembayarannya sengaja hanya SALDO VAULT:
 * uang yang dikembalikan adalah uang, bukan milik satu sumber tertentu, jadi
 * sumber transfernya dipilih otomatis oleh `pickRepaySource`.
 *
 * Pembaruan baris utang dilakukan lebih dulu dengan syarat nilainya masih
 * sama seperti yang terbaca (anti-lomba klik); kalau berubah di tengah jalan,
 * aksi batal sebelum transfer tercatat. Kegagalan transfer membatalkan
 * pembaruan supaya utang tidak pernah terlihat lunas tanpa uang berpindah.
 */
export async function repayVaultBorrow(
  locale: string,
  borrowId: string,
  amount: number
): Promise<VaultBorrowActionResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "err.auth" };

  if (!Number.isSafeInteger(amount) || !Number.isFinite(amount) || amount <= 0) {
    return { ok: false, error: "err.vaultRepayAmount" };
  }
  const pay = Math.trunc(amount);

  const { data: borrow, error: borrowError } = await supabase
    .from("vault_borrows")
    .select("id, from_vault_id, to_vault_id, funding_source_id, amount, outstanding, status")
    .eq("id", borrowId)
    .eq("user_id", user.id)
    .maybeSingle();
  if (borrowError) return { ok: false, error: "err.generic" };
  if (!borrow || borrow.status !== "open" || borrow.outstanding <= 0) {
    return { ok: false, error: "err.vaultRepayClosed" };
  }
  if (pay > borrow.outstanding) {
    return { ok: false, error: "err.vaultRepayOutstanding" };
  }

  const payerVaultId = borrow.to_vault_id;
  const receiverVaultId = borrow.from_vault_id;
  const { data: vaults, error: vaultError } = await supabase
    .from("vaults")
    .select("id, name, name_key, is_locked")
    .eq("user_id", user.id)
    .in("id", [payerVaultId, receiverVaultId]);
  if (vaultError) return { ok: false, error: "err.generic" };
  const payer = (vaults ?? []).find((row) => row.id === payerVaultId);
  const receiver = (vaults ?? []).find((row) => row.id === receiverVaultId);
  if (!payer || !receiver) return { ok: false, error: "err.generic" };
  // Invarian yang sama seperti pinjam: uang tidak boleh keluar dari vault
  // terkunci. Peminjam wajib membuka kunci dulu sebelum bisa membayar.
  if (payer.is_locked) return { ok: false, error: "transactions.lockedError" };

  const ledger = await loadLedger(supabase, user.id);
  if (!ledger) return { ok: false, error: "err.generic" };
  if (vaultBalance(payerVaultId, ledger) < pay) {
    return { ok: false, error: "err.vaultRepayBalance" };
  }

  const { data: incomeSources, error: sourceListError } = await supabase
    .from("categories")
    .select("id")
    .eq("type", "income")
    .or(`user_id.is.null,user_id.eq.${user.id}`);
  if (sourceListError) return { ok: false, error: "err.generic" };
  const sourceId = pickRepaySource({
    borrowerVaultId: payerVaultId,
    storedSourceId: borrow.funding_source_id,
    validSourceIds: (incomeSources ?? []).map((row) => row.id),
    transactions: ledger,
    amount: pay,
  });
  if (!sourceId) return { ok: false, error: "transactions.noSource" };

  const newOutstanding = borrow.outstanding - pay;
  const { data: updated, error: updateError } = await supabase
    .from("vault_borrows")
    .update({
      outstanding: newOutstanding,
      status: newOutstanding === 0 ? "repaid" : "open",
    })
    .eq("id", borrow.id)
    .eq("user_id", user.id)
    .eq("status", "open")
    .eq("outstanding", borrow.outstanding)
    .select("id");
  if (updateError) return { ok: false, error: "err.generic" };
  if (!updated?.length) {
    // Nilai baris sudah berubah sejak dibaca -- kemungkinan dibayar dari
    // tab lain. Batalkan sebelum transfer tercatat.
    return { ok: false, error: "err.vaultRepayStale" };
  }

  const receiverName = receiver.name || receiver.name_key || "";
  const note =
    locale === "id"
      ? receiverName
        ? `Bayar pinjaman ke ${receiverName}`
        : "Bayar pinjaman"
      : receiverName
        ? `Repay debt to ${receiverName}`
        : "Repay debt";
  const date = new Date().toISOString().slice(0, 10);
  const groupId = crypto.randomUUID();
  const { error: transferError } = await supabase.from("transactions").insert([
    {
      user_id: user.id,
      type: "transfer",
      transfer_direction: "out",
      group_id: groupId,
      amount: pay,
      date,
      vault_id: payerVaultId,
      funding_source_id: sourceId,
      note,
    },
    {
      user_id: user.id,
      type: "transfer",
      transfer_direction: "in",
      group_id: groupId,
      amount: pay,
      date,
      vault_id: receiverVaultId,
      funding_source_id: sourceId,
      note,
    },
  ]);
  if (transferError) {
    console.error("Supabase vault borrow repayment transfer failed.", transferError);
    const { error: revertError } = await supabase
      .from("vault_borrows")
      .update({ outstanding: borrow.outstanding, status: "open" })
      .eq("id", borrow.id)
      .eq("user_id", user.id);
    if (revertError) {
      console.error("Supabase vault borrow repayment revert failed.", revertError);
    }
    return { ok: false, error: "err.generic" };
  }

  await awardRewards(supabase);
  revalidatePath(`/${locale}/dashboard`);
  revalidatePath(`/${locale}/transactions`);
  revalidatePath(`/${locale}/vaults`);
  return { ok: true };
}
