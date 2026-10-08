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
    throw new Error(`backup.export.${name}`);
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
    const totalRows = transactions.length + vaults.length + categories.length + budgets.length +
      allocationRules.length + allocationSlots.length + recurringTransactions.length;
    if (totalRows > MAX_BACKUP_ROWS) throw new Error("backup.export.tooManyRows");

    const backupTransactions = transactions.map((transaction) => {
      const backupKey = typeof transaction.backup_key === "string"
        ? transaction.backup_key
        : createHash("sha256")
            .update(`${user.id}:${transaction.id}`)
            .digest("hex")
            .replace(/^(.{8})(.{4})(.{4})(.{4})(.{12}).*$/, "$1-$2-$3-$4-$5");
      return { ...transaction, backup_key: backupKey };
    });
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