"use server";

import { createHash } from "node:crypto";
import { createClient } from "@/src/lib/supabase/server";

export interface ExportPayload {
  data: string;
  filename: string;
}

interface BackupQueryResult {
  data: unknown;
  error: { code?: string; message: string } | null;
}

const EXPORT_PAGE_SIZE = 1000;
const MAX_BACKUP_ROWS = 20000;

async function readData<T>(name: string, query: PromiseLike<BackupQueryResult>): Promise<T> {
  const result = await query;
  if (result.error) {
    console.error(`Supabase backup export query failed (${name}).`, {
      code: result.error.code,
      message: result.error.message,
    });
    const err = new Error(`backup.export.${name}`) as Error & { code?: string };
    err.code = result.error.code;
    throw err;
  }
  return result.data as T;
}

async function readAllRows<T>(
  name: string,
  queryPage: (from: number, to: number) => PromiseLike<BackupQueryResult>
): Promise<T[]> {
  const rows: T[] = [];
  for (let from = 0; ; from += EXPORT_PAGE_SIZE) {
    const page = await readData<T[]>(name, queryPage(from, from + EXPORT_PAGE_SIZE - 1));
    rows.push(...page);
    if (rows.length > MAX_BACKUP_ROWS) throw new Error(`backup.export.${name}.tooManyRows`);
    if (page.length < EXPORT_PAGE_SIZE) return rows;
  }
}

export async function exportJson(): Promise<ExportPayload> {
  const supabase = await createClient();
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();
  if (authError) {
    console.error("Could not verify user before backup export.", authError);
    throw new Error("backup.auth");
  }
  if (!user) throw new Error("backup.auth");

  try {
    const [profile, transactions, vaults, categories, budgets, allocationRules,
      recurringTransactions, gamification, pointsLog, achievements] = await Promise.all([
        readData<Record<string, unknown> | null>("profile", supabase.from("profiles").select("*").eq("id", user.id).maybeSingle()),
        readAllRows<Record<string, unknown>>("transactions", (from, to) => supabase.from("transactions").select("*").eq("user_id", user.id).order("id").range(from, to)),
        readAllRows<Record<string, unknown>>("vaults", (from, to) => supabase.from("vaults").select("*").eq("user_id", user.id).order("id").range(from, to)),
        readAllRows<Record<string, unknown>>("categories", (from, to) => supabase.from("categories").select("*").or(`user_id.is.null,user_id.eq.${user.id}`).order("id").range(from, to)),
        readAllRows<Record<string, unknown>>("budgets", (from, to) => supabase.from("budgets").select("*").eq("user_id", user.id).order("id").range(from, to)),
        readAllRows<Record<string, unknown>>("allocation_rules", (from, to) => supabase.from("allocation_rules").select("*").eq("user_id", user.id).order("id").range(from, to)),
        readAllRows<Record<string, unknown>>("recurring_transactions", (from, to) => supabase.from("recurring_transactions").select("*").eq("user_id", user.id).order("id").range(from, to)),
        readData<Record<string, unknown> | null>("gamification", supabase.from("gamification_state").select("*").eq("user_id", user.id).maybeSingle()),
        readAllRows<Record<string, unknown>>("points_log", (from, to) => supabase.from("points_log").select("*").eq("user_id", user.id).order("id").range(from, to)),
        readAllRows<Record<string, unknown>>("user_achievements", (from, to) => supabase.from("user_achievements").select("*").eq("user_id", user.id).order("achievement_id").range(from, to)),
      ]);
    const allocationSlots = allocationRules.length === 0
      ? []
      : await readAllRows<Record<string, unknown>>(
          "allocation_slots",
          (from, to) => supabase.from("allocation_slots").select("*").in(
              "rule_id",
              allocationRules.map((rule) => String(rule.id))
            ).order("id").range(from, to)
        );

    let rawBudgetBorrows: Record<string, unknown>[] = [];
    try {
      rawBudgetBorrows = await readAllRows<Record<string, unknown>>(
        "budget_borrows",
        (from, to) =>
          supabase
            .from("budget_borrows")
            .select("*")
            .eq("user_id", user.id)
            .order("id")
            .range(from, to)
      );
    } catch (borrowError) {
      console.warn("Could not read budget_borrows for backup export (table may not exist yet).", borrowError);
      rawBudgetBorrows = [];
    }

    const backupTransactions = transactions.map((transaction) => {
      const backupKey = typeof transaction.backup_key === "string"
        ? transaction.backup_key
        : createHash("sha256")
            .update(`${user.id}:${transaction.id}`)
            .digest("hex")
            .replace(/^(.{8})(.{4})(.{4})(.{4})(.{12}).*$/, "$1-$2-$3-$4-$5");
      return { ...transaction, backup_key: backupKey };
    });

    const txBackupKeyMap = new Map<number | string, string>();
    for (const transaction of backupTransactions as Array<Record<string, unknown> & { backup_key: string }>) {
      const txId = transaction.id;
      if (txId !== undefined && txId !== null && typeof transaction.backup_key === "string") {
        txBackupKeyMap.set(txId as number | string, transaction.backup_key);
      }
    }

    const budgetBorrows = rawBudgetBorrows.map((row) => ({
      id: row.id,
      from_budget_id: row.from_budget_id,
      to_budget_id: row.to_budget_id,
      amount: row.amount,
      created_at: row.created_at,
      transaction_backup_key:
        row.transaction_id !== null && row.transaction_id !== undefined
          ? txBackupKeyMap.get(row.transaction_id as number | string) ?? null
          : null,
    }));

    // Sama seperti budget_borrows: tabel migrasi manual, jadi gagal membaca
    // (belum ada) bukan alasan membatalkan seluruh backup.
    let rawVaultBorrows: Record<string, unknown>[] = [];
    try {
      rawVaultBorrows = await readAllRows<Record<string, unknown>>(
        "vault_borrows",
        (from, to) =>
          supabase
            .from("vault_borrows")
            .select("*")
            .eq("user_id", user.id)
            .order("id")
            .range(from, to)
      );
    } catch (vaultBorrowError) {
      console.warn("Could not read vault_borrows for backup export (table may not exist yet).", vaultBorrowError);
      rawVaultBorrows = [];
    }

    const vaultBorrows = rawVaultBorrows.map((row) => ({
      id: row.id,
      from_vault_id: row.from_vault_id,
      to_vault_id: row.to_vault_id,
      funding_source_id: row.funding_source_id,
      amount: row.amount,
      outstanding: row.outstanding,
      status: row.status,
      created_at: row.created_at,
      transfer_backup_key:
        row.transfer_out_id !== null && row.transfer_out_id !== undefined
          ? txBackupKeyMap.get(row.transfer_out_id as number | string) ?? null
          : null,
    }));

    // Catatan rename/sembunyi kategori per akun (migrasi 0022) ikut diekspor:
    // tanpa baris ini, restore ke akun baru mengembalikan nama kategori bawaan
    // ke nama aslinya. Pola toleran yang sama seperti tabel migrasi manual.
    let rawCategoryOverrides: Record<string, unknown>[] = [];
    try {
      rawCategoryOverrides = await readAllRows<Record<string, unknown>>(
        "category_overrides",
        (from, to) =>
          supabase
            .from("category_overrides")
            .select("*")
            .eq("user_id", user.id)
            .order("category_id")
            .range(from, to)
      );
    } catch (overrideError) {
      console.warn("Could not read category_overrides for backup export (table may not exist yet).", overrideError);
      rawCategoryOverrides = [];
    }

    const categoryOverrides = rawCategoryOverrides.map((row) => ({
      category_id: row.category_id,
      custom_name: row.custom_name,
      hidden: row.hidden,
      created_at: row.created_at,
      updated_at: row.updated_at,
    }));

    const totalRows = transactions.length + vaults.length + categories.length + budgets.length +
      allocationRules.length + allocationSlots.length + recurringTransactions.length + budgetBorrows.length +
      vaultBorrows.length + categoryOverrides.length;
    if (totalRows > MAX_BACKUP_ROWS) throw new Error("backup.export.tooManyRows");

    const data = JSON.stringify(
      {
        schema_version: 1,
        app: "nexora",
        exported_at: new Date().toISOString(),
        account: { id: user.id, email: user.email },
        profile,
        vaults,
        categories,
        transactions: backupTransactions,
        budgets,
        budget_borrows: budgetBorrows,
        vault_borrows: vaultBorrows,
        category_overrides: categoryOverrides,
        allocation_rules: allocationRules,
        allocation_slots: allocationSlots,
        recurring_transactions: recurringTransactions,
        rewards: {
          gamification,
          points_log: pointsLog,
          achievements,
          restore_policy: "Rewards and achievements are preserved on the account and are not overwritten by restore.",
        },
      },
      null,
      2
    );
    if (new TextEncoder().encode(data).byteLength > 10 * 1024 * 1024) {
      throw new Error("backup.export.tooLarge");
    }
    return { data, filename: `nexora-backup-${new Date().toISOString().slice(0, 10)}.json` };
  } catch (exportError) {
    console.error("Nexora account backup export failed.", exportError);
    throw new Error("backup.export.failed");
  }
}