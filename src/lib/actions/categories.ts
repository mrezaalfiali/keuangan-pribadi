"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/src/lib/supabase/server";
import { sourceSlug } from "@/src/lib/sources";

export interface CategoryResult {
  ok: boolean;
  error?: string;
}

/**
 * Membuat sumber pemasukan baru sebagai baris `categories` bertipe income.
 *
 * Nama disimpan di `name_key` tanpa prefiks `cat.` supaya UI membacanya sebagai
 * teks literal, bukan kunci translasi. `slug` dibuat dari nama yang sama agar
 * dua sumber berbeda nama tidak saling menimpa (unique per user_id).
 */
export async function createIncomeSource(
  locale: string,
  input: {
    name: string;
    icon?: string | null;
    color?: string | null;
  }
): Promise<CategoryResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "err.auth" };

  const name = input.name.trim();
  if (!name) return { ok: false, error: "transactions.sourceName" };

  const slug = sourceSlug(name);
  if (!slug) return { ok: false, error: "transactions.sourceName" };

  // Cek bentrok dengan kategori sistem di sini, bukan hanya mengandalkan 23505.
  //
  // Unique constraint 0001 itu `(coalesce(user_id, zero_uuid), slug)`: baris
  // sistem punya `user_id` NULL, jadi slug yang sama milik pengguna lain TIDAK
  // bentrok dengannya di database. Artinya "Investasi" bisa muncul dua kali di
  // daftar — satu bawaan, satu milik user — dan keduanya akan tampil sebagai
  // pilihan yang tidak bisa dibedakan. Menolak lebih awal dengan pesan yang
  // menyebut nama aslinya jauh lebih berguna daripada 23505 yang kalau
  // dibiarkan hanya jadi "terjadi kesalahan".
  const { data: systemSource, error: systemError } = await supabase
    .from("categories")
    .select("slug")
    .eq("type", "income")
    .eq("slug", slug)
    .is("user_id", null)
    .limit(1)
    .maybeSingle();
  if (systemError) return { ok: false, error: "err.generic" };
  if (systemSource) {
    // Nama dikirim terpisah (state form), bukan ditanam di dalam kode error,
    // supaya kodenya tetap cocok dengan key di messages/*.json.
    return { ok: false, error: "transactions.sourceNameTakenSystem" };
  }

  const { error } = await supabase.from("categories").insert({
    user_id: user.id,
    type: "income",
    slug,
    name_key: name.slice(0, 80),
    icon: input.icon ?? null,
    color: input.color ?? null,
    is_system: false,
  });
  if (error) {
    // 23505 = unique (user_id, slug) — nama sumber sudah dipakai.
    if (error.code === "23505") return { ok: false, error: "transactions.sourceExists" };
    return { ok: false, error: "err.generic" };
  }

  revalidatePath(`/${locale}/dashboard`);
  revalidatePath(`/${locale}/transactions`);
  return { ok: true };
}

/**
 * Menghapus sumber pemasukan milik pengguna. Baris expense yang memakainya tetap
 * ada karena FK 0004 memakai ON DELETE SET NULL.
 */
export async function deleteIncomeSource(
  locale: string,
  categoryId: string
): Promise<CategoryResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "err.auth" };

  const { error } = await supabase
    .from("categories")
    .delete()
    .eq("id", categoryId)
    .eq("user_id", user.id)
    .eq("type", "income")
    .eq("is_system", false);
  if (error) return { ok: false, error: "err.generic" };

  revalidatePath(`/${locale}/dashboard`);
  revalidatePath(`/${locale}/transactions`);
  return { ok: true };
}