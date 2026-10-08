/**
 * Income source helpers.
 *
 * An income source is a row in `categories` with `type='income'`. The same
 * table supplies the expense categories, so the `type` column is what tells
 * the two apart. Income transactions point at their source through
 * `category_id`; expenses point at the source that paid for them through
 * `funding_source_id` (added by migration 0004).
 *
 * There is no stored balance column — like vault balances, every figure here
 * is derived from the ledger.
 */

/** The slice of a transaction these helpers need. */
export interface SourceTransaction {
  type: string;
  amount: number;
  category_id: string | null;
  funding_source_id?: string | null;
}

export interface SourceSummary {
  /** Kategori sumber pemasukan. */
  source: SourceCategory;
  /** Pemasukan tercatat untuk sumber ini. */
  income: number;
  /** Pengeluaran yang dibayar dari sumber ini. */
  expense: number;
  /** income - expense. Negatif berarti pengeluaran melebihi pemasukan. */
  balance: number;
}

/** A source is an income category; only the fields the UI displays. */
export interface SourceCategory {
  id: string;
  slug: string;
  name_key: string | null;
  name?: string | null;
  icon?: string | null;
  color?: string | null;
  /** Sumber bawaan tidak bisa dihapus dari UI. */
  is_system?: boolean;
}

/**
 * Running balance per income source.
 *
 * Income adds to the source it is booked against (`category_id`), expenses
 * subtract from the source that funded them (`funding_source_id`). Rows with
 * neither are skipped: that is how expenses recorded before migration 0004
 * stay visible without distorting any source's balance.
 *
 * Every income source passed in gets an entry, including one that has never
 * been used — its balance is 0, which is what hides it from the expense form.
 */
export function computeSourceBalances(
  transactions: SourceTransaction[],
  sources: SourceCategory[]
): Map<string, number> {
  const balances = new Map<string, number>(sources.map((s) => [s.id, 0]));

  for (const tx of transactions) {
    const amount = Number(tx.amount);
    if (!Number.isFinite(amount)) continue;

    if (tx.type === "income" && tx.category_id) {
      if (!balances.has(tx.category_id)) balances.set(tx.category_id, 0);
      balances.set(tx.category_id, balances.get(tx.category_id)! + amount);
      continue;
    }

    if (tx.type === "expense" && tx.funding_source_id) {
      if (!balances.has(tx.funding_source_id)) balances.set(tx.funding_source_id, 0);
      balances.set(
        tx.funding_source_id,
        balances.get(tx.funding_source_id)! - amount
      );
    }
  }

  return balances;
}

/** Per-source income, expense and balance, in the order the sources were given. */
export function summarizeSources(
  transactions: SourceTransaction[],
  sources: SourceCategory[]
): SourceSummary[] {
  const balances = computeSourceBalances(transactions, sources);

  return sources.map((source) => {
    let income = 0;
    let expense = 0;
    for (const tx of transactions) {
      const amount = Number(tx.amount);
      if (!Number.isFinite(amount)) continue;
      if (tx.type === "income" && tx.category_id === source.id) income += amount;
      else if (tx.type === "expense" && tx.funding_source_id === source.id) expense += amount;
    }
    return { source, income, expense, balance: balances.get(source.id) ?? 0 };
  });
}

/** Hanya sumber yang saldonya positif yang boleh dipilih untuk expense. */
export function availableSources(summaries: SourceSummary[]): SourceSummary[] {
  return summaries.filter((s) => s.balance > 0);
}

/**
 * Slug untuk `categories.slug`, unik per pengguna. Aksen dihapus agar "Gaji
 * Bulanan" dan "gaji bulanan" tidak menjadi dua sumber berbeda.
 */
export function sourceSlug(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}