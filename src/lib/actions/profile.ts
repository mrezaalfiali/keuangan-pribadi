"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/src/lib/supabase/server";

export interface ProfileActionResult {
  ok: boolean;
  error?: string;
}

export async function saveDisplayName(
  locale: string,
  displayName: string
): Promise<ProfileActionResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "err.auth" };

  const name = displayName.trim();
  if (!name || name.length > 64) {
    return { ok: false, error: "settings.displayNameInvalid" };
  }

  // Upsert (bukan update) supaya user yang belum punya baris profil — mis. akun
  // lama sebelum trigger 0016 ada — tetap bisa menyimpan nama tampilan.
  const { error } = await supabase
    .from("profiles")
    .upsert({ id: user.id, display_name: name }, { onConflict: "id" })
    .select("id")
    .single();
  if (error) {
    console.error("Supabase profile update failed.", {
      code: error.code,
    });
    return { ok: false, error: "err.generic" };
  }

  revalidatePath(`/${locale}/settings`);
  return { ok: true };
}
