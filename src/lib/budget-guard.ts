import type { SupabaseClient } from "@supabase/supabase-js";
import {
  findExceededBudget,
  type BudgetConflict,
  type ExpenseCandidate,
} from "@/src/lib/budget";

export type BudgetGuardResult =
  | { ok: true }
  | { ok: false; error: "err.generic" }
  | { ok: false; conflict: BudgetConflict };

export interface BudgetRejection {
  error: "transactions.budgetExceededCategory" | "transactions.budgetExceededVault";
  budget: { scope: "category" | "vault"; remaining: number };
}

/** Ubah konflik anggaran menjadi kode error + sisa untuk ditampilkan UI. */
export function budgetRejection(conflict: BudgetConflict): BudgetRejection {
  return {
    error:
      conflict.budget.scope === "category"
        ? "transactions.budgetExceededCategory"
        : "transactions.budgetExceededVault",
    budget: { scope: conflict.budget.scope, remaining: conflict.remaining },
  };
}

/**
 * Validasi pengeluaran terhadap seluruh anggaran yang periodenya mencakup
 * tanggal transaksi. Dipakai sebelum insert maupun RPC edit agar batas anggaran
 * tidak bisa dilewati lewat salah satu jalur saja.
 */
export async function checkExpenseBudget(
  supabase: SupabaseClient,
  userId: string,
  candidate: ExpenseCandidate,
  excludeTransactionId?: number
): Promise<BudgetGuardResult> {
  const { data: budgets, error: budgetError } = await supabase
    .from("budgets")
    .select("id, scope, scope_id, limit_amount, starts_on, ends_on")
    .eq("user_id", userId)
    .lte("starts_on", candidate.date)
    .gte("ends_on", candidate.date);
  if (budgetError) return { ok: false, error: "err.generic" };
  if (!budgets?.length) return { ok: true };

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
    }[],
    candidate,
    excludeTransactionId
  );

  if (conflict) return { ok: false, conflict };
  return { ok: true };
}
