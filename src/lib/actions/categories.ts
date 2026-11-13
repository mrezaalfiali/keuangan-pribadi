"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/src/lib/supabase/server";
import { computeSourceBalances, sourceSlug } from "@/src/lib/sources";

export interface CategoryResult {
  ok: boolean;
  error?: string;
}

interface SourceRow {
  id: string;
  user_id: string | null;
  slug: string;
  name_key: string | null;
  is_system: boolean;
}

interface OverrideRow {
  category_id: string;
  custom_name: string | null;
  hidden: boolean;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Nama yang terlihat oleh pemilik akun. Baris sistem memakai slug sebagai
 * perkiraan nama karena teks aslinya ada di messages (`cat.*`); cukup untuk
 * mencegah dua sumber tampil dengan nama yang sama.
 */
function visibleSourceName(source: SourceRow, overrides: Map<string, OverrideRow>): string {
  const custom = overrides.get(source.id)?.custom_name?.trim();
  if (custom) return custom;
  const literal = source.name_key?.trim();
  if (literal && !literal.startsWith("cat.")) return literal;
  return source.slug.replace(/-(in|ex)$/, "");
}

async function loadCategoryContext(
  supabase: Awaited<ReturnType<typeof createClient>>,
  userId: string,
  type: "income" | "expense"
) {
  const [{ data: rows, error: rowError }, { data: overrides, error: overrideError }] =
    await Promise.all([
      supabase
        .from("categories")
        .select("id, user_id, slug, name_key, is_system")
        .eq("type", type),
      supabase
        .from("category_overrides")
        .select("category_id, custom_name, hidden")
        .eq("user_id", userId),
    ]);
  if (rowError || overrideError) return null;

  return {
    categories: (rows ?? []) as SourceRow[],
    overrides: new Map((overrides ?? []).map((row) => [row.category_id, row as OverrideRow])),
  };
}

type CategoryContext = NonNullable<Awaited<ReturnType<typeof loadCategoryContext>>>;

/**
 * Kategori yang masih tampil dan namanya tidak bentrok dengan `slug` baru.
 * Kategori tersembunyi tidak menghalangi pembuatan/mengganti nama karena ia
 * sudah tidak ada di pilihan pengguna.
 */
function findCategoryConflict(context: CategoryContext, slug: string, excludeId?: string) {
  return context.categories.find((candidate) => {
    if (excludeId && candidate.id === excludeId) return false;
    if (context.overrides.get(candidate.id)?.hidden) return false;
    return (
      candidate.slug === slug ||
      sourceSlug(visibleSourceName(candidate, context.overrides)) === slug
    );
  });
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
  if (!name || name.length > 80) return { ok: false, error: "transactions.sourceName" };

  const slug = sourceSlug(name);
  if (!slug) return { ok: false, error: "transactions.sourceName" };

  const context = await loadCategoryContext(supabase, user.id, "income");
  if (!context) return { ok: false, error: "err.generic" };

  // Sumber sistem yang sudah di-hide tidak boleh menghalangi pengguna membuat
  // sumber baru dengan nama yang sama. Sumber yang masih tampil tetap dicek
  // dari slug maupun nama override agar tidak ada dua pilihan berlabel sama.
  const conflict = findCategoryConflict(context, slug);
  if (conflict) {
    return {
      ok: false,
      error: conflict.user_id === null ? "transactions.sourceNameTakenSystem" : "transactions.sourceExists",
    };
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
 * Mengubah nama sumber pemasukan untuk akun ini saja.
 *
 * Sumber milik pengguna diubah langsung. Sumber bawaan (`user_id is null`)
 * dicatat di `category_overrides` supaya akun lain tetap melihat nama aslinya.
 */
export async function updateIncomeSource(
  locale: string,
  categoryId: string,
  nameInput: string
): Promise<CategoryResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "err.auth" };
  if (!UUID_PATTERN.test(categoryId)) return { ok: false, error: "err.generic" };

  const name = nameInput.trim();
  if (!name) return { ok: false, error: "transactions.sourceName" };
  if (name.length > 80) return { ok: false, error: "transactions.sourceName" };

  const { data: source, error: sourceError } = await supabase
    .from("categories")
    .select("id, user_id, slug, name_key, is_system")
    .eq("id", categoryId)
    .eq("type", "income")
    .maybeSingle();
  if (sourceError) return { ok: false, error: "err.generic" };
  if (!source || (source.user_id !== null && source.user_id !== user.id)) {
    return { ok: false, error: "transactions.sourceNotFound" };
  }

  const context = await loadCategoryContext(supabase, user.id, "income");
  if (!context) return { ok: false, error: "err.generic" };

  const slug = sourceSlug(name);
  if (!slug) return { ok: false, error: "transactions.sourceName" };

  const conflict = findCategoryConflict(context, slug, categoryId);
  if (conflict) {
    return {
      ok: false,
      error: conflict.user_id === null ? "transactions.sourceNameTakenSystem" : "transactions.sourceExists",
    };
  }

  if (source.user_id === user.id) {
    const { error } = await supabase
      .from("categories")
      .update({ name_key: name })
      .eq("id", categoryId)
      .eq("user_id", user.id)
      .eq("type", "income");
    if (error) return { ok: false, error: "err.generic" };
  } else {
    const { error } = await supabase.from("category_overrides").upsert(
      {
        user_id: user.id,
        category_id: categoryId,
        custom_name: name,
        hidden: false,
      },
      { onConflict: "user_id,category_id" }
    );
    if (error) return { ok: false, error: "err.generic" };
  }

  revalidatePath(`/${locale}/dashboard`);
  revalidatePath(`/${locale}/transactions`);
  return { ok: true };
}

/**
 * Menghapus sumber pemasukan dari akun ini.
 *
 * Sumber milik pengguna dihapus permanen; sumber bawaan hanya di-hide lewat
 * `category_overrides`. Keduanya baru boleh dilakukan saat saldo sumber 0 agar
 * uang yang masih tersimpan tidak hilang dari tampilan. Sumber fallback
 * "Lainnya" tidak boleh dihapus karena dipakai validasi transaksi lama.
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
  if (!UUID_PATTERN.test(categoryId)) return { ok: false, error: "err.generic" };

  const { data: source, error: sourceError } = await supabase
    .from("categories")
    .select("id, user_id, slug, name_key, is_system")
    .eq("id", categoryId)
    .eq("type", "income")
    .maybeSingle();
  if (sourceError) return { ok: false, error: "err.generic" };
  if (!source || (source.user_id !== null && source.user_id !== user.id)) {
    return { ok: false, error: "transactions.sourceNotFound" };
  }

  if (source.user_id === null && (source.slug === "lainnya-in" || source.slug === "lainnya")) {
    return { ok: false, error: "transactions.sourceFallbackProtected" };
  }

  const { data: transactions, error: transactionError } = await supabase
    .from("transactions")
    .select("type, amount, category_id, funding_source_id")
    .eq("user_id", user.id);
  if (transactionError) return { ok: false, error: "err.generic" };

  const balance = computeSourceBalances(
    (transactions ?? []) as {
      type: string;
      amount: number;
      category_id: string | null;
      funding_source_id: string | null;
    }[],
    [source]
  ).get(source.id);
  if ((balance ?? 0) !== 0) {
    return { ok: false, error: "transactions.sourceHasBalance" };
  }

  // Jadwal berulang menyimpan id sumber, bukan namanya. Menghapus sumber yang
  // masih dipakai akan membuat transaksi berikutnya tidak punya sumber atau
  // masuk ke sumber yang sudah tidak terlihat.
  const { count: recurringCount, error: recurringError } = await supabase
    .from("recurring_transactions")
    .select("id", { count: "exact", head: true })
    .eq("user_id", user.id)
    .or(`category_id.eq.${categoryId},funding_source_id.eq.${categoryId}`);
  if (recurringError) return { ok: false, error: "err.generic" };
  if ((recurringCount ?? 0) > 0) {
    return { ok: false, error: "transactions.sourceUsedByRecurring" };
  }

  if (source.user_id === user.id) {
    const { error } = await supabase
      .from("categories")
      .delete()
      .eq("id", categoryId)
      .eq("user_id", user.id)
      .eq("type", "income")
      .eq("is_system", false);
    if (error) return { ok: false, error: "err.generic" };
  } else {
    const { data: existing, error: existingError } = await supabase
      .from("category_overrides")
      .select("custom_name")
      .eq("user_id", user.id)
      .eq("category_id", categoryId)
      .maybeSingle();
    if (existingError) return { ok: false, error: "err.generic" };

    const { error } = await supabase.from("category_overrides").upsert(
      {
        user_id: user.id,
        category_id: categoryId,
        custom_name: existing?.custom_name ?? null,
        hidden: true,
      },
      { onConflict: "user_id,category_id" }
    );
    if (error) return { ok: false, error: "err.generic" };
  }

  revalidatePath(`/${locale}/dashboard`);
  revalidatePath(`/${locale}/transactions`);
  return { ok: true };
}

/**
 * Membuat kategori pengeluaran baru sebagai baris `categories` bertipe expense.
 *
 * Pola identik dengan `createIncomeSource`: nama literal di `name_key` tanpa
 * prefiks `cat.` supaya `resolveLabel` membacanya sebagai teks biasa.
 */
export async function createExpenseCategory(
  locale: string,
  input: { name: string }
): Promise<CategoryResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "err.auth" };

  const name = input.name.trim();
  if (!name || name.length > 80) return { ok: false, error: "transactions.categoryName" };

  const slug = sourceSlug(name);
  if (!slug) return { ok: false, error: "transactions.categoryName" };

  const context = await loadCategoryContext(supabase, user.id, "expense");
  if (!context) return { ok: false, error: "err.generic" };

  const conflict = findCategoryConflict(context, slug);
  if (conflict) {
    return {
      ok: false,
      error:
        conflict.user_id === null
          ? "transactions.categoryNameTakenSystem"
          : "transactions.categoryExists",
    };
  }

  const { error } = await supabase.from("categories").insert({
    user_id: user.id,
    type: "expense",
    slug,
    name_key: name.slice(0, 80),
    icon: null,
    color: null,
    is_system: false,
  });
  if (error) {
    // 23505 = unique (user_id, slug) — nama kategori sudah dipakai.
    if (error.code === "23505") return { ok: false, error: "transactions.categoryExists" };
    return { ok: false, error: "err.generic" };
  }

  revalidatePath(`/${locale}/dashboard`);
  revalidatePath(`/${locale}/transactions`);
  return { ok: true };
}

/**
 * Mengubah nama kategori pengeluaran untuk akun ini saja.
 *
 * Kategori milik pengguna diubah langsung. Kategori bawaan (`user_id is null`)
 * dicatat di `category_overrides` supaya akun lain tetap melihat nama aslinya.
 */
export async function updateExpenseCategory(
  locale: string,
  categoryId: string,
  nameInput: string
): Promise<CategoryResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "err.auth" };
  if (!UUID_PATTERN.test(categoryId)) return { ok: false, error: "err.generic" };

  const name = nameInput.trim();
  if (!name || name.length > 80) return { ok: false, error: "transactions.categoryName" };

  const { data: row, error: rowError } = await supabase
    .from("categories")
    .select("id, user_id, slug, name_key, is_system")
    .eq("id", categoryId)
    .eq("type", "expense")
    .maybeSingle();
  if (rowError) return { ok: false, error: "err.generic" };
  if (!row || (row.user_id !== null && row.user_id !== user.id)) {
    return { ok: false, error: "transactions.categoryNotFound" };
  }

  const context = await loadCategoryContext(supabase, user.id, "expense");
  if (!context) return { ok: false, error: "err.generic" };

  const slug = sourceSlug(name);
  if (!slug) return { ok: false, error: "transactions.categoryName" };

  const conflict = findCategoryConflict(context, slug, categoryId);
  if (conflict) {
    return {
      ok: false,
      error:
        conflict.user_id === null
          ? "transactions.categoryNameTakenSystem"
          : "transactions.categoryExists",
    };
  }

  if (row.user_id === user.id) {
    const { error } = await supabase
      .from("categories")
      .update({ name_key: name })
      .eq("id", categoryId)
      .eq("user_id", user.id)
      .eq("type", "expense");
    if (error) return { ok: false, error: "err.generic" };
  } else {
    const { error } = await supabase.from("category_overrides").upsert(
      {
        user_id: user.id,
        category_id: categoryId,
        custom_name: name,
        hidden: false,
      },
      { onConflict: "user_id,category_id" }
    );
    if (error) return { ok: false, error: "err.generic" };
  }

  revalidatePath(`/${locale}/dashboard`);
  revalidatePath(`/${locale}/transactions`);
  return { ok: true };
}

/**
 * Menyembunyikan kategori pengeluaran dari daftar pilihan akun ini.
 *
 * Tidak ada baris yang dihapus: visibilitas dicatat di `category_overrides`
 * sehingga transaksi lama tetap menampilkan namanya dan "Tampilkan lagi"
 * cukup membalikkan flag-nya. Ditolak bila kategori masih dipakai jadwal
 * berulang atau batas anggaran agar tampilan data lain tidak kehilangan label.
 */
export async function hideExpenseCategory(
  locale: string,
  categoryId: string
): Promise<CategoryResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "err.auth" };
  if (!UUID_PATTERN.test(categoryId)) return { ok: false, error: "err.generic" };

  const { data: row, error: rowError } = await supabase
    .from("categories")
    .select("id, user_id, type")
    .eq("id", categoryId)
    .eq("type", "expense")
    .maybeSingle();
  if (rowError) return { ok: false, error: "err.generic" };
  if (!row || (row.user_id !== null && row.user_id !== user.id)) {
    return { ok: false, error: "transactions.categoryNotFound" };
  }

  const { count: recurringCount, error: recurringError } = await supabase
    .from("recurring_transactions")
    .select("id", { count: "exact", head: true })
    .eq("user_id", user.id)
    .eq("category_id", categoryId);
  if (recurringError) return { ok: false, error: "err.generic" };
  if ((recurringCount ?? 0) > 0) {
    return { ok: false, error: "transactions.categoryUsedByRecurring" };
  }

  const { count: budgetCount, error: budgetError } = await supabase
    .from("budgets")
    .select("id", { count: "exact", head: true })
    .eq("user_id", user.id)
    .eq("scope", "category")
    .eq("scope_id", categoryId);
  if (budgetError) return { ok: false, error: "err.generic" };
  if ((budgetCount ?? 0) > 0) {
    return { ok: false, error: "transactions.categoryUsedByBudget" };
  }

  const { data: existing, error: existingError } = await supabase
    .from("category_overrides")
    .select("custom_name")
    .eq("user_id", user.id)
    .eq("category_id", categoryId)
    .maybeSingle();
  if (existingError) return { ok: false, error: "err.generic" };

  const { error } = await supabase.from("category_overrides").upsert(
    {
      user_id: user.id,
      category_id: categoryId,
      custom_name: existing?.custom_name ?? null,
      hidden: true,
    },
    { onConflict: "user_id,category_id" }
  );
  if (error) return { ok: false, error: "err.generic" };

  revalidatePath(`/${locale}/dashboard`);
  revalidatePath(`/${locale}/transactions`);
  return { ok: true };
}

/**
 * Membatalkan penyembunyian kategori (flag `hidden` di `category_overrides`
 * dikembalikan ke false). Nama rename yang pernah dicatat tetap dipertahankan.
 */
export async function showCategory(locale: string, categoryId: string): Promise<CategoryResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "err.auth" };
  if (!UUID_PATTERN.test(categoryId)) return { ok: false, error: "err.generic" };

  const { data: row, error: rowError } = await supabase
    .from("categories")
    .select("id, user_id, type")
    .eq("id", categoryId)
    .eq("type", "expense")
    .maybeSingle();
  if (rowError) return { ok: false, error: "err.generic" };
  if (!row || (row.user_id !== null && row.user_id !== user.id)) {
    return { ok: false, error: "transactions.categoryNotFound" };
  }

  const { data: existing, error: existingError } = await supabase
    .from("category_overrides")
    .select("custom_name, hidden")
    .eq("user_id", user.id)
    .eq("category_id", categoryId)
    .maybeSingle();
  if (existingError) return { ok: false, error: "err.generic" };
  if (!existing) return { ok: true };

  const { error } = await supabase.from("category_overrides").upsert(
    {
      user_id: user.id,
      category_id: categoryId,
      custom_name: existing.custom_name,
      hidden: false,
    },
    { onConflict: "user_id,category_id" }
  );
  if (error) return { ok: false, error: "err.generic" };

  revalidatePath(`/${locale}/dashboard`);
  revalidatePath(`/${locale}/transactions`);
  return { ok: true };
}
