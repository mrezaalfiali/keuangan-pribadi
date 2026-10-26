"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/src/lib/supabase/server";
import { todayJakartaISO } from "@/src/lib/recurring";
import { computeSourceVaultBalances, sourceVaultBalance, type PairTransaction } from "@/src/lib/sources";
import { budgetRejection, checkExpenseBudget } from "@/src/lib/budget-guard";

type ActionResult = {
  ok: boolean;
  error?: string;
  points?: number;
  unlockedAchievements?: Array<{ nameKey: string; points: number }>;
  rewardError?: boolean;
  budget?: { scope: "category" | "vault"; remaining: number };
};

interface RecurringInput {
  id?: string;
  name: string;
  note: string;
  type: "income" | "expense";
  amount: number;
  categoryId: string | null;
  fundingSourceId: string | null;
  vaultId: string | null;
  frequency: "weekly" | "monthly";
  intervalCount: number;
  dueOn: string;
  endsOn: string | null;
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
    value.unlocked.every((item: unknown) =>
      item !== null &&
      typeof item === "object" &&
      "name_key" in item &&
      typeof item.name_key === "string" &&
      "points_reward" in item &&
      typeof item.points_reward === "number"
    )
  );
}

function isISODate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

async function revalidateFinance(locale: string) {
  for (const section of ["dashboard", "transactions", "allocation", "vaults", "budgets", "rewards"]) {
    await revalidatePath(`/${locale}/${section}`);
  }
}

export async function saveRecurringTemplate(locale: string, input: RecurringInput): Promise<ActionResult> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "err.auth" };
  if (!input || typeof input !== "object") return { ok: false, error: "err.generic" };

  if (
    (input.type !== "income" && input.type !== "expense") ||
    (input.frequency !== "weekly" && input.frequency !== "monthly")
  ) return { ok: false, error: "err.generic" };
  const name = typeof input.name === "string" ? input.name.trim() : "";
  const note = typeof input.note === "string" ? input.note.trim().slice(0, 240) : "";
  const amount = Math.trunc(input.amount);
  if (!name || name.length > 80) return { ok: false, error: "err.name" };
  if (!Number.isSafeInteger(amount) || amount <= 0 || amount > 2_147_483_647) {
    return { ok: false, error: "err.amount" };
  }
  if (!isISODate(input.dueOn) || (input.endsOn && !isISODate(input.endsOn))) {
    return { ok: false, error: "err.period" };
  }
  if (input.endsOn && input.endsOn < input.dueOn) return { ok: false, error: "err.period" };
  if (!Number.isInteger(input.intervalCount) || input.intervalCount < 1 || input.intervalCount > 12) {
    return { ok: false, error: "err.interval" };
  }
  if ((input.type === "expense") !== Boolean(input.fundingSourceId)) {
    return { ok: false, error: "err.source" };
  }
  if (input.type === "income" && !input.categoryId) {
    return { ok: false, error: "err.category" };
  }
  if (input.type === "expense" && !input.vaultId) {
    return { ok: false, error: "transactions.expenseVaultRequired" };
  }

  const categoryIds = [input.categoryId, input.fundingSourceId].filter((id): id is string => Boolean(id));
  if (categoryIds.length) {
    const { data: rows, error } = await supabase
      .from("categories")
      .select("id,type")
      .in("id", categoryIds)
      .or(`user_id.is.null,user_id.eq.${user.id}`);
    if (error) return { ok: false, error: "err.generic" };
    if (
      (input.categoryId && !rows?.some((row) => row.id === input.categoryId && row.type === input.type)) ||
      (input.fundingSourceId && !rows?.some((row) => row.id === input.fundingSourceId && row.type === "income"))
    ) return { ok: false, error: "err.category" };
  }
  if (input.vaultId) {
    const { data: vault, error } = await supabase
      .from("vaults")
      .select("id")
      .eq("id", input.vaultId)
      .eq("user_id", user.id)
      .maybeSingle();
    if (error) return { ok: false, error: "err.generic" };
    if (!vault) return { ok: false, error: "err.vault" };
  }

  const row = {
    user_id: user.id,
    name,
    note: note || null,
    type: input.type,
    amount,
    category_id: input.categoryId,
    funding_source_id: input.fundingSourceId,
    vault_id: input.vaultId,
    frequency: input.frequency,
    interval_count: input.intervalCount,
    anchor_day: Number(input.dueOn.slice(8, 10)),
    due_on: input.dueOn,
    ends_on: input.endsOn || null,
  };
  const query = input.id
    ? supabase.from("recurring_transactions").update(row).eq("id", input.id).eq("user_id", user.id)
    : supabase.from("recurring_transactions").insert(row);
  const { error } = await query;
  if (error) {
    console.error("Supabase recurring template save failed.", { code: error.code, message: error.message });
    return { ok: false, error: "err.generic" };
  }
  await revalidateFinance(locale);
  return { ok: true };
}

export async function recordRecurringTransaction(
  locale: string,
  input: {
    templateId: string;
    dueOn: string;
    transactionDate: string;
    amount: number;
    categoryId: string | null;
    fundingSourceId: string | null;
    vaultId: string | null;
    note: string;
    allocationMode: "auto" | "single";
  }
): Promise<ActionResult> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "err.auth" };
  const today = todayJakartaISO();
  if (
    !isISODate(input.dueOn) ||
    input.dueOn > today ||
    !isISODate(input.transactionDate) ||
    input.transactionDate > today
  ) return { ok: false, error: "err.occurrence" };
  const amount = Math.trunc(input.amount);
  if (!Number.isSafeInteger(amount) || amount <= 0 || amount > 2_147_483_647) {
    return { ok: false, error: "err.amount" };
  }

  const { data: template, error: templateError } = await supabase
    .from("recurring_transactions")
    .select("type, frequency, interval_count, anchor_day, due_on, is_active")
    .eq("id", input.templateId)
    .eq("user_id", user.id)
    .maybeSingle();
  if (templateError) return { ok: false, error: "err.generic" };
  if (!template || !template.is_active || template.due_on !== input.dueOn) {
    return { ok: false, error: "err.occurrence" };
  }

  if (input.allocationMode !== "auto" && input.allocationMode !== "single") {
    return { ok: false, error: "err.generic" };
  }

  if (template.type === "expense") {
    if (!input.fundingSourceId) return { ok: false, error: "transactions.noSource" };
    if (!input.vaultId) return { ok: false, error: "transactions.expenseVaultRequired" };
    const { data: rows, error } = await supabase
      .from("transactions")
      .select("type, amount, category_id, funding_source_id, vault_id, transfer_direction")
      .eq("user_id", user.id);
    if (error) return { ok: false, error: "err.generic" };
    // Cek pasangan (sumber, vault), bukan agregat sumber: pengeluaran berulang
    // hanya boleh memakai uang sumber yang benar-benar ada di vault itu.
    const balances = computeSourceVaultBalances((rows ?? []) as PairTransaction[]);
    if (sourceVaultBalance(balances, input.fundingSourceId, input.vaultId) < amount) {
      return { ok: false, error: "transactions.sourceNotInVault" };
    }

    const budgetGuard = await checkExpenseBudget(supabase, user.id, {
      amount,
      date: input.transactionDate,
      category_id: input.categoryId,
      vault_id: input.vaultId,
    });
    if (!budgetGuard.ok) {
      if ("conflict" in budgetGuard) {
        return { ok: false, ...budgetRejection(budgetGuard.conflict) };
      }
      return { ok: false, error: budgetGuard.error };
    }
  } else {
    if (input.fundingSourceId) return { ok: false, error: "err.source" };
    // Mode "single" mencatat pemasukan ke satu vault pilihan, jadi vault wajib.
    if (input.allocationMode === "single" && !input.vaultId) {
      return { ok: false, error: "err.vault" };
    }
    // Mode "auto" butuh aturan alokasi aktif; tanpa itu pemasukan tersimpan
    // dengan vault_id null dan uangnya tidak bisa dibelanjakan lagi.
    if (input.allocationMode === "auto" && !input.vaultId) {
      const { data: rule, error: ruleError } = await supabase
        .from("allocation_rules")
        .select("id")
        .eq("user_id", user.id)
        .eq("is_active", true)
        .limit(1)
        .maybeSingle();
      if (ruleError) return { ok: false, error: "err.generic" };
      if (!rule) return { ok: false, error: "transactions.allocationRuleRequired" };
    }
  }

  const { data, error } = await supabase.rpc("record_recurring_transaction", {
    p_template_id: input.templateId,
    p_due_on: input.dueOn,
    p_today: today,
    p_transaction_date: input.transactionDate,
    p_amount: amount,
    p_category_id: input.categoryId,
    p_funding_source_id: input.fundingSourceId,
    p_vault_id: input.vaultId,
    p_note: input.note,
    p_allocation_mode: input.allocationMode,
  });
  if (error) {
    console.error("Supabase recurring transaction record failed.", { code: error.code, message: error.message });
    if (error.message.startsWith("err.") || error.message.startsWith("transactions.")) {
      return { ok: false, error: error.message };
    }
    return { ok: false, error: "err.generic" };
  }
  if (!Array.isArray(data) || typeof data[0]?.transaction_id !== "number") {
    console.error("Supabase recurring transaction RPC returned an invalid response.");
    return { ok: false, error: "err.generic" };
  }

  const { data: rewardData, error: rewardError } = await supabase.rpc("award_transaction_rewards");
  let points = 0;
  let unlockedAchievements: ActionResult["unlockedAchievements"] = [];
  let rewardFailed = Boolean(rewardError);
  if (rewardError) {
    console.error("Supabase recurring transaction reward update failed.", {
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
    console.error("Supabase recurring transaction reward update returned an invalid response.");
  }
  await revalidateFinance(locale);
  return { ok: true, points, unlockedAchievements, rewardError: rewardFailed };
}

export async function skipRecurringOccurrence(
  locale: string,
  templateId: string,
  dueOn: string
): Promise<ActionResult> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "err.auth" };
  const today = todayJakartaISO();
  if (!isISODate(dueOn) || dueOn > today) return { ok: false, error: "err.occurrence" };
  const { error } = await supabase.rpc("skip_recurring_occurrence", {
    p_template_id: templateId,
    p_due_on: dueOn,
    p_today: today,
  });
  if (error) {
    console.error("Supabase recurring occurrence skip failed.", { code: error.code, message: error.message });
    return { ok: false, error: error.message.startsWith("err.") ? error.message : "err.generic" };
  }
  await revalidateFinance(locale);
  return { ok: true };
}

export async function snoozeRecurringOccurrence(
  locale: string,
  templateId: string,
  dueOn: string
): Promise<ActionResult> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "err.auth" };
  const today = todayJakartaISO();
  if (!isISODate(dueOn) || dueOn > today) return { ok: false, error: "err.occurrence" };
  const tomorrow = new Date(`${today}T00:00:00.000Z`);
  tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
  const { error } = await supabase.rpc("snooze_recurring_occurrence", {
    p_template_id: templateId,
    p_due_on: dueOn,
    p_today: today,
    p_until: tomorrow.toISOString().slice(0, 10),
  });
  if (error) {
    console.error("Supabase recurring occurrence snooze failed.", { code: error.code, message: error.message });
    return { ok: false, error: error.message.startsWith("err.") ? error.message : "err.generic" };
  }
  await revalidateFinance(locale);
  return { ok: true };
}

export async function setRecurringTemplateActive(
  locale: string,
  templateId: string,
  isActive: boolean
): Promise<ActionResult> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "err.auth" };
  const { error } = await supabase
    .from("recurring_transactions")
    .update({ is_active: isActive, snoozed_until: null, updated_at: new Date().toISOString() })
    .eq("id", templateId)
    .eq("user_id", user.id);
  if (error) {
    console.error("Supabase recurring template state update failed.", { code: error.code, message: error.message });
    return { ok: false, error: "err.generic" };
  }
  await revalidateFinance(locale);
  return { ok: true };
}

export async function deleteRecurringTemplate(locale: string, templateId: string): Promise<ActionResult> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "err.auth" };
  const { error } = await supabase
    .from("recurring_transactions")
    .delete()
    .eq("id", templateId)
    .eq("user_id", user.id);
  if (error) {
    console.error("Supabase recurring template delete failed.", { code: error.code, message: error.message });
    return { ok: false, error: "err.generic" };
  }
  await revalidateFinance(locale);
  return { ok: true };
}
