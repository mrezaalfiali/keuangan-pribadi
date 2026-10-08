"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/src/lib/supabase/server";
import { sourceSlug } from "@/src/lib/sources";
import { isDuplicateName } from "@/src/lib/labels";
import type { Transaction } from "../types";
import { vaultBalanceDelta } from "../vault-ledger";

export interface ActionResult {
  ok: boolean;
  error?: string;
}

export async function createVault(
  locale: string,
  input: {
    name: string;
    target_amount?: number | null;
    icon?: string | null;
    color?: string | null;
    priority?: number;
  }
): Promise<ActionResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "err.auth" };

  const name = input.name.trim();
  const slug = sourceSlug(name);
  if (!name || !slug) return { ok: false, error: "err.vaultName" };

  // Duplikasi dinilai dari NAMA, bukan dari `slug` yang akan dibuat --
  // lihat `isDuplicateName`. `slug` polos hanya cocok dengan baris yang kebetulan
  // polyslug, sehingga vault lama yang slug-nya bersufiks akan lolos.
  const { data: existing, error: existingError } = await supabase
    .from("vaults")
    .select("name")
    .eq("user_id", user.id);
  if (existingError) return { ok: false, error: "err.generic" };

  if (isDuplicateName((existing ?? []).map((row) => row.name), name)) {
    return { ok: false, error: "vaults.nameTaken" };
  }

  const { error } = await supabase.from("vaults").insert({
    user_id: user.id,
    slug,
    name,
    target_amount: input.target_amount ? Math.trunc(input.target_amount) : null,
    icon: input.icon ?? null,
    color: input.color ?? null,
    priority: input.priority ?? 0,
  });
  // 23505 = unique (user_id, slug). Muncul kalau dua submit lolos cek nama
  // bersamaan; pesan yang sama lebih berguna daripada error generik.
  if (error?.code === "23505") return { ok: false, error: "vaults.nameTaken" };
  if (error) return { ok: false, error: "err.generic" };

  revalidatePath(`/${locale}/vaults`);
  return { ok: true };
}

export async function toggleVaultLock(
  locale: string,
  vaultId: string,
  lock: boolean
): Promise<ActionResult> {
  const supabase = await createClient();
  const { error } = await supabase
    .from("vaults")
    .update({ is_locked: lock, locked_until: lock ? null : null })
    .eq("id", vaultId);
  if (error) return { ok: false, error: "err.generic" };

  revalidatePath(`/${locale}/vaults`);
  return { ok: true };
}

export async function deleteVault(
  locale: string,
  vaultId: string
): Promise<ActionResult> {
  const supabase = await createClient();
  const { error } = await supabase
    .from("vaults")
    .delete()
    .eq("id", vaultId);
  if (error) return { ok: false, error: "err.generic" };

  revalidatePath(`/${locale}/vaults`);
  revalidatePath(`/${locale}/allocation`);
  return { ok: true };
}

export async function vaultTransfer(
  locale: string,
  fromVaultId: string,
  toVaultId: string,
  amount: number,
  note?: string | null
): Promise<ActionResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "err.auth" };

  const amountInt = Math.trunc(amount);
  if (amountInt <= 0) return { ok: false, error: "err.amount" };
  if (!fromVaultId || !toVaultId || fromVaultId === toVaultId) {
    return { ok: false, error: "err.generic" };
  }

  const { data: all, error: transactionsError } = await supabase
    .from("transactions")
    .select("type, amount, vault_id, transfer_direction")
    .eq("user_id", user.id);
  if (transactionsError) return { ok: false, error: "err.generic" };

  const balance = ((all ?? []) as Pick<Transaction, "type" | "amount" | "vault_id" | "transfer_direction">[]).reduce((sum, tx) => {
    if (tx.vault_id !== fromVaultId) return sum;
    return sum + vaultBalanceDelta(tx.type, tx.amount, tx.transfer_direction);
  }, 0);
  if (balance < amountInt) return { ok: false, error: "vaults.insufficient" };

  const { data: vaults, error: vaultError } = await supabase
    .from("vaults")
    .select("id, is_locked")
    .eq("user_id", user.id)
    .in("id", [fromVaultId, toVaultId]);
  if (vaultError || vaults?.length !== 2) {
    return { ok: false, error: "err.generic" };
  }
  if (vaults.find((vault) => vault.id === fromVaultId)?.is_locked) {
    return { ok: false, error: "transactions.lockedError" };
  }

  const date = new Date().toISOString().slice(0, 10);
  const groupId = crypto.randomUUID();
  const { error } = await supabase.from("transactions").insert([
    { user_id: user.id, type: "transfer", transfer_direction: "out", group_id: groupId, amount: amountInt, date, vault_id: fromVaultId, note },
    { user_id: user.id, type: "transfer", transfer_direction: "in", group_id: groupId, amount: amountInt, date, vault_id: toVaultId, note },
  ]);
  if (error) return { ok: false, error: "err.generic" };

  revalidatePath(`/${locale}/vaults`);
  revalidatePath(`/${locale}/transactions`);
  return { ok: true };
}