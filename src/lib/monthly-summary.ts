export interface MonthlySummaryTransaction {
  type: "income" | "expense" | "transfer";
  amount: number;
  date: string;
  category_id: string | null;
  category?: { id: string; name_key: string | null; slug: string } | null;
}

export interface MonthlySummary {
  income: number;
  expense: number;
  balanceChange: number;
  expensesByCategory: Array<{
    id: string | null;
    category: MonthlySummaryTransaction["category"];
    amount: number;
  }>;
}

export function buildMonthlySummary(
  transactions: MonthlySummaryTransaction[],
  month: string
): MonthlySummary {
  let income = 0;
  let expense = 0;
  const categoryExpenses = new Map<
    string | null,
    {
      category: MonthlySummaryTransaction["category"];
      amount: number;
    }
  >();

  for (const transaction of transactions) {
    if (!transaction.date.startsWith(month)) continue;

    if (transaction.type === "income") {
      income += transaction.amount;
    } else if (transaction.type === "expense") {
      expense += transaction.amount;
      const id = transaction.category_id;
      const current = categoryExpenses.get(id);
      categoryExpenses.set(id, {
        category: current?.category ?? transaction.category ?? null,
        amount: (current?.amount ?? 0) + transaction.amount,
      });
    }
  }

  return {
    income,
    expense,
    balanceChange: income - expense,
    expensesByCategory: [...categoryExpenses.entries()]
      .map(([id, value]) => ({ id, ...value }))
      .sort((a, b) => b.amount - a.amount),
  };
}

export function shiftMonth(month: string, offset: number): string {
  const year = Number(month.slice(0, 4));
  const monthIndex = Number(month.slice(5, 7)) - 1;
  const shifted = new Date(Date.UTC(year, monthIndex + offset, 1));
  return `${shifted.getUTCFullYear()}-${`${shifted.getUTCMonth() + 1}`.padStart(2, "0")}`;
}
