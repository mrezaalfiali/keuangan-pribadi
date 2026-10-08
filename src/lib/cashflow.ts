/**
 * Deriving the cash-flow series the dashboard chart plots.
 *
 * Months are built from an explicit window rather than from the transactions
 * that happen to exist, so a gap in the middle of the year renders as a real
 * zero rather than collapsing two months into one bar. A chart that silently
 * drops empty months reads as "no spending happened", which is a different
 * claim from "nothing was recorded".
 */

export interface CashflowTransaction {
  type: "income" | "expense" | "transfer";
  amount: number;
  date: string;
}

export interface CashflowMonth {
  /** YYYY-MM, so it sorts and compares as a plain string. */
  month: string;
  income: number;
  expense: number;
  /** income - expense. Transfers are excluded from both sides. */
  net: number;
}

/** Shift a YYYY-MM key by `offset` months, rolling across year boundaries. */
function shiftMonth(month: string, offset: number): string {
  const year = Number(month.slice(0, 4));
  const index = Number(month.slice(5, 7)) - 1;
  const shifted = new Date(Date.UTC(year, index + offset, 1));
  return `${shifted.getUTCFullYear()}-${`${shifted.getUTCMonth() + 1}`.padStart(2, "0")}`;
}

/**
 * The last `count` months ending at `endMonth`, oldest first.
 *
 * `endMonth` is the current month by default and is the anchor the whole window
 * hangs off, so the caller does not have to reconcile a real end-of-month date
 * against month keys.
 */
export function recentMonths(endMonth: string, count = 12): string[] {
  const months: string[] = [];
  for (let offset = -(count - 1); offset <= 0; offset += 1) {
    months.push(shiftMonth(endMonth, offset));
  }
  return months;
}

/** Sum income and expense per month across the window, zero-filling gaps. */
export function buildCashflow(
  transactions: CashflowTransaction[],
  endMonth: string,
  count = 12
): CashflowMonth[] {
  const months = recentMonths(endMonth, count);
  const buckets = new Map<string, { income: number; expense: number }>(
    months.map((month) => [month, { income: 0, expense: 0 }])
  );

  for (const tx of transactions) {
    const bucket = buckets.get(tx.date.slice(0, 7));
    if (!bucket) continue;
    if (tx.type === "income") bucket.income += tx.amount;
    else if (tx.type === "expense") bucket.expense += tx.amount;
  }

  return months.map((month) => {
    const { income, expense } = buckets.get(month)!;
    return { month, income, expense, net: income - expense };
  });
}

/** Whether the window holds any movement at all, for the chart's empty state. */
export function hasCashflowActivity(series: CashflowMonth[]): boolean {
  return series.some((month) => month.income !== 0 || month.expense !== 0);
}
