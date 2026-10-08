"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/src/lib/supabase/server";
import { validateSlots } from "@/src/lib/allocation";
import type { AllocationSlot } from "../types";

export interface ActionResult {
  ok: boolean;
  error?: string;
}

export async function saveAllocationRule(
  locale: string,
  input: {
    name: string;
    sourceCategoryId: string | null;
    isActive: boolean;
    slots: Array<{
      vaultId: string;
      method: AllocationSlot["method"];
      value: number;
      priority: number;
    }>;
  }
): Promise<ActionResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "err.auth" };

  const check = validateSlots(
    input.slots.map((slot) => ({
      vault_id: slot.vaultId,
      method: slot.method,
      value: slot.value,
    }))
  );
  if (!check.ok) return { ok: false, error: check.error };

  // Jika aturan baru dibuat sebagai aktif, pastikan hanya aturan ini yang aktif.
  if (input.isActive) {
    await supabase
      .from("allocation_rules")
      .update({ is_active: false })
      .eq("user_id", user.id);
  }

  const { data: rule, error: ruleError } = await supabase
    .from("allocation_rules")
    .insert({
      user_id: user.id,
      name: input.name || null,
      source_category_id: input.sourceCategoryId,
      is_active: input.isActive,
    })
    .select()
    .single();
  if (ruleError || !rule) return { ok: false, error: "err.generic" };

  const rows = input.slots.map((s, i) => ({
    rule_id: rule.id,
    vault_id: s.vaultId,
    method: s.method,
    value: s.method === "percent" ? s.value : Math.trunc(s.value),
    priority: s.priority || i,
  }));
  const { error: slotsError } = await supabase
    .from("allocation_slots")
    .insert(rows);
  if (slotsError) {
    // Slot gagal disimpan: aturan tanpa slot tidak akan pernah dieksekusi dan
    // akan tampil sebagai daftar kosong, jadi lebih baik dibatalkan saja.
    await supabase.from("allocation_rules").delete().eq("id", rule.id);
    return { ok: false, error: "err.generic" };
  }

  revalidatePath(`/${locale}/allocation`);
  revalidatePath(`/${locale}/transactions`);
  return { ok: true };
}

export async function deleteAllocationRule(
  locale: string,
  ruleId: string
): Promise<ActionResult> {
  const supabase = await createClient();
  const { error } = await supabase
    .from("allocation_rules")
    .delete()
    .eq("id", ruleId);
  if (error) return { ok: false, error: "err.generic" };

  revalidatePath(`/${locale}/allocation`);
  return { ok: true };
}

export async function setActiveRule(
  locale: string,
  ruleId: string,
  active: boolean
): Promise<ActionResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "err.auth" };

  if (active) {
    await supabase
      .from("allocation_rules")
      .update({ is_active: false })
      .eq("user_id", user.id)
      .neq("id", ruleId);
  }
  await supabase
    .from("allocation_rules")
    .update({ is_active: active })
    .eq("id", ruleId);

  revalidatePath(`/${locale}/allocation`);
  return { ok: true };
}


