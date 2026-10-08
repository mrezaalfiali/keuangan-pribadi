import createMiddleware from "next-intl/middleware";
import { NextResponse, type NextRequest } from "next/server";
import { routing } from "./i18n/routing";
import { updateSession } from "./lib/supabase/middleware";

const handleI18n = createMiddleware(routing);

const authPath = /^\/(id|en)\/(login|register)(\/|$)/;
const protectedPath = /^\/(id|en)\/(dashboard|transactions|allocation|vaults|budgets|rewards|calculator|about|settings)(\/|$)/;

export async function proxy(request: NextRequest) {
  if (request.nextUrl.pathname === "/auth/callback") {
    return NextResponse.next();
  }
  const { supabaseResponse, user } = await updateSession(request);
  const { pathname } = request.nextUrl;
  const locale = pathname.split("/")[1];

  if (!user && protectedPath.test(pathname)) {
    const url = request.nextUrl.clone();
    url.pathname = `/${locale}/login`;
    const response = NextResponse.redirect(url);
    supabaseResponse.cookies.getAll().forEach((cookie) => response.cookies.set(cookie));
    return response;
  }

  if (user && authPath.test(pathname)) {
    const url = request.nextUrl.clone();
    url.pathname = `/${locale}/dashboard`;
    const response = NextResponse.redirect(url);
    supabaseResponse.cookies.getAll().forEach((cookie) => response.cookies.set(cookie));
    return response;
  }

  const response = handleI18n(request);
  supabaseResponse.cookies.getAll().forEach((cookie) => response.cookies.set(cookie));
  return response;
}

export const config = {
  matcher:
    "/((?!api|trpc|_next|_vercel|.*\\..*|favicon.ico|sitemap.xml|robots.txt).*)",
}