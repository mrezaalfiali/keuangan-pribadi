export interface FilterableTransaction {
  type: string;
  date: string;
  amount: number;
  category_id: string | null;
  funding_source_id: string | null;
  vault_id: string | null;
}

export interface TransactionFilters {
  type: "" | "income" | "expense";
  fromDate: string;
  toDate: string;
  minAmount: string;
  maxAmount: string;
  categoryId: string;
  fundingSourceId: string;
  vaultId: string;
  search: string;
}

export function filterTransactions<T extends FilterableTransaction>(
  transactions: T[],
  filters: TransactionFilters,
  searchableText: (transaction: T) => string
): T[] {
  const minAmount = filters.minAmount.trim() === "" ? null : Number(filters.minAmount);
  const maxAmount = filters.maxAmount.trim() === "" ? null : Number(filters.maxAmount);
  const query = filters.search.trim().toLocaleLowerCase();

  return transactions.filter((transaction) => {
    if (filters.type && transaction.type !== filters.type) return false;
    if (filters.fromDate && transaction.date < filters.fromDate) return false;
    if (filters.toDate && transaction.date > filters.toDate) return false;
    if (minAmount !== null && Number.isFinite(minAmount) && transaction.amount < minAmount) return false;
    if (maxAmount !== null && Number.isFinite(maxAmount) && transaction.amount > maxAmount) return false;
    if (filters.categoryId && transaction.category_id !== filters.categoryId) return false;
    if (
      filters.fundingSourceId &&
      (transaction.type === "income"
        ? transaction.category_id !== filters.fundingSourceId
        : transaction.funding_source_id !== filters.fundingSourceId)
    ) return false;
    if (filters.vaultId && transaction.vault_id !== filters.vaultId) return false;
    if (query && !searchableText(transaction).toLocaleLowerCase().includes(query)) return false;
    return true;
  });
}
