"use server";

import { createClient } from "@/src/lib/supabase/server";

const BACKUP_MAX_BYTES = 10 * 1024 * 1024;
const BACKUP_TABLES = [
  "categories",
  "vaults",
  "transactions",
  "budgets",
  "allocation_rules",
  "allocation_slots",
  "recurring_transactions",
] as const;

export type BackupRestoreResult =
  | { ok: true; restoredRows: number }
  | { ok: false; error: "backup.auth" | "backup.format" | "backup.owner" | "backup.restore" };

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export async function restoreFinancialBackup(backup: unknown): Promise<BackupRestoreResult> {
  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError) {
    console.error("Could not verify user before backup restore.", authError);
    return { ok: false, error: "backup.auth" };
  }
  if (!user) return { ok: false, error: "backup.auth" };

  if (!isRecord(backup)) return { ok: false, error: "backup.format" };
  let serialized: string;
  try {
    serialized = JSON.stringify(backup);
  } catch (serializationError) {
    console.error("Backup serialization failed before restore.", serializationError);
    return { ok: false, error: "backup.format" };
  }
  if (new TextEncoder().encode(serialized).byteLength > BACKUP_MAX_BYTES) {
    return { ok: false, error: "backup.format" };
  }
  if (
    backup.schema_version !== 1 ||
    backup.app !== "nexora" ||
    !isRecord(backup.account) ||
    typeof backup.account.id !== "string" ||
    !Array.isArray(backup.transactions) ||
    !Array.isArray(backup.categories) ||
    BACKUP_TABLES.some((key) => !Array.isArray(backup[key])) ||
    (backup.profile !== null && !isRecord(backup.profile))
  ) {
    return { ok: false, error: "backup.format" };
  }
  if (backup.account.id !== user.id) return { ok: false, error: "backup.owner" };

  const totalRows = BACKUP_TABLES.reduce((count, key) => count + (backup[key] as unknown[]).length, 0);
  if (totalRows > 20000) return { ok: false, error: "backup.format" };

  const { data, error } = await supabase.rpc("restore_financial_backup", {
    p_backup: backup,
  });
  if (error) {
    console.error("Supabase backup restore failed.", { code: error.code, message: error.message });
    if (error.message === "err.backupOwner") return { ok: false, error: "backup.owner" };
    if (error.message === "err.backupFormat") return { ok: false, error: "backup.format" };
    return { ok: false, error: "backup.restore" };
  }
  return { ok: true, restoredRows: Number(data) };
}
