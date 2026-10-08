/** Pure calculator formulas. No React/Next imports so they stay unit-testable. */

export type LoanMethod = "flat" | "effective";

export interface LoanInput {
  /** Pokok pinjaman. */
  principal: number;
  /** Suku bunga per tahun dalam persen, mis. 5 untuk 5%/tahun. */
  annualRate: number;
  /** Tenor dalam bulan. */
  months: number;
  method: LoanMethod;
}

export interface LoanResult {
  /** Angsuran per bulan, sudah dibulatkan ke rupiah penuh. */
  monthlyPayment: number;
  /** Total bayar = monthlyPayment * months, konsisten dengan angsuran. */
  totalPayment: number;
  /** Total bunga = totalPayment - principal. */
  totalInterest: number;
}

/**
 * Angsuran kredit. Flat: bunga dihitung dari pokok awal, sama tiap bulan.
 * Efektif: bunga dihitung dari sisa pokok (annuity).
 * Pembulatan dilakukan di akhir agar totalPayment selalu sama dengan
 * monthlyPayment * months (tidak ada sisa pembulatan yang hilang).
 */
export function loanPayment(input: LoanInput): LoanResult | null {
  const { principal, annualRate, months, method } = input;
  if (
    !isFinite(principal) ||
    !isFinite(annualRate) ||
    !isFinite(months) ||
    principal <= 0 ||
    months <= 0
  ) {
    return null;
  }
  const rate = Math.max(0, annualRate) / 100;

  let monthly: number;
  if (method === "flat") {
    const totalInterest = principal * rate * (months / 12);
    monthly = (principal + totalInterest) / months;
  } else {
    const i = rate / 12;
    if (i === 0) {
      monthly = principal / months;
    } else {
      monthly = (principal * i) / (1 - Math.pow(1 + i, -months));
    }
  }

  const roundedMonthly = Math.round(monthly);
  const totalPayment = roundedMonthly * months;
  return {
    monthlyPayment: roundedMonthly,
    totalPayment,
    totalInterest: totalPayment - principal,
  };
}

export interface EmergencyInput {
  /** Pengeluaran bulanan (dasar perhitungan). */
  monthlyExpense: number;
  /** Berapa kali pengeluaran bulanan yang ingin disimpan. */
  multiplier: number;
  /** Dana darurat yang sudah ada. */
  saved: number;
  /** Setoran per bulan. */
  monthlyContribution: number;
}

export interface EmergencyResult {
  /** Target dana darurat = monthlyExpense * multiplier. */
  target: number;
  /** Sisa yang perlu dihimpun. */
  remaining: number;
  /** Perkiraan bulan menuju target, atau null bila tidak akan tercapai. */
  monthsToGoal: number | null;
}

export function emergencyFund(input: EmergencyInput): EmergencyResult | null {
  const { monthlyExpense, multiplier, saved, monthlyContribution } = input;
  if (!isFinite(monthlyExpense) || monthlyExpense <= 0) return null;
  if (!isFinite(multiplier) || multiplier <= 0) return null;

  const target = Math.round(monthlyExpense * multiplier);
  const current = isFinite(saved) && saved > 0 ? saved : 0;
  const remaining = Math.max(0, target - current);

  return {
    target,
    remaining,
    monthsToGoal: monthsToGoal(remaining, monthlyContribution),
  };
}

export interface GoalInput {
  current: number;
  target: number;
  monthlyContribution: number;
}

export interface GoalResult {
  remaining: number;
  monthsToGoal: number | null;
}

/** Bulan menuju target, atau null bila tidak akan tercapai (sisa > 0 tapi setoran 0). */
export function monthsToGoal(remaining: number, monthlyContribution: number): number | null {
  if (remaining <= 0) return 0;
  if (!isFinite(monthlyContribution) || monthlyContribution <= 0) return null;
  return Math.ceil(remaining / monthlyContribution);
}

export function savingsGoal(input: GoalInput): GoalResult | null {
  const { current, target, monthlyContribution } = input;
  if (!isFinite(target) || target <= 0) return null;

  const currentBalance = isFinite(current) && current > 0 ? current : 0;
  const remaining = Math.max(0, Math.round(target) - Math.round(currentBalance));

  return {
    remaining,
    monthsToGoal: monthsToGoal(remaining, monthlyContribution),
  };
}

export interface SalaryAllocationItem {
  label: string;
  percent: number;
}

export interface SalaryAllocationInput {
  income: number;
  allocations: SalaryAllocationItem[];
}

export interface SalaryAllocationResult {
  totalPercent: number;
  items: Array<SalaryAllocationItem & { amount: number }>;
  remaining: number;
}

export function salaryAllocation(input: SalaryAllocationInput): SalaryAllocationResult | null {
  const { income, allocations } = input;
  if (!isFinite(income) || income < 0 || !Array.isArray(allocations) || allocations.length === 0) {
    return null;
  }

  const normalized = allocations.map((allocation) => {
    const percent = Number(allocation.percent);
    const parsed = Number.isFinite(percent) ? Math.max(0, percent) : 0;
    return {
      label: allocation.label ?? "Allocation",
      percent: parsed <= 1 ? parsed * 100 : parsed,
    };
  });

  const items = normalized.map((allocation) => ({
    ...allocation,
    amount: Math.round(income * (allocation.percent / 100)),
  }));

  const totalPercent = normalized.reduce((sum, allocation) => sum + allocation.percent, 0);
  const remaining = Math.round(income - items.reduce((sum, item) => sum + item.amount, 0));

  return { totalPercent, items, remaining };
}

export interface ArithmeticResult {
  value: number;
  /** Pesan error sederhana jika ekspresi tidak valid. */
  error: "invalid" | "divideByZero" | null;
}

/**
 * Kalkulator aritmetika sederhana: +, -, *, /, %, dan tanda kurung.
 * Parser recursive-descent tanpa eval. Prioritas: () > * / % > + -.
 */
export function evaluateArithmetic(expression: string): ArithmeticResult {
  const src = expression.replace(/\s+/g, "");
  if (src === "") return { value: 0, error: null };

  let pos = 0;
  const eat = (ch: string) => {
    if (src[pos] === ch) {
      pos += 1;
      return true;
    }
    return false;
  };

  function parseNumber(): number {
    const start = pos;
    while (pos < src.length && /[0-9.]/.test(src[pos])) pos += 1;
    const raw = src.slice(start, pos);
    const num = Number(raw);
    if (raw === "" || raw === "." || Number.isNaN(num)) {
      throw new Error("invalid");
    }
    return num;
  }

  function parsePrimary(): number {
    if (eat("(")) {
      const value = parseExpression();
      if (!eat(")")) throw new Error("invalid");
      return value;
    }
    return parseNumber();
  }

  // Tanda unary berlaku untuk faktor mana pun, termasuk tanda kurung:
  // "-(3+4)" harus -7, bukan error. Persen bersifat postfix
  // ("10%" = 0,1), sehingga "200*10%" = 20.
  function parseFactor(): number {
    const sign = eat("-") ? -1 : eat("+") ? 1 : 1;
    let value = parsePrimary();
    while (eat("%")) value /= 100;
    return sign * value;
  }

  function parseTerm(): number {
    let value = parseFactor();
    for (;;) {
      if (eat("*")) value *= parseFactor();
      else if (eat("/")) {
        const divisor = parseFactor();
        if (divisor === 0) throw new Error("divideByZero");
        value /= divisor;
      } else return value;
    }
  }

  function parseExpression(): number {
    let value = parseTerm();
    for (;;) {
      if (eat("+")) value += parseTerm();
      else if (eat("-")) value -= parseTerm();
      else return value;
    }
  }

  try {
    const value = parseExpression();
    if (pos !== src.length || !isFinite(value)) {
      return { value: 0, error: "invalid" };
    }
    return { value, error: null };
  } catch (err) {
    const code = err instanceof Error ? err.message : "invalid";
    if (code === "divideByZero") return { value: 0, error: "divideByZero" };
    return { value: 0, error: "invalid" };
  }
}