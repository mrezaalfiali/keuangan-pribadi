import { createClient } from "@/src/lib/supabase/server";
import { redirect } from "next/navigation";
import { routing } from "@/src/i18n/routing";

export async function checkAuth(
  locale: string = routing.defaultLocale
): Promise<{ email: string | null; id: string }> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    redirect(`/${locale}/login`);
  }
  return { email: user.email ?? null, id: user.id };
}