import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/src/lib/supabase/server";

export async function GET(request: NextRequest) {
  const code = request.nextUrl.searchParams.get("code");
  const next = request.nextUrl.searchParams.get("next");
  const locale = next?.startsWith("/en/") ? "en" : "id";
  const safeNext =
    next && /^\/(id|en)\/(dashboard|transactions|allocation|vaults|budgets|rewards|calculator|settings)$/.test(next)
      ? next
      : "/id/dashboard";

  if (code) {
    const supabase = await createClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) {
      return NextResponse.redirect(new URL(safeNext, request.url));
    }
    console.error("Supabase email confirmation failed.", error);
  }

  const loginUrl = new URL(`/${locale}/login`, request.url);
  loginUrl.searchParams.set("error", "auth.confirmationError");
  return NextResponse.redirect(loginUrl);
}
