import { describe, expect, it } from "vitest";
import { filterTransactions, type FilterableTransaction, type TransactionFilters } from "./transaction-filters";

interface Row extends FilterableTransaction {
  note: string;
}

const transactions: Row[] = [
  {
    type: "expense",
    date: "2026-10-02",
    amount: 25_000,
    category_id: "food",
    funding_source_id: "salary",
    vault_id: "daily",
    note: "Lunch",
  },
  {
    type: "expense",
    date: "2026-10-12",
    amount: 150_000,
    category_id: "transport",
    funding_source_id: "bonus",
    vault_id: "daily",
    note: "Taxi",
  },
  {
    type: "income",
    date: "2026-10-15",
    amount: 5_000_000,
    category_id: "salary",
    funding_source_id: null,
    vault_id: null,
    note: "Monthly salary",
  },
];

const defaults: TransactionFilters = {
  type: "",
  fromDate: "",
  toDate: "",
  minAmount: "",
  maxAmount: "",
  categoryId: "",
  fundingSourceId: "",
  vaultId: "",
  search: "",
};

function select(filters: Partial<TransactionFilters>) {
  return filterTransactions(
    transactions,
    { ...defaults, ...filters },
    (transaction) => `${transaction.note} ${transaction.date} ${transaction.amount}`
  );
}

describe("filterTransactions", () => {
  it("filters an inclusive date range and amount range together", () => {
    expect(select({ fromDate: "2026-10-03", toDate: "2026-10-31", minAmount: "100000", maxAmount: "200000" }))
      .toEqual([transactions[1]]);
  });

  it("filters by category, vault, and funding source", () => {
    expect(select({ categoryId: "food", vaultId: "daily", fundingSourceId: "salary" }))
      .toEqual([transactions[0]]);
    expect(select({ type: "income", fundingSourceId: "salary" })).toEqual([transactions[2]]);
  });

  it("searches searchable text case-insensitively", () => {
    expect(select({ search: "LUNCH" })).toEqual([transactions[0]]);
  });

  it("returns all rows when no filters are active", () => {
    expect(select({})).toEqual(transactions);
  });
});
