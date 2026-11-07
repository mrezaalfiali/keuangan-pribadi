import type { SupabaseClient } from "@supabase/supabase-js";
import {
  aggregateBorrows,
  findExceededBudget,
  type BudgetBorrowRow,
  type BudgetConflict,
  type ExpenseCandidate,
} from "@/src/lib/budget";

export type BudgetGuardResult =
  | { ok: true }
  | { ok: false; error: "err.generic" }
  | { ok: false; conflict: BudgetConflict };

export interface BudgetRejection {
  error: "transactions.budgetExceededCategory" | "transactions.budgetExceededVault";
  budget: {
    scope: "category" | "vault";
    remaining: number;
    /** Baris anggaran yang tertolak -- dipakai UI sebagai peminjam. */
    id: string;
    /** Berapa yang kurang setelah sisa yang ada dipakai; dasar nominal pinjaman. */
    shortfall: number;
  };
}

/** Ubah konflik anggaran menjadi kode error + sisa untuk ditampilkan UI. */
export function budgetRejection(conflict: BudgetConflict): BudgetRejection {
  return {
    error:
      conflict.budget.scope === "category"
        ? "transactions.budgetExceededCategory"
        : "transactions.budgetExceededVault",
    budget: {
      scope: conflict.budget.scope,
      remaining: conflict.remaining,
      id: conflict.budget.id,
      shortfall: Math.max(0, conflict.projected - conflict.effectiveLimit),
    },
  };
}

/**
 * Validasi pengeluaran terhadap seluruh anggaran yang periodenya mencakup
 * tanggal transaksi. Dipakai sebelum insert maupun RPC edit agar batas anggaran
 * tidak bisa dilewati lewat salah satu jalur saja.
 *
 * Pinjaman yang sedang berjalan ikut diperhitungkan lewat batas efektif.
 * Tabel `budget_borrows` datang dari migrasi 0028 yang dijalankan manual;
 * kalau belum ada, hitung tanpa pinjaman supaya simpan transaksi tidak ikut
 * terkunci.
 */
export async function checkExpenseBudget(
  supabase: SupabaseClient,
  userId: string,
  candidate: ExpenseCandidate,
  excludeTransactionId?: number
): Promise<BudgetGuardResult> {
  const { data: budgets, error: budgetError } = await supabase
    .from("budgets")
    .select("id, scope, scope_id, limit_amount, starts_on, ends_on, leftover_discarded")
    .eq("user_id", userId)
    .lte("starts_on", candidate.date)
    .gte("ends_on", candidate.date);
  if (budgetError) return { ok: false, error: "err.generic" };
  if (!budgets?.length) return { ok: true };

  const { data: borrowRows, error: borrowError } = await supabase
    .from("budget_borrows")
    .select("from_budget_id, to_budget_id, amount")
    .eq("user_id", userId);
  if (borrowError) {
    console.error("Supabase budget borrow load failed during guard.", borrowError);
  }
  const borrows = aggregateBorrows((borrowRows ?? []) as BudgetBorrowRow[]);

  const startsOn = budgets.reduce(
    (earliest, budget) => (budget.starts_on < earliest ? budget.starts_on : earliest),
    budgets[0].starts_on
  );
  const endsOn = budgets.reduce(
    (latest, budget) => (budget.ends_on > latest ? budget.ends_on : latest),
    budgets[0].ends_on
  );

  const { data: transactions, error: transactionError } = await supabase
    .from("transactions")
    .select("id, type, amount, category_id, vault_id, date")
    .eq("user_id", userId)
    .eq("type", "expense")
    .gte("date", startsOn)
    .lte("date", endsOn);
  if (transactionError) return { ok: false, error: "err.generic" };

  const conflict = findExceededBudget(
    (transactions ?? []) as {
      id: number;
      type: "expense";
      amount: number;
      category_id: string | null;
      vault_id: string | null;
      date: string;
    }[],
    budgets as {
      id: string;
      scope: "category" | "vault";
      scope_id: string;
      limit_amount: number;
      starts_on: string;
      ends_on: string;
      leftover_discarded?: boolean;
    }[],
    candidate,
    excludeTransactionId,
    borrows
  );

  if (conflict) return { ok: false, conflict };
  return { ok: true };
}
