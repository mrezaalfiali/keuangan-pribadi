"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/src/lib/supabase/server";
import { distributeAllocation, resolveIncomeAllocation, validateSlots, type AllocationMode } from "@/src/lib/allocation";
import { todayISO } from "@/src/lib/utils";
import { deleteReducesLockedVaultError, vaultBalanceDelta, expenseVaultError } from "@/src/lib/vault-ledger";
import { computeSourceVaultBalances, sourceVaultBalance, type PairTransaction } from "@/src/lib/sources";
import {
  aggregateBorrows,
  aggregateReallocations,
  budgetSpend,
  planBorrowShrink,
  requiredBorrowTotal,
  type BudgetBorrowRow,
  type BudgetReallocationRow,
} from "@/src/lib/budget";
import { budgetRejection, checkExpenseBudget } from "@/src/lib/budget-guard";
import { loadVaultShortfall } from "@/src/lib/vault-guard";
import type { VaultShortfallPayload } from "@/src/lib/vault-borrow";
import type { AllocationSlot, Transaction } from "../types";

export interface TxResult {
  ok: boolean;
  error?: string;
  points?: number;
  unlockedAchievements?: Array<{ nameKey: string; points: number }>;
  rewardError?: boolean;
  budget?: {
    scope: "category" | "vault";
    remaining: number;
    /** Baris anggaran yang tertolak; UI memakainya sebagai peminjam. */
    id: string;
    /** Kekurangan setelah sisa dipakai; dasar nominal pinjaman. */
    shortfall: number;
  };
  /** Kekurangan saldo/kolam vault; UI menawarkan pinjaman antar vault. */
  vaultShortfall?: VaultShortfallPayload;
}

function budgetTriggerResult(error: {
  message?: string;
  details?: string | null;
}): TxResult | null {
  const message = error.message;
  if (
    message !== "transactions.budgetExceededCategory" &&
    message !== "transactions.budgetExceededVault"
  ) {
    return null;
  }

  try {
    const detail: unknown = JSON.parse(error.details ?? "");
    if (
      detail !== null &&
      typeof detail === "object" &&
      "budget_id" in detail &&
      typeof detail.budget_id === "string" &&
      "remaining" in detail &&
      typeof detail.remaining === "number" &&
      "projected" in detail &&
      typeof detail.projected === "number" &&
      "effective_limit" in detail &&
      typeof detail.effective_limit === "number"
    ) {
      return {
        ok: false,
        error: message,
        budget: {
          scope: message === "transactions.budgetExceededCategory" ? "category" : "vault",
          id: detail.budget_id,
          remaining: Math.max(0, detail.remaining),
          shortfall: Math.max(0, detail.projected - detail.effective_limit),
        },
      };
    }
  } catch {
    // The error is logged below; do not turn a malformed database response
    // into a success-shaped budget rejection.
  }

  console.error("Budget trigger returned an invalid conflict detail.", {
    message,
    details: error.details,
  });
  return { ok: false, error: "err.generic" };
}

interface RewardPayload {
  points_earned: number;
  unlocked: Array<{ name_key: string; points_reward: number }>;
}

function isRewardPayload(value: unknown): value is RewardPayload {
  if (!value || typeof value !== "object" || !("points_earned" in value) || !("unlocked" in value)) {
    return false;
  }
  return (
    typeof value.points_earned === "number" &&
    Array.isArray(value.unlocked) &&
    value.unlocked.every(
      (item: unknown) =>
        item !== null &&
        typeof item === "object" &&
        "name_key" in item &&
        typeof item.name_key === "string" &&
        "points_reward" in item &&
        typeof item.points_reward === "number"
    )
  );
}

export async function addTransaction(
  locale: string,
  input: {
    type: "income" | "expense" | "transfer";
    amount: number;
    date: string;
    categoryId?: string | null;
    /** Sumber pemasukan yang membayar expense; wajib untuk expense baru. */
    fundingSourceId?: string | null;
    vaultId?: string | null;
    destinationVaultId?: string | null;
    note?: string | null;
    /**
     * Untuk income: `auto` (default) membagi nominal lewat aturan alokasi,
     * `single` mengirim seluruh nominal ke `vaultId`.
     */
    allocationMode?: AllocationMode | null;
  },
  options?: {
    /**
     * Id `budget_borrows` yang menutup kekurangan anggaran transaksi ini.
     * Ditautkan ke baris transaksi setelah insert berhasil supaya menghapus
     * transaksi otomatis mengembalikan sisa pemberi (FK cascade).
     */
    borrowIds?: string[];
  }
): Promise<TxResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "err.auth" };

  const amount = Math.trunc(input.amount);
  if (!amount || amount <= 0) return { ok: false, error: "err.amount" };

  const date = input.date || todayISO();

  // Expense / transfer from a locked vault is blocked.
  if ((input.type === "expense" || input.type === "transfer") && input.vaultId) {
    const { data: vault } = await supabase
      .from("vaults")
      .select("is_locked")
      .eq("id", input.vaultId)
      .single();
    if (vault?.is_locked) return { ok: false, error: "transactions.lockedError" };
  }

  // Build the core row; transfer uses a single row from source vault.
  const base: Partial<Transaction> & { user_id: string } = {
    user_id: user.id,
    type: input.type,
    amount,
    date,
    note: input.note || null,
    vault_id: null,
    category_id: null,
    funding_source_id: null,
    group_id: null,
    transfer_direction: null,
  };

  if (input.type === "income") {
    // Pemasukan tanpa sumber membuat uang muncul di vault tanpa bisa
    // dibelanjakan (tidak ada pool sumber×vault yang bisa dipakai). Kalau
    // pemanggil tidak memilih sumber, pakai sumber sistem "Lainnya".
    const source = await resolveIncomeSourceId(supabase, user.id, input.categoryId ?? null);
    if (!source.ok) return { ok: false, error: source.error };
    // Vault tujuan pemasukan harus milik pengguna; kalau tidak, uangnya akan
    // mendarat di ledger orang lain (RLS menolak, tapi errornya jadi generik).
    if (input.vaultId) {
      const { data: vault, error: vaultError } = await supabase
        .from("vaults")
        .select("id")
        .eq("id", input.vaultId)
        .eq("user_id", user.id)
        .maybeSingle();
      if (vaultError) return { ok: false, error: "err.generic" };
      if (!vault) return { ok: false, error: "transactions.vaultRequired" };
    }
    base.category_id = source.id;
    base.vault_id = input.vaultId ?? null;
  } else if (input.type === "expense") {
    base.category_id = input.categoryId ?? null;
    base.vault_id = input.vaultId ?? null;
    // Uang harus keluar dari vault nyata: wajib dipilih, tidak terkunci, dan
    // saldonya cukup. Tanpa ini, kunci vault bisa dilewati lewat sumber
    // pemasukan, dan saldo vault bisa menjadi negatif.
    const vaultCheck = await checkExpenseVault(supabase, user.id, input.vaultId ?? null, amount);
    if (vaultCheck) {
      // Penolakan soal dana dilengkapi angka kekurangannya supaya UI bisa
      // menawarkan pinjaman antar vault; kunci/vault-hilang tetap polos.
      const vaultShortfall =
        vaultCheck === "transactions.insufficient"
          ? await loadVaultShortfall(supabase, user.id, {
              vaultId: input.vaultId ?? null,
              fundingSourceId: input.fundingSourceId ?? null,
              amount,
            })
          : null;
      return { ok: false, error: vaultCheck, ...(vaultShortfall ? { vaultShortfall } : {}) };
    }
    // Uang dari sebuah sumber hanya boleh keluar dari vault yang benar-benar
    // menyimpannya. Cek agregat sumber saja tidak cukup: dua vault bisa berisi
    // sumber yang sama, dan tanpa cek pasangan ini pengeluaran dari satu vault
    // bisa menghabiskan saldo sumber yang sebenarnya ada di vault lain.
    const check = await checkSourceVaultBalance(
      supabase,
      user.id,
      input.fundingSourceId,
      input.vaultId ?? null,
      amount
    );
    if (!check.ok) {
      if (check.error === "transactions.sourceNotInVault") {
        const vaultShortfall = await loadVaultShortfall(supabase, user.id, {
          vaultId: input.vaultId ?? null,
          fundingSourceId: input.fundingSourceId ?? null,
          amount,
        });
        if (vaultShortfall) return { ok: false, error: check.error, vaultShortfall };
      }
      return check;
    }
    base.funding_source_id = input.fundingSourceId ?? null;

    // Anggaran adalah batas keras: tolak sebelum insert kalau nominal ini akan
    // melewati anggaran kategori atau vault yang mencakup tanggal transaksi.
    const budgetGuard = await checkExpenseBudget(supabase, user.id, {
      amount,
      date,
      category_id: base.category_id ?? null,
      vault_id: base.vault_id ?? null,
    });
    if (!budgetGuard.ok) {
      if ("conflict" in budgetGuard) {
        return { ok: false, ...budgetRejection(budgetGuard.conflict) };
      }
      return { ok: false, error: budgetGuard.error };
    }
  } else {
    // transfer
    base.vault_id = input.vaultId ?? null;
    base.transfer_direction = "out";
    base.category_id = input.categoryId || null;
    // Transfer memindahkan uang milik satu sumber: kolam (sumber × vault asal)
    // ikut berpindah, sehingga baris keluar dan masuk membawa sumber yang sama.
    base.funding_source_id = input.fundingSourceId ?? null;
  }

  // Income either follows the active allocation rule or lands whole in one
  // chosen vault; the caller states which through `allocationMode`. Only new
  // rows are affected — nothing here reads or rewrites income recorded before
  // this ran.
  let applyAllocation = false;
  if (input.type === "income") {
    const mode = resolveIncomeAllocation(input.allocationMode, input.vaultId ?? null);
    if (!mode.ok) return { ok: false, error: "transactions.vaultRequired" };
    applyAllocation = mode.applyAllocation;
  }

  if (input.type === "income" && applyAllocation) {
    const split = await planAllocation(supabase, user.id, amount);
    if (split) {
      const groupId = crypto.randomUUID();
      const { error: splitError } = await supabase.from("transactions").insert(
        split.map((row) => ({ ...base, group_id: groupId, ...row }))
      );
      if (splitError) return { ok: false, error: "err.generic" };
    } else if (base.vault_id) {
      const { error: incomeError } = await supabase.from("transactions").insert(base);
      if (incomeError) return { ok: false, error: "err.generic" };
    } else {
      // Mode "auto" tanpa aturan aktif (atau aturan tidak valid) tidak punya
      // vault tujuan. Menyimpannya dengan vault_id null membuat uang tak bisa
      // dibelanjakan, jadi ditolak dengan pesan yang bisa ditindaklanjuti.
      return { ok: false, error: "transactions.allocationRuleRequired" };
    }
  } else if (input.type === "transfer") {
    const sourceVaultId = input.vaultId;
    const destinationVaultId = input.destinationVaultId;
    if (!input.fundingSourceId) {
      return { ok: false, error: "transactions.noSource" };
    }
    // Kategori transfer bersifat opsional (alasan memindahkan dana), tetapi
    // kalau diisi harus benar-benar ada dan berasal dari daftar pengeluaran.
    if (base.category_id) {
      const { data: category, error: categoryError } = await supabase
        .from("categories")
        .select("id, type")
        .eq("id", base.category_id)
        .or(`user_id.is.null,user_id.eq.${user.id}`)
        .maybeSingle();
      if (categoryError) return { ok: false, error: "err.generic" };
      if (!category || category.type !== "expense") {
        return { ok: false, error: "err.category" };
      }
      base.category_id = category.id;
    }
    if (
      !sourceVaultId ||
      !destinationVaultId ||
      sourceVaultId === destinationVaultId
    ) {
      return { ok: false, error: "err.generic" };
    }
    const { data: vaults, error: vaultError } = await supabase
      .from("vaults")
      .select("id, is_locked")
      .eq("user_id", user.id)
      .in("id", [sourceVaultId, destinationVaultId]);
    if (vaultError || vaults?.length !== 2) {
      return { ok: false, error: "err.generic" };
    }
    if (vaults.find((vault) => vault.id === sourceVaultId)?.is_locked) {
      return { ok: false, error: "transactions.lockedError" };
    }

    // Transfer hanya boleh menarik dari kolam sumber yang benar-benar mengisi
    // vault asal; saldo vault agregat tak cukup karena bisa berisi sumber lain.
    const { data: ledger, error: ledgerError } = await supabase
      .from("transactions")
      .select("type, amount, category_id, funding_source_id, vault_id, transfer_direction")
      .eq("user_id", user.id);
    if (ledgerError) return { ok: false, error: "err.generic" };
    const balances = computeSourceVaultBalances((ledger ?? []) as PairTransaction[]);
    if (sourceVaultBalance(balances, input.fundingSourceId, sourceVaultId) < amount) {
      return { ok: false, error: "transactions.sourceNotInVault" };
    }

    const budgetGuard = await checkExpenseBudget(supabase, user.id, {
      type: "transfer",
      amount,
      date,
      category_id: base.category_id ?? null,
      vault_id: sourceVaultId,
    });
    if (!budgetGuard.ok) {
      if ("conflict" in budgetGuard) {
        return { ok: false, ...budgetRejection(budgetGuard.conflict) };
      }
      return { ok: false, error: budgetGuard.error };
    }

    const groupId = crypto.randomUUID();
    const { data: inserted, error } = await supabase
      .from("transactions")
      .insert([
        { ...base, group_id: groupId },
        {
          ...base,
          vault_id: destinationVaultId,
          transfer_direction: "in",
          group_id: groupId,
        },
      ])
      .select("id, transfer_direction");
    if (error) {
      const budgetResult = budgetTriggerResult(error);
      return budgetResult ?? { ok: false, error: "err.generic" };
    }
    const outgoing = inserted?.find((row) => row.transfer_direction === "out");
    if (options?.borrowIds?.length && outgoing) {
      const { error: linkError } = await supabase
        .from("budget_borrows")
        .update({ transaction_id: outgoing.id })
        .in("id", options.borrowIds)
        .eq("user_id", user.id)
        .is("transaction_id", null);
      if (linkError) console.error("Supabase budget borrow link failed.", linkError);
    }
  } else {
    const { data: inserted, error } = await supabase
      .from("transactions")
      .insert(base)
      .select("id")
      .single();
    if (error) {
      const budgetResult = budgetTriggerResult(error);
      return budgetResult ?? { ok: false, error: "err.generic" };
    }

    // Tautkan pinjaman yang menutup kekurangan anggaran. Gagal menaut
    // tidak membatalkan transaksi yang sudah tersimpan -- pinjaman tetap
    // tercatat dan masih bisa dibatalkan manual dari halaman Anggaran.
    const borrowIds = options?.borrowIds;
    if (input.type === "expense" && borrowIds?.length && inserted) {
      const { error: linkError } = await supabase
        .from("budget_borrows")
        .update({ transaction_id: inserted.id })
        .in("id", borrowIds)
        .eq("user_id", user.id)
        .is("transaction_id", null);
      if (linkError) {
        console.error("Supabase budget borrow link failed.", linkError);
      }
    }
  }

  const { data: rewardData, error: rewardError } = await supabase.rpc(
    "award_transaction_rewards"
  );
  let points = 0;
  let unlockedAchievements: TxResult["unlockedAchievements"] = [];
  let rewardFailed = Boolean(rewardError);
  if (rewardError) {
    console.error("Supabase transaction reward update failed.", {
      code: rewardError.code,
      message: rewardError.message,
    });
  } else if (isRewardPayload(rewardData)) {
    points = rewardData.points_earned;
    unlockedAchievements = rewardData.unlocked.map((item) => ({
      nameKey: item.name_key,
      points: item.points_reward,
    }));
  } else {
    rewardFailed = true;
    console.error("Supabase transaction reward update returned an invalid response.");
  }

  await revalidatePath(`/${locale}/dashboard`);
  await revalidatePath(`/${locale}/transactions`);
  await revalidatePath(`/${locale}/vaults`);
  await revalidatePath(`/${locale}/allocation`);
  await revalidatePath(`/${locale}/budgets`);
  await revalidatePath(`/${locale}/rewards`);

  return {
    ok: true,
    points,
    unlockedAchievements,
    rewardError: rewardFailed,
  };
}

/**
 * Membagi satu income ke beberapa baris sesuai aturan alokasi yang aktif.
 *
 * Mengembalikan `null` kalau tidak ada aturan yang bisa dipakai, supaya
 * pemanggil tetap memakai jalur insert biasa — income harus tetap tercatat
 * meski belum ada aturan, dan kegagalan alokasi tidak boleh membatalkan
 * pencatatan income.
 *
 * Slot bernilai 0 dilewati: bagian yang nol tidak butuh baris sendiri dan
 * membuat daftar transaksi lebih sulit dibaca.
 */
async function planAllocation(
  supabase: Awaited<ReturnType<typeof createClient>>,
  userId: string,
  amount: number
): Promise<Array<{ vault_id: string; amount: number }> | null> {
  const { data: rule } = await supabase
    .from("allocation_rules")
    .select("id")
    .eq("user_id", userId)
    .eq("is_active", true)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!rule) return null;

  const { data: slots } = await supabase
    .from("allocation_slots")
    .select("vault_id, method, value, priority")
    .eq("rule_id", rule.id)
    .order("priority", { ascending: true });
  if (!slots || slots.length === 0) return null;

  const check = validateSlots(slots);
  if (!check.ok) return null;

  const shares = distributeAllocation(
    amount,
    slots as unknown as AllocationSlot[]
  );

  const rows = shares
    .filter((share) => share.amount > 0)
    .map((share) => ({ vault_id: share.slot.vault_id, amount: share.amount }));

  // Tidak ada yang tersisa untuk dialokasikan: biarkan income utuh masuk vault
  // tujuan dari form, bukan menulis baris dengan vault_id sembarang.
  return rows.length > 0 ? rows : null;
}

/**
 * Menolak pengeluaran yang vault-nya tidak sah, atau mengembalikan `null`
 * kalau boleh lanjut.
 *
 * Saldo vault dihitung dari ledger (income/transfer-in menambah, expense/
 * transfer-out mengurangi), sama seperti perhitungan di `vaultTransfer`, supaya
 * angka yang dilihat pengguna sama dengan yang divalidasi server.
 */
async function checkExpenseVault(
  supabase: Awaited<ReturnType<typeof createClient>>,
  userId: string,
  vaultId: string | null,
  amount: number
): Promise<string | null> {
  if (!vaultId) return expenseVaultError(null, amount);

  const { data: vault, error: vaultError } = await supabase
    .from("vaults")
    .select("id, is_locked")
    .eq("id", vaultId)
    .eq("user_id", userId)
    .maybeSingle();
  if (vaultError) return "err.generic";
  if (!vault) return expenseVaultError(null, amount);

  const { data: ledger, error: ledgerError } = await supabase
    .from("transactions")
    .select("type, amount, vault_id, transfer_direction")
    .eq("user_id", userId);
  if (ledgerError) return "err.generic";

  const balance = ((ledger ?? []) as Pick<
    Transaction,
    "type" | "amount" | "vault_id" | "transfer_direction"
  >[]).reduce((sum, tx) => {
    if (tx.vault_id !== vaultId) return sum;
    return sum + vaultBalanceDelta(tx.type, tx.amount, tx.transfer_direction);
  }, 0);

  return expenseVaultError({ is_locked: vault.is_locked, balance }, amount);
}

/**
 * Menentukan sumber pemasukan yang sah untuk sebuah income. Sumber yang
 * dipilih diverifikasi milik pengguna (atau kategori sistem) dan bertipe
 * `income`; kalau kosong, dipakai sumber sistem "Lainnya" supaya income selalu
 * punya pool sumber×vault dan uangnya bisa dibelanjakan kembali.
 */
async function resolveIncomeSourceId(
  supabase: Awaited<ReturnType<typeof createClient>>,
  userId: string,
  categoryId: string | null
): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  if (categoryId) {
    const { data, error } = await supabase
      .from("categories")
      .select("id, type")
      .eq("id", categoryId)
      .or(`user_id.is.null,user_id.eq.${userId}`)
      .maybeSingle();
    if (error) return { ok: false, error: "err.generic" };
    if (!data || data.type !== "income") return { ok: false, error: "err.category" };
    return { ok: true, id: data.id };
  }

  const { data, error } = await supabase
    .from("categories")
    .select("id")
    .eq("type", "income")
    .eq("is_system", true)
    .in("slug", ["lainnya-in", "lainnya"])
    .limit(1)
    .maybeSingle();
  if (error) return { ok: false, error: "err.generic" };
  if (!data) return { ok: false, error: "err.category" };
  return { ok: true, id: data.id };
}

/**
 * Menolak expense yang sumber dananya tidak punya saldo di vault yang dipilih,
 * atau yang menunjuk kategori yang bukan sumber pemasukan milik pengguna.
 *
 * Saldo dihitung dari pasangan (sumber, vault), bukan dari total sumber:
 * uang "Gaji" yang tersimpan di "Tabungan" tidak boleh membiayai pengeluaran
 * dari "Darat" hanya karena total sumbernya terlihat cukup. Income menambah
 * pool `category_id`-nya, expense/transfer mengurangi pool `funding_source_id`,
 * sama seperti `computeSourceVaultBalances` di klien.
 */
async function checkSourceVaultBalance(
  supabase: Awaited<ReturnType<typeof createClient>>,
  userId: string,
  fundingSourceId: string | null | undefined,
  vaultId: string | null,
  amount: number
): Promise<TxResult> {
  if (!fundingSourceId) return { ok: false, error: "transactions.noSource" };

  const { data: source, error: sourceError } = await supabase
    .from("categories")
    .select("id, type, is_system")
    .eq("id", fundingSourceId)
    .or(`user_id.is.null,user_id.eq.${userId}`)
    .single();
  if (sourceError || !source) return { ok: false, error: "transactions.noSource" };
  if (source.type !== "income") return { ok: false, error: "transactions.noSource" };

  if (!vaultId) return { ok: false, error: "transactions.expenseVaultRequired" };

  const { data: rows, error: txError } = await supabase
    .from("transactions")
    .select("type, amount, category_id, funding_source_id, vault_id, transfer_direction")
    .eq("user_id", userId);
  if (txError) return { ok: false, error: "err.generic" };

  const balances = computeSourceVaultBalances(
    (rows ?? []) as PairTransaction[]
  );
  if (sourceVaultBalance(balances, source.id, vaultId) < amount) {
    return { ok: false, error: "transactions.sourceNotInVault" };
  }
  return { ok: true };
}

export async function deleteTransaction(
  locale: string,
  txId: number
): Promise<TxResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "err.auth" };

  const { data: tx, error: txError } = await supabase
    .from("transactions")
    .select("id, user_id, group_id, type, amount, vault_id, transfer_direction")
    .eq("id", txId)
    .eq("user_id", user.id)
    .maybeSingle();
  if (txError || !tx) return { ok: false, error: "err.generic" };

  // Hapus membuat saldo vault terkunci berkurang kalau barisnya terhitung
  // uang masuk (income / transfer masuk). Kumpulkan dulu semua baris yang
  // akan ikut terhapus (satu baris atau satu group split/transfer), lalu
  // tolak seluruhnya bila ada yang menempel pada vault terkunci.
  let rows: Array<{
    id: number;
    type: Transaction["type"];
    amount: number;
    vault_id: string | null;
    transfer_direction: Transaction["transfer_direction"];
  }> = [
    {
      id: tx.id,
      type: tx.type,
      amount: tx.amount,
      vault_id: tx.vault_id,
      transfer_direction: tx.transfer_direction,
    },
  ];
  if (tx.group_id) {
    const { data: groupRows, error: groupError } = await supabase
      .from("transactions")
      .select("id, type, amount, vault_id, transfer_direction")
      .eq("user_id", user.id)
      .eq("group_id", tx.group_id);
    if (groupError || !groupRows) return { ok: false, error: "err.generic" };
    rows = groupRows;
  }
  const vaultIds = rows.map((row) => row.vault_id).filter((id) => id !== null);
  if (vaultIds.length > 0) {
    const { data: lockedVaults, error: lockedVaultError } = await supabase
      .from("vaults")
      .select("id")
      .eq("user_id", user.id)
      .eq("is_locked", true)
      .in("id", vaultIds);
    if (lockedVaultError) return { ok: false, error: "err.generic" };
    const guard = deleteReducesLockedVaultError(
      rows,
      (lockedVaults ?? []).map((vault) => vault.id)
    );
    if (guard) return { ok: false, error: guard };
  }

  // Transfer keluar pinjaman antar vault adalah jejak penyaluran uang yang
  // menopang catatan pinjaman: menghapusnya mengembalikan uang ke pemberi
  // tanpa menyentuh `outstanding`, dan kalau pembayaran yang tersisa ikut
  // di-undo (riwayat bayar dihapus), utang terbuka kembali tanpa ada uang
  // yang pernah berpindah -- saldo kedua vault jadi salah tanpa jejak.
  // Tolak selama baris pinjaman masih menunjuknya, apa pun statusnya;
  // catatan pinjaman tidak punya tombol hapus, jadi escape hatch-nya
  // reset data atau SQL manual.
  const { data: linkedBorrows, error: linkedBorrowError } = await supabase
    .from("vault_borrows")
    .select("id")
    .eq("user_id", user.id)
    .in(
      "transfer_out_id",
      rows.map((row) => row.id)
    )
    .limit(1);
  if (linkedBorrowError) {
    console.error("Supabase vault borrow link load failed during delete.", linkedBorrowError);
    return { ok: false, error: "err.generic" };
  }
  if ((linkedBorrows ?? []).length > 0) {
    return { ok: false, error: "err.vaultBorrowTransfer" };
  }

  // Transfer pembayaran utang tercatat di `repayment_group_ids` baris
  // utang: menghapusnya berarti membatalkan pembayaran, jadi `outstanding`
  // harus ikut pulih. Restore dilakukan lebih dulu dengan syarat nilai
  // barisnya masih sama seperti yang terbaca (anti-lomba); kalau gagal,
  // transaksi tidak jadi dihapus supaya utang dan ledger tidak pernah
  // berbeda. Sebaliknya, kalau penghapusan transaksi gagal setelah restore,
  // nilainya dikembalikan (kompensasi best-effort).
  let repaymentRestore: {
    borrowId: string;
    outstanding: number;
    status: string;
    repaymentGroupIds: string[];
  } | null = null;
  if (tx.group_id) {
    const { data: repaymentBorrow, error: repaymentError } = await supabase
      .from("vault_borrows")
      .select("id, outstanding, status, repayment_group_ids")
      .eq("user_id", user.id)
      .contains("repayment_group_ids", [tx.group_id])
      .limit(1)
      .maybeSingle();
    if (repaymentError) {
      console.error("Supabase vault borrow repayment link load failed during delete.", repaymentError);
      return { ok: false, error: "err.generic" };
    }
    if (repaymentBorrow) {
      // Semua baris dalam satu group transfer memakai nominal yang sama.
      const pay = rows[0].amount;
      const prevGroupIds: string[] = repaymentBorrow.repayment_group_ids ?? [];
      const { data: restored, error: restoreError } = await supabase
        .from("vault_borrows")
        .update({
          outstanding: repaymentBorrow.outstanding + pay,
          status: "open",
          repayment_group_ids: prevGroupIds.filter((id) => id !== tx.group_id),
        })
        .eq("id", repaymentBorrow.id)
        .eq("user_id", user.id)
        .eq("outstanding", repaymentBorrow.outstanding)
        .eq("status", repaymentBorrow.status)
        .select("id");
      if (restoreError) {
        console.error("Supabase vault borrow repayment restore failed during delete.", restoreError);
        return { ok: false, error: "err.generic" };
      }
      if (!restored?.length) {
        // Nilai baris sudah berubah sejak dibaca -- kemungkinan dibayar
        // dari tab lain. Batalkan sebelum ada yang terhapus.
        return { ok: false, error: "err.generic" };
      }
      repaymentRestore = {
        borrowId: repaymentBorrow.id,
        outstanding: repaymentBorrow.outstanding,
        status: repaymentBorrow.status,
        repaymentGroupIds: prevGroupIds,
      };
    }
  }

  const revertRepaymentRestore = async (): Promise<void> => {
    if (!repaymentRestore) return;
    const { error } = await supabase
      .from("vault_borrows")
      .update({
        outstanding: repaymentRestore.outstanding,
        status: repaymentRestore.status,
        repayment_group_ids: repaymentRestore.repaymentGroupIds,
      })
      .eq("id", repaymentRestore.borrowId)
      .eq("user_id", user.id);
    if (error) {
      console.error("Supabase vault borrow repayment revert failed during delete.", error);
    }
  };

  if (tx.group_id) {
    const { error } = await supabase
      .from("transactions")
      .delete()
      .eq("user_id", user.id)
      .eq("group_id", tx.group_id);
    if (error) {
      await revertRepaymentRestore();
      return { ok: false, error: "err.generic" };
    }
  } else {
    const { error } = await supabase
      .from("transactions")
      .delete()
      .eq("id", txId)
      .eq("user_id", user.id);
    if (error) {
      await revertRepaymentRestore();
      return { ok: false, error: "err.generic" };
    }
  }

  revalidatePath(`/${locale}/dashboard`);
  revalidatePath(`/${locale}/transactions`);
  revalidatePath(`/${locale}/vaults`);
  return { ok: true };
}

/**
 * Memangkas pinjaman anggaran yang menempel pada transaksi pengeluaran atau
 * transfer berkategori setelah pemakaian anggarannya berubah.
 *
 * Guard pre-edit sudah memastikan transaksi muat dengan pinjaman yang ada;
 * fungsi ini hanya menghitung berapa sisa pinjaman yang benar-benar masih
 * dibutuhkan (`requiredBorrowTotal`), lalu memangkas kelebihannya
 * (`planBorrowShrink`) agar sisa anggaran pemberi pulih.
 */
async function shrinkTransactionBorrows(
  supabase: Awaited<ReturnType<typeof createClient>>,
  userId: string,
  txId: number
): Promise<void> {
  try {
    const { data: txBorrows, error: txBorrowsError } = await supabase
      .from("budget_borrows")
      .select("id, from_budget_id, to_budget_id, amount")
      .eq("user_id", userId)
      .eq("transaction_id", txId);
    if (txBorrowsError) {
      console.error("Supabase load transaction borrows failed during shrink.", txBorrowsError);
      return;
    }
    if (!txBorrows || txBorrows.length === 0) return;

    const toBudgetIds = Array.from(new Set(txBorrows.map((b) => b.to_budget_id)));
    if (toBudgetIds.length === 0) return;

    const { data: budgets, error: budgetsError } = await supabase
      .from("budgets")
      .select("id, scope, scope_id, limit_amount, starts_on, ends_on, leftover_discarded")
      .eq("user_id", userId)
      .in("id", toBudgetIds);
    if (budgetsError) {
      console.error("Supabase load budgets failed during shrink.", budgetsError);
      return;
    }
    if (!budgets || budgets.length === 0) return;

    const { data: allBorrows, error: allBorrowsError } = await supabase
      .from("budget_borrows")
      .select("from_budget_id, to_budget_id, amount")
      .eq("user_id", userId);
    if (allBorrowsError) {
      console.error("Supabase load all borrows failed during shrink.", allBorrowsError);
      return;
    }
    const totals = aggregateBorrows((allBorrows ?? []) as BudgetBorrowRow[]);
    const { data: reallocationRows, error: reallocationError } = await supabase
      .from("budget_reallocations")
      .select("from_budget_id, to_budget_id, amount, reversed_at")
      .eq("user_id", userId);
    if (reallocationError) {
      console.error("Supabase load budget reallocations failed during shrink.", reallocationError);
      return;
    }
    const reallocationTotals = aggregateReallocations(
      (reallocationRows ?? []) as BudgetReallocationRow[]
    );

    const minStarts = budgets.reduce(
      (min, b) => (b.starts_on < min ? b.starts_on : min),
      budgets[0].starts_on
    );
    const maxEnds = budgets.reduce(
      (max, b) => (b.ends_on > max ? b.ends_on : max),
      budgets[0].ends_on
    );

    const { data: budgetTxs, error: budgetTxError } = await supabase
      .from("transactions")
      .select("type, amount, category_id, vault_id, date, transfer_direction, group_id")
      .eq("user_id", userId)
      .in("type", ["expense", "transfer"])
      .gte("date", minStarts)
      .lte("date", maxEnds);
    if (budgetTxError) {
      console.error("Supabase load budget transactions failed during shrink.", budgetTxError);
      return;
    }

    const txRows = (budgetTxs ?? []) as Array<
      Pick<Transaction, "type" | "amount" | "category_id" | "vault_id" | "date"> &
        Partial<Pick<Transaction, "transfer_direction" | "group_id">>
    >;

    const needs = new Map<string, number>();
    for (const b of budgets) {
      const spent = budgetSpend(txRows, b);
      const linkedTotal = txBorrows
        .filter((row) => row.to_budget_id === b.id)
        .reduce((sum, row) => sum + row.amount, 0);
      const need = requiredBorrowTotal(
        b,
        spent,
        totals.get(b.id),
        linkedTotal,
        reallocationTotals.get(b.id)
      );
      needs.set(b.id, need);
    }

    const plan = planBorrowShrink(
      txBorrows as (BudgetBorrowRow & { id: string })[],
      needs
    );

    if (plan.deleteIds.length > 0) {
      const { error: delError } = await supabase
        .from("budget_borrows")
        .delete()
        .eq("user_id", userId)
        .in("id", plan.deleteIds);
      if (delError) {
        console.error("Supabase delete borrows failed during shrink.", delError);
      }
    }

    for (const update of plan.updates) {
      const { error: updateError } = await supabase
        .from("budget_borrows")
        .update({ amount: update.amount })
        .eq("id", update.id)
        .eq("user_id", userId);
      if (updateError) {
        console.error("Supabase update borrow failed during shrink.", updateError);
      }
    }
  } catch (err) {
    console.error("Unexpected error in shrinkTransactionBorrows.", err);
  }
}

export async function editTransaction(
  locale: string,
  input: {
    id: number;
    amount: number;
    date: string;
    categoryId: string | null;
    fundingSourceId: string | null;
    vaultId: string | null;
    note: string | null;
  }
): Promise<TxResult> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "err.auth" };
  if (!Number.isSafeInteger(input.id) || input.id <= 0) return { ok: false, error: "err.generic" };
  const amount = input.amount;
  if (!Number.isSafeInteger(amount) || amount <= 0 || amount > 2_147_483_647) {
    return { ok: false, error: "err.amount" };
  }
  if (typeof input.date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(input.date)) {
    return { ok: false, error: "err.period" };
  }
  const parsedDate = new Date(`${input.date}T00:00:00.000Z`);
  if (Number.isNaN(parsedDate.getTime()) || parsedDate.toISOString().slice(0, 10) !== input.date) {
    return { ok: false, error: "err.period" };
  }
  const validOptionalId = (value: string | null) =>
    value === null || /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
  if (
    !validOptionalId(input.categoryId) ||
    !validOptionalId(input.fundingSourceId) ||
    !validOptionalId(input.vaultId) ||
    (input.note !== null && typeof input.note !== "string")
  ) {
    return { ok: false, error: "err.generic" };
  }

  const { data: existing, error: existingError } = await supabase
    .from("transactions")
    .select("id, type, group_id")
    .eq("id", input.id)
    .eq("user_id", user.id)
    .maybeSingle();
  if (existingError || !existing) return { ok: false, error: "err.generic" };

  if (existing.type === "expense") {
    // Hitung ulang tanpa baris ini, lalu proyeksikan nominal barunya. Dengan
    // begitu menaikkan atau menurunkan nominal tetap dinilai terhadap anggaran
    // periode tanggal yang baru.
    const budgetGuard = await checkExpenseBudget(
      supabase,
      user.id,
      {
        amount,
        date: input.date,
        category_id: input.categoryId,
        vault_id: input.vaultId,
      },
      input.id
    );
    if (!budgetGuard.ok) {
      if ("conflict" in budgetGuard) {
        return { ok: false, ...budgetRejection(budgetGuard.conflict) };
      }
      return { ok: false, error: budgetGuard.error };
    }
  } else if (existing.type === "transfer" && existing.group_id) {
    // Kedua leg transfer lama dikecualikan bersama-sama; budgetSpend hanya
    // menghitung leg keluar sehingga kandidat baru diproyeksikan tepat sekali.
    const budgetGuard = await checkExpenseBudget(
      supabase,
      user.id,
      {
        type: "transfer",
        amount,
        date: input.date,
        category_id: input.categoryId,
        vault_id: null,
      },
      undefined,
      existing.group_id
    );
    if (!budgetGuard.ok) {
      if ("conflict" in budgetGuard) {
        return { ok: false, ...budgetRejection(budgetGuard.conflict) };
      }
      return { ok: false, error: budgetGuard.error };
    }
  }

  const { error } = await supabase.rpc("edit_financial_transaction", {
    p_transaction_id: input.id,
    p_amount: amount,
    p_date: input.date,
    p_category_id: input.categoryId,
    p_funding_source_id: input.fundingSourceId,
    p_vault_id: input.vaultId,
    p_note: typeof input.note === "string" ? input.note.trim().slice(0, 200) || null : null,
  });
  if (error) {
    console.error("Supabase transaction edit failed.", { code: error.code, message: error.message });
    const budgetResult = budgetTriggerResult(error);
    if (budgetResult) return budgetResult;
    if (error.message.startsWith("err.") || error.message.startsWith("transactions.")) {
      // Penolakan guard dana vault pada expense dilengkapi angka kekurangannya
      // (dinilai tanpa baris lama, sama seperti guard RPC) supaya bisa
      // ditutup lewat pinjaman antar vault. Edit pemasukan tidak ikut: uang
      // yang kurang bukan masalah yang bisa diselesaikan dengan meminjam.
      if (
        existing.type === "expense" &&
        (error.message === "transactions.insufficient" ||
          error.message === "transactions.sourceNotInVault")
      ) {
        const vaultShortfall = await loadVaultShortfall(supabase, user.id, {
          vaultId: input.vaultId,
          fundingSourceId: input.fundingSourceId,
          amount,
          excludeTransactionId: input.id,
        });
        return {
          ok: false,
          error: error.message,
          ...(vaultShortfall ? { vaultShortfall } : {}),
        };
      }
      return { ok: false, error: error.message };
    }
    return { ok: false, error: "err.generic" };
  }

  if (existing.type === "expense" || existing.type === "transfer") {
    await shrinkTransactionBorrows(supabase, user.id, input.id);
  }

  for (const section of ["dashboard", "transactions", "vaults", "allocation", "budgets", "rewards"]) {
    await revalidatePath(`/${locale}/${section}`);
  }
  return { ok: true };
}