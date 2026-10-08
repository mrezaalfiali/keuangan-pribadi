"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { createClient } from "@/src/lib/supabase/server";
import { routing } from "@/src/i18n/routing";

export interface AuthState {
  message: string | null;
  error: string | null;
}

export async function signInAction(
  locale: string,
  prevState: AuthState,
  formData: FormData
): Promise<AuthState> {
  const supabase = await createClient();
  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  const password = String(formData.get("password") ?? "");

  if (!email || !password) {
    return { message: null, error: "invalid" };
  }

  const { error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) {
    if (error.code === "email_not_confirmed") {
      return { message: null, error: "emailNotConfirmed" };
    }
    if (error.code !== "invalid_credentials") {
      console.error("Supabase sign-in failed.", {
        code: error.code,
        status: error.status,
      });
      return { message: null, error: "connectionError" };
    }
    return { message: null, error: "error" };
  }

  redirect(`/${locale}/dashboard`);
}

export async function signUpAction(
  locale: string,
  prevState: AuthState,
  formData: FormData
): Promise<AuthState> {
  const supabase = await createClient();
  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  const password = String(formData.get("password") ?? "");
  const name = String(formData.get("name") ?? "");

  if (!email || password.length < 6) {
    return { message: null, error: "invalid" };
  }

  const requestHeaders = await headers();
  const origin =
    requestHeaders.get("origin") ??
    process.env.NEXT_PUBLIC_SITE_URL ??
    "http://localhost:3000";
  const { data, error } = await supabase.auth.signUp({
    email,
    password,
    options: {
      emailRedirectTo: `${origin}/auth/callback?next=/${locale}/dashboard`,
      data: { display_name: name || email.split("@")[0] },
    },
  });
  if (error || !data.user) {
    if (error) {
      console.error("Supabase sign-up failed.", {
        code: error.code,
        status: error.status,
      });
    }
    return { message: null, error: "registerError" };
  }

  if (data.session) {
    const { error: profileError } = await supabase.from("profiles").upsert({
      id: data.user.id,
      display_name: name || email.split("@")[0],
    });
    if (profileError) {
      console.error("Supabase profile creation failed.", profileError);
      return { message: null, error: "registerError" };
    }
    redirect(`/${locale}/dashboard`);
  }

  return { message: "confirmEmail", error: null };
}

export async function signOutAction() {
  const supabase = await createClient();
  const { error } = await supabase.auth.signOut();
  if (error) throw error;
  redirect(`/${routing.defaultLocale}/login`);
}