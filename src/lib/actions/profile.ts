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

  const { error } = await supabase
    .from("profiles")
    .update({ display_name: name })
    .eq("id", user.id)
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
