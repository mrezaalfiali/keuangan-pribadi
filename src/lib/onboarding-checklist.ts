import { budgetState } from "@/src/lib/budget";
import type { Budget, Transaction, Vault } from "@/src/lib/types";

export type OnboardingStepId = "transaction" | "vault" | "budget";

export interface OnboardingStep {
  id: OnboardingStepId;
  complete: boolean;
  href: "/transactions" | "/vaults" | "/budgets";
}

export function getOnboardingSteps(
  transactions: Pick<Transaction, "type">[],
  vaults: Pick<Vault, "id">[],
  budgets: Pick<Budget, "starts_on" | "ends_on">[],
  today: string
): OnboardingStep[] {
  return [
    {
      id: "transaction",
      complete: transactions.some((transaction) => transaction.type === "income" || transaction.type === "expense"),
      href: "/transactions",
    },
    {
      id: "vault",
      complete: vaults.length > 0,
      href: "/vaults",
    },
    {
      id: "budget",
      complete: budgets.some((budget) => budgetState(budget, today) === "active"),
      href: "/budgets",
    },
  ];
}
