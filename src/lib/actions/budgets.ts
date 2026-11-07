"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/src/lib/supabase/server";
import {
  aggregateBorrows,
  budgetEffectiveLimit,
  budgetLeftover,
  budgetSpend,
  isValidPeriod,
  nextPeriod,
  type BudgetBorrowRow,
  type BudgetPeriod,
} from "@/src/lib/budget";

export interface ActionResult {
  ok: boolean;
  error?: string;
}

function isISODate(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

export async function saveBudget(
  locale: string,
  input: {
    scope: "category" | "vault";
    scopeId: string;
    startsOn: string;
    endsOn: string;
    limit: number;
    threshold?: number;
  }
): Promise<ActionResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "err.auth" };

  if (!isISODate(input.startsOn) || !isISODate(input.endsOn)) {
    return { ok: false, error: "err.period" };
  }
  if (!isValidPeriod({ startsOn: input.startsOn, endsOn: input.endsOn })) {
    return { ok: false, error: "err.periodRange" };
  }

  const limit = Math.trunc(input.limit);
  if (limit <= 0) return { ok: false, error: "err.amount" };

  const { error } = await supabase.from("budgets").upsert(
    {
      user_id: user.id,
      scope: input.scope,
      scope_id: input.scopeId,
      starts_on: input.startsOn,
      ends_on: input.endsOn,
      limit_amount: limit,
      alert_threshold: input.threshold ?? 0.8,
    },
    { onConflict: "user_id,scope,scope_id,starts_on" }
  );
  if (error) return { ok: false, error: "err.generic" };

  revalidatePath(`/${locale}/budgets`);
  return { ok: true };
}

/**
 * Menyalin batas dan periode ke periode berikutnya untuk scope yang sama.
 *
 * Uniqueness ada di `starts_on`, jadi menyalin ke periode yang sudah ada berarti
 * menimpa batasnya — itulah perilaku yang diinginkan tombol "salin periode".
 */
export async function copyBudgetPeriod(
  locale: string,
  budgetId: string,
  period: BudgetPeriod
): Promise<ActionResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "err.auth" };

  if (!isISODate(period.startsOn) || !isISODate(period.endsOn)) {
    return { ok: false, error: "err.period" };
  }
  if (!isValidPeriod(period)) return { ok: false, error: "err.periodRange" };

  const { data: source, error: sourceError } = await supabase
    .from("budgets")
    .select("scope, scope_id, limit_amount, alert_threshold")
    .eq("id", budgetId)
    .eq("user_id", user.id)
    .single();
  if (sourceError || !source) return { ok: false, error: "err.generic" };

  const { error } = await supabase.from("budgets").upsert(
    {
      user_id: user.id,
      scope: source.scope,
      scope_id: source.scope_id,
      starts_on: period.startsOn,
      ends_on: period.endsOn,
      limit_amount: source.limit_amount,
      alert_threshold: source.alert_threshold,
    },
    { onConflict: "user_id,scope,scope_id,starts_on" }
  );
  if (error) return { ok: false, error: "err.generic" };

  revalidatePath(`/${locale}/budgets`);
  return { ok: true };
}

/**
 * Membawa sisa periode yang sudah berakhir ke periode berikutnya.
 *
 * Sisa menambah *batas* periode berikutnya, tidak memindahkan uang: tidak ada
 * transaksi yang dibuat, jadi tidak ada yang bisa terduplikasi di ledger dan
 * tidak perlu rollback kalau salah klik.
 *
 * `limit_amount` periode berikutnya = batas yang sudah ada di sana (bila user
 * pernah menyiapkannya) + sisa. Kalau periode berikutnya belum ada, batasnya
 * disalin dari periode sumber supaya tidak melompat dari nol.
 *
 * Idempotensi: satu periode hanya bisa jadi sumber satu kali. Dicek lewat
 * `rolled_over_from`, dengan unique partial index di database sebagai jaring
  pengaman terakhir bila dua klik benar-benar launched bersamaan. Karena itu
 * penanda itu juga ditulis saat periode berikutnya sudah ada sebelumnya: kalau
 * hanya `limit_amount` yang diubah, baris itu tidak akan pernah terlihat oleh
 * cek di bawah dan klik berikutnya akan menambah sisa untuk kedua kali.
 */
export async function carryOverBudget(
  locale: string,
  budgetId: string
): Promise<ActionResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "err.auth" };

  const { data: source, error: sourceError } = await supabase
    .from("budgets")
    .select("id, scope, scope_id, starts_on, ends_on, limit_amount, alert_threshold, leftover_discarded")
    .eq("id", budgetId)
    .eq("user_id", user.id)
    .single();
  if (sourceError || !source) return { ok: false, error: "err.generic" };

  const period = nextPeriod({ startsOn: source.starts_on, endsOn: source.ends_on });
  // `nextPeriod` sudah menjamin rentangnya valid, tapi penjaga ini tetap
  // dipasang: satu pemeriksaan murah lebih baik daripada mengandalkan CHECK
  // database yang hanya muncul sebagai `err.generic` tanpa penjelasan.
  if (!period || !isValidPeriod(period)) return { ok: false, error: "err.periodRange" };

  // Sisa dihitung ulang dari ledger, tidak pernah dari nilai yang disimpan di UI.
  const { data: spent, error: spentError } = await supabase
    .from("transactions")
    .select("type, amount, category_id, vault_id, date")
    .eq("user_id", user.id)
    .eq("type", "expense")
    .gte("date", source.starts_on)
    .lte("date", source.ends_on);
  if (spentError) return { ok: false, error: "err.generic" };

  const spentTotal = budgetSpend(
    (spent ?? []).map((tx) => ({
      type: tx.type,
      amount: tx.amount,
      category_id: tx.category_id,
      vault_id: tx.vault_id,
      date: tx.date,
    })),
    {
      scope: source.scope,
      scope_id: source.scope_id,
      starts_on: source.starts_on,
      ends_on: source.ends_on,
    }
  );

  // Pinjaman pada periode sumber ikut menggeser sisa yang boleh dibawa:
  // yang dipinjamkan keluar berkurang, yang masuk bertambah. Tanpa ini,
  // pemberi yang sudah meminjamkan sebagian sisanya justru membawa sisa
  // yang nyatanya sudah dipakai peminjam, dan total hemat jadi tidak
  // konsisten. Tabel pinjaman dari migrasi 0028 -- kalau belum ada,
  // dihitung tanpa pinjaman seperti sebelumnya.
  const { data: borrowRows, error: borrowError } = await supabase
    .from("budget_borrows")
    .select("from_budget_id, to_budget_id, amount")
    .eq("user_id", user.id);
  if (borrowError) {
    console.error("Supabase budget borrow load failed during carry-over.", borrowError);
  }
  const borrowTotals = aggregateBorrows((borrowRows ?? []) as BudgetBorrowRow[]).get(
    source.id
  );

  // Sisa yang sudah ditutup tidak boleh terbawa: kuotanya sudah dianggap
  // dialihkan, jadi periode berikutnya hanya menerima batas dasarnya saja.
  const leftover = source.leftover_discarded
    ? 0
    : budgetLeftover(budgetEffectiveLimit(source, spentTotal, borrowTotals), spentTotal);
  if (leftover <= 0) return { ok: false, error: "err.noLeftover" };

  const { data: alreadyCarried } = await supabase
    .from("budgets")
    .select("id")
    .eq("user_id", user.id)
    .eq("rolled_over_from", source.id)
    .maybeSingle();
  if (alreadyCarried) return { ok: false, error: "err.alreadyRolledOver" };

  const { data: existing, error: existingError } = await supabase
    .from("budgets")
    .select("id, limit_amount, rolled_over_from")
    .eq("user_id", user.id)
    .eq("scope", source.scope)
    .eq("scope_id", source.scope_id)
    .eq("starts_on", period.startsOn)
    .maybeSingle();
  if (existingError) return { ok: false, error: "err.generic" };

  // Periode berikutnya sudah membawa sisa dari periode yang lain. Menimpa
  // `rolled_over_from`-nya di sini akan menghapus jejaknya, dan sisa periode ini
  // lalu bisa ditambahkan lagi di klik berikutnya.
  if (existing?.rolled_over_from) return { ok: false, error: "err.rolloverTargetTaken" };

  const baseLimit = existing ? existing.limit_amount : source.limit_amount;

  if (existing) {
    // `rolled_over_from` wajib ikut ditulis: tanpa itu cek `alreadyCarried` di
    // bawah tidak akan pernah menemukan baris ini, dan setiap klik berikutnya
    // akan menambah sisa lagi ke batas yang sama.
    const { error } = await supabase
      .from("budgets")
      .update({ limit_amount: baseLimit + leftover, rolled_over_from: source.id, leftover_discarded: false })
      .eq("id", existing.id)
      .eq("user_id", user.id)
      .is("rolled_over_from", null);
    if (error) return { ok: false, error: "err.generic" };
  } else {
    const { error } = await supabase.from("budgets").insert({
      user_id: user.id,
      scope: source.scope,
      scope_id: source.scope_id,
      starts_on: period.startsOn,
      ends_on: period.endsOn,
      limit_amount: baseLimit + leftover,
      alert_threshold: source.alert_threshold,
      rolled_over_from: source.id,
    });
    if (error) return { ok: false, error: "err.generic" };
  }

  revalidatePath(`/${locale}/budgets`);
  return { ok: true };
}

/**
 * Menutup sisa anggaran (`discarded = true`) atau membukanya kembali.
 *
 * Untuk periode berakhir artinya sisa tidak dibawa ke periode berikutnya. Untuk
 * anggaran berjalan artinya sisa dicabut sekarang: batas efektif turun ke angka
 * terpakai, statusnya jadi "penuh", dan pengeluaran baru ditolak guard anggaran.
 *
 * Tidak memindahkan uang -- transfer tetap aksi terpisah di form Transfer,
 * dan tidak mengubah `limit_amount` -- batas asli dipakai lagi saat "Batal tutup"
 * atau saat periode berikutnya dibuat.
 */
export async function setLeftoverDiscarded(
  locale: string,
  budgetId: string,
  discarded: boolean
): Promise<ActionResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "err.auth" };

  const { error } = await supabase
    .from("budgets")
    .update({ leftover_discarded: discarded })
    .eq("id", budgetId)
    .eq("user_id", user.id);
  if (error) return { ok: false, error: "err.generic" };

  revalidatePath(`/${locale}/budgets`);
  revalidatePath(`/${locale}/dashboard`);
  return { ok: true };
}

/**
 * Menghapus satu anggaran.
 *
 * Filter `user_id` ditulis eksplisit walau RLS sudah menjaganya, supaya baris
 * tidak ikut terhapus bila policy suatu saat berubah.
 */
export async function deleteBudget(
  locale: string,
  budgetId: string
): Promise<ActionResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "err.auth" };

  const { error } = await supabase
    .from("budgets")
    .delete()
    .eq("id", budgetId)
    .eq("user_id", user.id);
  if (error) return { ok: false, error: "err.generic" };

  revalidatePath(`/${locale}/budgets`);
  return { ok: true };
}

export interface BorrowResult {
  ok: boolean;
  error?: string;
  /** Id baris pinjaman -- diteruskan ke `addTransaction` untuk ditautkan. */
  borrowId?: string;
}

/**
 * Mencatat pinjaman sisa antar anggaran pada periode yang sama.
 *
 * `limit_amount` kedua pihak tidak disentuh: yang berubah hanya batas
 * efektif baris terkait (lihat `budgetEffectiveLimit`). Semua syarat
 * divalidasi ulang di server -- UI hanya memilih dan menampilkan nominal.
 *
 * `transactionId` diisi saat transaksi yang memicunya sudah ada (alur
 * edit). Alur tambah mengirim null lalu menautkannya lewat `addTransaction`.
 */
export async function borrowBudget(
  locale: string,
  input: {
    borrowerBudgetId: string;
    lenderBudgetId: string;
    /** Tanggal transaksi; kedua anggaran wajib mencakupnya. */
    date: string;
    amount: number;
    transactionId?: number | null;
  }
): Promise<BorrowResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "err.auth" };

  if (input.borrowerBudgetId === input.lenderBudgetId) {
    return { ok: false, error: "err.borrowSame" };
  }
  if (!isISODate(input.date)) return { ok: false, error: "err.period" };
  if (!Number.isSafeInteger(input.amount) || input.amount <= 0) {
    return { ok: false, error: "err.borrowAmount" };
  }

  const { data: budgets, error: budgetError } = await supabase
    .from("budgets")
    .select("id, scope, scope_id, limit_amount, starts_on, ends_on, leftover_discarded")
    .in("id", [input.borrowerBudgetId, input.lenderBudgetId])
    .eq("user_id", user.id);
  if (budgetError) return { ok: false, error: "err.generic" };
  const borrower = (budgets ?? []).find((row) => row.id === input.borrowerBudgetId);
  const lender = (budgets ?? []).find((row) => row.id === input.lenderBudgetId);
  if (!borrower || !lender) return { ok: false, error: "err.borrowNotFound" };

  // Kedua periodenya harus mencakup tanggal transaksi yang sedang ditolak;
  // pinjaman sendiri bebas lintas scope (kategori boleh dari vault).
  if (
    input.date < borrower.starts_on ||
    input.date > borrower.ends_on ||
    input.date < lender.starts_on ||
    input.date > lender.ends_on
  ) {
    return { ok: false, error: "err.borrowPeriod" };
  }
  // Sisa yang sudah ditutup berarti keputusan eksplisit: kuotanya sudah
  // dialihkan, jadi tidak boleh jadi peminjam maupun pemberi.
  if (borrower.leftover_discarded || lender.leftover_discarded) {
    return { ok: false, error: "err.borrowDiscarded" };
  }

  // Sisa pemberi dihitung ulang dari ledger dan pinjaman yang sudah
  // berjalan -- tidak pernah dari angka yang dikirim UI.
  const [spentResult, borrowResult] = await Promise.all([
    supabase
      .from("transactions")
      .select("type, amount, category_id, vault_id, date")
      .eq("user_id", user.id)
      .eq("type", "expense")
      .gte("date", lender.starts_on)
      .lte("date", lender.ends_on),
    supabase
      .from("budget_borrows")
      .select("from_budget_id, to_budget_id, amount")
      .eq("user_id", user.id),
  ]);
  if (spentResult.error || borrowResult.error) {
    if (borrowResult.error) {
      console.error("Supabase budget borrow load failed.", borrowResult.error);
    }
    return { ok: false, error: "err.generic" };
  }

  const lenderSpent = budgetSpend(spentResult.data ?? [], lender);
  const lenderTotals = aggregateBorrows(
    (borrowResult.data ?? []) as BudgetBorrowRow[]
  ).get(lender.id);
  const remaining = budgetLeftover(
    budgetEffectiveLimit(lender, lenderSpent, lenderTotals),
    lenderSpent
  );
  if (input.amount > remaining) return { ok: false, error: "err.borrowRemaining" };

  const { data: inserted, error: insertError } = await supabase
    .from("budget_borrows")
    .insert({
      user_id: user.id,
      from_budget_id: lender.id,
      to_budget_id: borrower.id,
      transaction_id: input.transactionId ?? null,
      amount: input.amount,
    })
    .select("id")
    .single();
  if (insertError || !inserted) {
    if (insertError) console.error("Supabase budget borrow insert failed.", insertError);
    return { ok: false, error: "err.generic" };
  }

  revalidatePath(`/${locale}/budgets`);
  revalidatePath(`/${locale}/dashboard`);
  return { ok: true, borrowId: inserted.id };
}

/**
 * Membatalkan satu pinjaman: sisa pemberi pulih, ruang peminjam menyusut
 * kembali. Pinjaman yang menautkan transaksi tetap bisa dibatalkan manual
 * -- yang terpakai tinggal membatalkan sendiri lewat tombol ini.
 */
export async function deleteBorrow(
  locale: string,
  borrowId: string
): Promise<ActionResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "err.auth" };

  const { error } = await supabase
    .from("budget_borrows")
    .delete()
    .eq("id", borrowId)
    .eq("user_id", user.id);
  if (error) return { ok: false, error: "err.generic" };

  revalidatePath(`/${locale}/budgets`);
  revalidatePath(`/${locale}/dashboard`);
  return { ok: true };
}
