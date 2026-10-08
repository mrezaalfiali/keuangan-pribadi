"use client";

import {
  LayoutDashboard,
  ArrowLeftRight,
  PieChart,
  Lock,
  Wallet,
  Trophy,
  Settings,
  Calculator,
  Info,
  LogOut,
  Sparkles,
  WalletCards,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { Link, usePathname } from "@/src/i18n/navigation";
import { cn } from "@/src/lib/utils";
import { ThemeToggle } from "@/src/components/theme-toggle";
import { LocaleSwitcher } from "@/src/components/locale-switcher";
import { signOutAction } from "@/src/lib/actions/auth";

const NAV = [
  { href: "/dashboard", key: "nav.dashboard", icon: LayoutDashboard },
  { href: "/transactions", key: "nav.transactions", icon: ArrowLeftRight },
  { href: "/allocation", key: "nav.allocation", icon: PieChart },
  { href: "/vaults", key: "nav.vaults", icon: Lock },
  { href: "/budgets", key: "nav.budgets", icon: Wallet },
  { href: "/rewards", key: "nav.rewards", icon: Trophy },
  { href: "/calculator", key: "nav.calculator", icon: Calculator },
  { href: "/about", key: "nav.about", icon: Info },
  { href: "/settings", key: "nav.settings", icon: Settings },
] as const;

export function AppShell({
  children,
  userEmail,
  displayName,
  points,
  streak,
}: {
  children: React.ReactNode;
  userEmail: string;
  displayName: string;
  points: number;
  streak: number;
}) {
  const t = useTranslations();
  const pathname = usePathname();

  return (
    <div className="min-h-[100dvh]">
      <aside className="fixed inset-y-0 left-0 z-40 hidden h-dvh w-64 flex-col overflow-hidden border-r border-line bg-bg1/70 p-5 lg:flex">
        <div className="mb-9 flex items-center gap-3 px-2 pt-1">
          <div className="brand-mark grid h-9 w-9 place-items-center rounded-xl">
            <WalletCards size={19} />
          </div>
            <span className="font-display text-lg font-semibold tracking-tight text-ink">
              Nexora
            </span>
        </div>

        <nav aria-label="Primary navigation" className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto">
          {NAV.map(({ href, key, icon: Icon }) => {
            const active =
              pathname === href || pathname.startsWith(`${href}/`);
            return (
              <Link
                key={href}
                href={href}
                className={cn(
                  "flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition-colors",
                  active
                    ? "bg-surface2 text-ink"
                    : "text-muted hover:bg-surface2 hover:text-ink"
                )}
              >
                <Icon size={18} />
                {t(key)}
              </Link>
            );
          })}
        </nav>

        <div className="mt-4 rounded-2xl border border-line bg-surface p-4">
          <div className="flex items-center gap-2 text-muted">
            <Sparkles size={14} className="text-accent" />
            <span className="text-xs font-semibold text-ink">{displayName}</span>
          </div>
          <p className="mt-1 text-xs text-faint">{userEmail}</p>
          <div className="mt-3 flex items-center justify-between text-xs">
            <span className="text-faint">{t("dashboard.points")}</span>
            <span className="num font-semibold text-ink">{points.toLocaleString("id-ID")}</span>
          </div>
          <div className="flex items-center justify-between text-xs">
            <span className="text-faint">{t("dashboard.streak")}</span>
            <span className="num font-semibold text-muted">{streak} {t("dashboard.days")}</span>
          </div>
        </div>
      </aside>

      <div className="flex min-h-[100dvh] min-w-0 flex-col lg:ml-64">
        <header className="sticky top-0 z-30 flex h-16 items-center justify-between gap-3 border-b border-line bg-bg0/90 px-4 backdrop-blur-xl lg:px-8">
          <div className="flex items-center gap-2 lg:hidden">
            <div className="brand-mark grid h-8 w-8 place-items-center rounded-lg">
              <WalletCards size={17} />
            </div>
            <span className="font-display font-semibold text-ink">Nexora</span>
          </div>
          <div className="hidden text-sm text-muted lg:block">
            {t("dashboard.subtitle")}
          </div>
          <div className="flex items-center gap-2">
            <div className="hidden items-center gap-2 rounded-xl border border-line bg-surface px-3 py-1.5 sm:flex">
              <span className="num font-semibold text-ink">{points.toLocaleString("id-ID")}</span>
              <span className="text-xs text-faint">pts</span>
            </div>
            <LocaleSwitcher />
            <ThemeToggle />
            <form action={signOutAction}>
              <button
                type="submit"
                className="inline-flex h-10 w-10 items-center justify-center rounded-xl border border-line bg-surface text-muted transition-colors hover:border-danger/40 hover:text-danger"
                aria-label={t("common.logout")}
              >
                <LogOut size={18} />
              </button>
            </form>
          </div>
        </header>

        <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-6 lg:px-8 lg:py-8">
          {children}
        </main>

        <footer className="mt-auto border-t border-line bg-bg1/50 px-4 py-6 text-center text-xs text-muted backdrop-blur-sm lg:px-8 pb-[calc(env(safe-area-inset-bottom)+4.5rem)] lg:pb-6">
          <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-4 sm:flex-row sm:text-left">
            <div>
              <p className="font-medium text-ink">Moh. Reza Alfi Ali</p>
              <p className="mt-1 text-faint">© {new Date().getFullYear()} All rights reserved</p>
            </div>
            <div className="flex items-center gap-4">
              <a
                href="https://www.instagram.com/mrezaaaxx/"
                target="_blank"
                rel="noopener noreferrer"
                className="transition-colors hover:text-ink"
                aria-label="Instagram"
              >
                Instagram
              </a>
              <a
                href="https://www.linkedin.com/in/mohrezaalfiali/"
                target="_blank"
                rel="noopener noreferrer"
                className="transition-colors hover:text-ink"
                aria-label="LinkedIn"
              >
                LinkedIn
              </a>
              <a
                href="https://github.com/mrezaalfiali"
                target="_blank"
                rel="noopener noreferrer"
                className="transition-colors hover:text-ink"
                aria-label="GitHub"
              >
                GitHub
              </a>
            </div>
          </div>
        </footer>
        <nav
          aria-label="Primary navigation"
          className="fixed inset-x-0 bottom-0 z-40 flex overflow-x-auto border-t border-line bg-bg1/95 px-2 pb-[env(safe-area-inset-bottom)] pt-2 backdrop-blur-xl lg:hidden"
        >
          {NAV.map(({ href, key, icon: Icon }) => {
            const active =
              pathname === href || pathname.startsWith(`${href}/`);
            return (
              <Link
                key={href}
                href={href}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "flex min-w-[4.25rem] flex-1 flex-col items-center gap-1 rounded-xl px-2 py-1.5 text-[10px] font-medium transition-colors",
                  active ? "text-ink" : "text-muted hover:text-ink"
                )}
              >
                <Icon size={18} strokeWidth={active ? 2.2 : 1.8} />
                <span className="whitespace-nowrap">{t(key)}</span>
              </Link>
            );
          })}
        </nav>
      </div>
    </div>
  );
}