"use client";

import { useActionState } from "react";
import { useTranslations } from "next-intl";
import { signInAction, type AuthState } from "@/src/lib/actions/auth";
import { LocaleSwitcher } from "@/src/components/locale-switcher";
import { Button } from "@/src/components/ui/button";
import { Field, Input } from "@/src/components/ui/input";
import { Link } from "@/src/i18n/navigation";

export function LoginForm({ locale }: { locale: string }) {
  const t = useTranslations("auth");
  const [state, action, pending] = useActionState(
    signInAction.bind(null, locale),
    { message: null, error: null } satisfies AuthState
  );

  return (
    <form action={action} className="flex flex-col gap-5 p-7">
      <h2 className="font-display text-xl font-semibold tracking-tight text-ink">
        {t("loginTitle")}
      </h2>
      <Field label={t("email")}>
        <Input type="email" name="email" autoComplete="email" required />
      </Field>
      <Field label={t("password")}>
        <Input type="password" name="password" autoComplete="current-password" required />
      </Field>
      {state.error && <p className="text-sm text-danger">{t(state.error)}</p>}
      <Button type="submit" disabled={pending} size="lg" className="w-full">
        {pending ? "…" : t("signIn")}
      </Button>
      <p className="text-center text-sm text-muted">
        {t("noAccount")}{" "}
        <Link href="/register" className="font-semibold text-accent hover:underline">
          {t("createOne")}
        </Link>
      </p>
      <div className="flex justify-center pt-2">
        <LocaleSwitcher />
      </div>
    </form>
  );
}