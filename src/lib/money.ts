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

/** Parse a user-typed string ("9.000.000" / "9,000,000" / "9000000") into an int. */
export function parseAmount(input: string): number {
  const cleaned = input.replace(/[^\d.-]/g, "");
  const n = Number(cleaned);
  return Number.isFinite(n) ? Math.trunc(n) : 0;
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
