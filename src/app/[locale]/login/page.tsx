import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { WalletCards } from "lucide-react";
import { LoginForm } from "@/src/components/auth/login-form";
import { Card } from "@/src/components/ui/card";

export const metadata: Metadata = { title: "Masuk" };

export default async function LoginPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const { locale } = await params;
  const query = await searchParams;
  const t = await getTranslations("auth");

  return (
    <main className="flex min-h-[100dvh] flex-col px-4 py-10">
      <div className="flex flex-1 flex-col items-center justify-center">
        <div className="mb-8 flex flex-col items-center text-center">
          <div className="brand-mark mb-5 grid h-14 w-14 place-items-center rounded-2xl">
            <WalletCards size={26} strokeWidth={1.7} />
          </div>
          <p className="mb-2 text-xs font-semibold uppercase tracking-[0.2em] text-muted">
            Nexora
          </p>
          <h1 className="font-display text-2xl font-semibold tracking-tight text-ink">
            {t("welcome")}
          </h1>
          <p className="mt-2 max-w-sm text-sm leading-6 text-muted">{t("welcomeDesc")}</p>
        </div>
        <Card className="w-full max-w-sm rounded-2xl">
          {query.error === "auth.confirmationError" && (
            <p role="alert" className="px-7 pt-6 text-sm text-danger">
              {t("emailNotConfirmed")}
            </p>
          )}
          <LoginForm locale={locale} />
        </Card>
      </div>
      <footer className="mt-8 border-t border-line bg-bg1/50 px-4 py-6 text-center text-xs text-muted backdrop-blur-sm lg:px-8">
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
    </main>
  );
}