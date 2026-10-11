/**
 * Monetary helpers. All amounts are integers in Rupiah (no decimals) —
 * avoids floating-point rounding drift across allocations.
 */

export function formatRupiah(amount: number, opts?: { compact?: boolean }): string {
  const sign = amount < 0 ? "-" : "";
  const abs = Math.abs(Math.round(amount));
  if (opts?.compact && abs >= 1_000_000_000) {
    return `${sign}Rp ${(abs / 1_000_000_000).toLocaleString("id-ID", {
      maximumFractionDigits: 1,
    })} M`;
  }
  if (opts?.compact && abs >= 1_000_000) {
    return `${sign}Rp ${(abs / 1_000_000).toLocaleString("id-ID", {
      maximumFractionDigits: 1,
    })} jt`;
  }
  return `${sign}Rp ${abs.toLocaleString("id-ID")}`;
}

export function formatNumber(amount: number): string {
  return Math.round(amount).toLocaleString("id-ID");
}

/**
 * Parses a user-typed integer Rupiah amount. Rupiah has no cents, so every
 * grouping separator is stripped: `"9.000.000"` and `"9,000,000"` both parse to
 * `9000000`. Invalid/empty input yields `0`.
 */
export function parseAmount(input: string): number {
  const normalized = input.replace(/[^\d-]/g, "");
  const value = Number(normalized);
  if (!Number.isFinite(value)) return 0;
  return Math.trunc(value);
}

/** Split an amount by percentage; remainder is assigned to the first slot so the total always reconciles. */
export function splitByPercent(total: number, percents: number[]): number[] {
  if (percents.length === 0) return [];
  const results = percents.map((p) => Math.round((total * p) / 100));
  const sum = results.reduce((a, b) => a + b, 0);
  results[0] += total - sum;
  return results;
}

export function percentOf(value: number, total: number): number {
  if (total <= 0) return 0;
  return Math.min(100, Math.max(0, (value / total) * 100));
}
