"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/src/lib/supabase/server";
import { distributeAllocation, validateSlots } from "@/src/lib/allocation";
import { todayISO } from "@/src/lib/utils";
import { vaultBalanceDelta } from "@/src/lib/vault-ledger";
import type { AllocationSlot, Transaction } from "../types";

export interface TxResult {
  ok: boolean;
  error?: string;
  points?: number;
  unlockedAchievements?: Array<{ nameKey: string; points: number }>;
  rewardError?: boolean;
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
    base.category_id = input.categoryId ?? null;
    base.vault_id = input.vaultId ?? null;
  } else if (input.type === "expense") {
    base.category_id = input.categoryId ?? null;
    base.vault_id = input.vaultId ?? null;
    // The funding source is checked server-side so the browser cannot be the
    // only thing standing between an expense and a negative source balance.
    const check = await checkSourceBalance(supabase, user.id, input.fundingSourceId, amount);
    if (!check.ok) return check;
    base.funding_source_id = input.fundingSourceId ?? null;
  } else {
    // transfer
    base.vault_id = input.vaultId ?? null;
    base.transfer_direction = "out";
  }

  // New income is split across vaults by the active allocation rule, so the
  // insert becomes one row per slot. Only new rows are affected — nothing here
  // reads or rewrites income that was recorded before this ran.
  if (input.type === "income") {
    const split = await planAllocation(supabase, user.id, amount);
    if (split) {
      const groupId = crypto.randomUUID();
      const { error: splitError } = await supabase.from("transactions").insert(
        split.map((row) => ({ ...base, group_id: groupId, ...row }))
      );
      if (splitError) return { ok: false, error: "err.generic" };
    } else {
      const { error: incomeError } = await supabase.from("transactions").insert(base);
      if (incomeError) return { ok: false, error: "err.generic" };
    }
  } else if (input.type === "transfer") {
    const sourceVaultId = input.vaultId;
    const destinationVaultId = input.destinationVaultId;
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

    const { data: ledger, error: ledgerError } = await supabase
      .from("transactions")
      .select("type, amount, vault_id, transfer_direction")
      .eq("user_id", user.id);
    if (ledgerError) return { ok: false, error: "err.generic" };
    const sourceBalance = (ledger ?? []).reduce(
      (balance, transaction) =>
        transaction.vault_id === sourceVaultId
          ? balance +
            vaultBalanceDelta(
              transaction.type,
              transaction.amount,
              transaction.transfer_direction
            )
          : balance,
      0
    );
    if (sourceBalance < amount) {
      return { ok: false, error: "transactions.insufficient" };
    }

    const groupId = crypto.randomUUID();
    const { error } = await supabase.from("transactions").insert([
      { ...base, group_id: groupId },
      {
        ...base,
        vault_id: destinationVaultId,
        transfer_direction: "in",
        group_id: groupId,
      },
    ]);
    if (error) return { ok: false, error: "err.generic" };
  } else {
    const { error } = await supabase.from("transactions").insert(base);
    if (error) return { ok: false, error: "err.generic" };
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
 * Menolak expense yang sumber dananya kurang, atau yang menunjuk kategori
 * yang bukan sumber pemasukan milik pengguna.
 *
 * Balance dihitung dari ledger, bukan disimpan: income menambah ke
 * `category_id`-nya, expense mengurangi dari `funding_source_id`. Expense lama
 * tanpa sumber (`funding_source_id` null) diabaikan agar saldo sumber tetap
 * konsisten dengan apa yang dilihat pengguna di dashboard.
 */
async function checkSourceBalance(
  supabase: Awaited<ReturnType<typeof createClient>>,
  userId: string,
  fundingSourceId: string | null | undefined,
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

  const { data: rows, error: txError } = await supabase
    .from("transactions")
    .select("type, amount, category_id, funding_source_id")
    .eq("user_id", userId);
  if (txError) return { ok: false, error: "err.generic" };

  const balance = ((rows ?? []) as Pick<Transaction, "type" | "amount" | "category_id" | "funding_source_id">[]).reduce(
    (sum, tx) => {
      if (tx.type === "income" && tx.category_id === source.id) return sum + tx.amount;
      if (tx.type === "expense" && tx.funding_source_id === source.id) return sum - tx.amount;
      return sum;
    },
    0
  );

  if (balance < amount) return { ok: false, error: "transactions.insufficientSource" };
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
    .select("id, user_id, group_id")
    .eq("id", txId)
    .eq("user_id", user.id)
    .maybeSingle();
  if (txError || !tx) return { ok: false, error: "err.generic" };

  if (tx.group_id) {
    const { error } = await supabase
      .from("transactions")
      .delete()
      .eq("user_id", user.id)
      .eq("group_id", tx.group_id);
    if (error) return { ok: false, error: "err.generic" };
  } else {
    const { error } = await supabase
      .from("transactions")
      .delete()
      .eq("id", txId)
      .eq("user_id", user.id);
    if (error) return { ok: false, error: "err.generic" };
  }

  revalidatePath(`/${locale}/dashboard`);
  revalidatePath(`/${locale}/transactions`);
  revalidatePath(`/${locale}/vaults`);
  return { ok: true };
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
    if (error.message === "transactions.insufficientSource") {
      return { ok: false, error: "transactions.insufficientSource" };
    }
    if (error.message.startsWith("err.")) return { ok: false, error: error.message };
    return { ok: false, error: "err.generic" };
  }

  for (const section of ["dashboard", "transactions", "vaults", "allocation", "budgets", "rewards"]) {
    await revalidatePath(`/${locale}/${section}`);
  }
  return { ok: true };
}