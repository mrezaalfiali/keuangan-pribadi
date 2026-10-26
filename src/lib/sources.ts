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

import { vaultBalanceDelta, type TransferDirection } from "./vault-ledger";
import type { TxType } from "./types";

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
  /** Penanda baris katalog bersama; bukan larangan edit/hapus per akun. */
  is_system?: boolean;
}

/** Override nama/visibilitas satu sumber untuk satu akun. */
export interface SourceOverride {
  category_id: string;
  custom_name: string | null;
  hidden: boolean;
}

/**
 * Terapkan override per akun ke katalog sumber.
 *
 * Baris yang di-hide dibuang dari daftar, sedangkan baris yang di-rename
 * memakai `name_key` baru agar `resolveLabel` langsung membacanya sebagai
 * teks literal. `slug` sengaja tidak diubah: ia identifier yang masih dipakai
 * transaksi lama dan kunci dedupe katalog.
 */
export function applySourceOverrides<T extends Pick<SourceCategory, "id" | "name_key">>(
  sources: readonly T[],
  overrides: readonly SourceOverride[]
): T[] {
  const byCategory = new Map(overrides.map((row) => [row.category_id, row]));
  return sources.flatMap((source) => {
    const override = byCategory.get(source.id);
    if (override?.hidden) return [];
    const name = override?.custom_name?.trim();
    return [name ? { ...source, name_key: name } : source];
  });
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

/**
 * The slice of a transaction needed to derive per-source-per-vault balances.
 *
 * A source only owns money that actually sits in a vault, so the vault matters:
 * the same source can hold `2 juta` in "Tabungan" and `500 ribu` in "Darat",
 * and an expense from "Tabungan" must not silently drain the "Darat" money.
 */
export interface PairTransaction {
  type: TxType;
  amount: number;
  category_id?: string | null;
  funding_source_id?: string | null;
  vault_id?: string | null;
  transfer_direction?: TransferDirection;
}

/** Key for one (income source, vault) pool. */
export function sourceVaultKey(sourceId: string, vaultId: string): string {
  return `${sourceId}:${vaultId}`;
}

function bump(map: Map<string, number>, key: string, delta: number) {
  map.set(key, (map.get(key) ?? 0) + delta);
}

/**
 * Running balance per (income source, vault) pair.
 *
 * This is the fine-grained version of `computeSourceBalances`: instead of one
 * figure per source it keeps one figure per source *per vault*, so the app can
 * tell that "Gaji" only has money in "Tabungan" and therefore cannot fund an
 * expense paid from "Darat". The delta per row mirrors the vault ledger exactly
 * (`vaultBalanceDelta`): income and transfer-in add, expense and transfer-out
 * subtract, so summing every pair for a vault reproduces that vault's balance.
 *
 * Rows without a vault, without a source, or with a non-finite amount are
 * skipped — they cannot be attributed to any pool.
 */
export function computeSourceVaultBalances(
  transactions: PairTransaction[]
): Map<string, number> {
  const balances = new Map<string, number>();

  for (const tx of transactions) {
    const amount = Number(tx.amount);
    if (!Number.isFinite(amount)) continue;
    if (!tx.vault_id) continue;

    let sourceId: string | null | undefined;
    if (tx.type === "income") sourceId = tx.category_id;
    else if (tx.type === "expense" || tx.type === "transfer") sourceId = tx.funding_source_id;
    else continue;
    if (!sourceId) continue;

    const delta = vaultBalanceDelta(tx.type, amount, tx.transfer_direction);
    bump(balances, sourceVaultKey(sourceId, tx.vault_id), delta);
  }

  return balances;
}

/** Saldo satu pool (sumber, vault); 0 kalau belum pernah tersentuh. */
export function sourceVaultBalance(
  balances: Map<string, number>,
  sourceId: string,
  vaultId: string
): number {
  return balances.get(sourceVaultKey(sourceId, vaultId)) ?? 0;
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