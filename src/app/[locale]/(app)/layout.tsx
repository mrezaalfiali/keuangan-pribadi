import { getTranslations } from "next-intl/server";
import { AppShell } from "@/src/components/shell/app-shell";
import { checkAuth } from "@/src/lib/session";
import { getGamification, getProfile } from "@/src/lib/queries";

export default async function AppLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  const user = await checkAuth(locale);
  const [profile, gamification, t] = await Promise.all([
    getProfile(),
    getGamification(),
    getTranslations(),
  ]);

  return (
    <AppShell
      userEmail={user.email ?? ""}
      displayName={profile?.display_name || user.email?.split("@")[0] || t("common.none")}
      points={gamification?.points ?? 0}
      streak={gamification?.streak_current ?? 0}
    >
      {children}
    </AppShell>
  );
}