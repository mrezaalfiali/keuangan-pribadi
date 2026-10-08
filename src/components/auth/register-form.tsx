"use client";

import { useActionState } from "react";
import { useTranslations } from "next-intl";
import { signUpAction, type AuthState } from "@/src/lib/actions/auth";
import { LocaleSwitcher } from "@/src/components/locale-switcher";
import { Button } from "@/src/components/ui/button";
import { Field, Input } from "@/src/components/ui/input";
import { Link } from "@/src/i18n/navigation";

export function RegisterForm({ locale }: { locale: string }) {
  const t = useTranslations("auth");
  const common = useTranslations("common");
  const [state, action, pending] = useActionState(
    signUpAction.bind(null, locale),
    { message: null, error: null } satisfies AuthState
  );

  return (
    <form action={action} className="flex flex-col gap-5 p-7">
      <h2 className="font-display text-xl font-semibold tracking-tight text-ink">
        {t("registerTitle")}
      </h2>
      <Field label={t("name")} hint={common("optional")}>
        <Input type="text" name="name" autoComplete="name" />
      </Field>
      <Field label={t("email")}>
        <Input type="email" name="email" autoComplete="email" required />
      </Field>
      <Field label={t("password")} hint="min. 6">
        <Input type="password" name="password" autoComplete="new-password" minLength={6} required />
      </Field>
      {state.error && <p className="text-sm text-danger">{t(state.error)}</p>}
      {state.message && <p role="status" className="text-sm text-accent">{t(state.message)}</p>}
      <Button type="submit" disabled={pending} size="lg" className="w-full">
        {pending ? "…" : t("signUp")}
      </Button>
      <p className="text-center text-sm text-muted">
        {t("hasAccount")}{" "}
        <Link href="/login" className="font-semibold text-accent hover:underline">
          {t("signInHere")}
        </Link>
      </p>
      <div className="flex justify-center pt-2">
        <LocaleSwitcher />
      </div>
    </form>
  );
}