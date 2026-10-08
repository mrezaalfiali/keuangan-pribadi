"use client";

import { useTransition } from "react";
import { useLocale } from "next-intl";
import { Languages } from "lucide-react";
import { usePathname, useRouter } from "@/src/i18n/navigation";

export function LocaleSwitcher() {
  const locale = useLocale();
  const router = useRouter();
  const pathname = usePathname();
  const [isPending, startTransition] = useTransition();

  const switchLocale = (next: "id" | "en") => {
    if (next === locale) return;
    startTransition(() => {
      router.replace(pathname, { locale: next });
    });
  };

  return (
    <div className="flex items-center gap-1 rounded-xl border border-line bg-surface px-1 py-1">
      <Languages size={14} className="ml-1.5 text-faint" />
      {(["id", "en"] as const).map((loc) => (
        <button
          key={loc}
          type="button"
          onClick={() => switchLocale(loc)}
          disabled={isPending}
          aria-pressed={locale === loc}
          aria-label={loc === "id" ? "Bahasa Indonesia" : "English"}
          className={
            locale === loc
              ? "rounded-lg bg-surface2 px-2 py-1 text-xs font-semibold text-ink"
              : "rounded-lg px-2 py-1 text-xs font-medium text-muted hover:text-ink"
          }
        >
          {loc.toUpperCase()}
        </button>
      ))}
    </div>
  );
}