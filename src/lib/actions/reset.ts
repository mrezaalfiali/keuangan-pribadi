"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/src/lib/supabase/server";

export type ResetResult = { ok: boolean; error?: string };

async function revalidateFinance(locale: string) {
  for (const section of ["dashboard", "transactions", "allocation", "vaults", "budgets", "rewards"]) {
    await revalidatePath(`/${locale}/${section}`);
  }
}

export async function resetFinancialData(locale: string): Promise<ResetResult> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "err.auth" };

  const { error } = await supabase.rpc("reset_financial_data");
  if (error) {
    console.error("Supabase financial reset failed.", { code: error.code, message: error.message });
    if (typeof error.message === "string" && error.message.startsWith("err.")) {
      return { ok: false, error: error.message };
    }
    return { ok: false, error: "err.generic" };
  }

  await revalidateFinance(locale);
  return { ok: true };
}
