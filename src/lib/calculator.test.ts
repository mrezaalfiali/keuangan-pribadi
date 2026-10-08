import { describe, expect, it } from "vitest";
import {
  emergencyFund,
  evaluateArithmetic,
  loanPayment,
  monthsToGoal,
  salaryAllocation,
  savingsGoal,
} from "@/src/lib/calculator";

describe("loanPayment", () => {
  it("menghitung angsuran flat dari pokok, bunga, dan tenor", () => {
    const result = loanPayment({
      principal: 120_000_000,
      annualRate: 5,
      months: 24,
      method: "flat",
    });
    expect(result).not.toBeNull();
    // total bunga = 120jt * 0.05 * 2 = 12jt; angsuran = 132jt / 24 = 5.5jt
    expect(result?.monthlyPayment).toBe(5_500_000);
    expect(result?.totalPayment).toBe(132_000_000);
    expect(result?.totalInterest).toBe(12_000_000);
  });

  it("menghitung angsuran efektif lebih murah dari flat untuk tenor pendek", () => {
    const args = {
      principal: 120_000_000,
      annualRate: 5,
      months: 24,
    } as const;
    const flat = loanPayment({ ...args, method: "flat" });
    const effective = loanPayment({ ...args, method: "effective" });
    // Bunga flat dihitung dari pokok awal, jadi totalnya lebih besar
    // dibanding bunga menurun (annuity) pada tenor pendek.
    expect(effective!.totalInterest).toBeLessThan(flat!.totalInterest);
    expect(effective!.monthlyPayment).toBeLessThan(flat!.monthlyPayment);
    // Keduanya membebani pokok, tidak ada hasil negatif.
    expect(effective!.totalInterest).toBeGreaterThan(0);
    expect(flat!.totalInterest).toBeGreaterThan(0);
  });

  it("menyamakan annuity dengan rumus standar", () => {
    // P = 100jt, i = 1% per bulan, n = 12 -> A = 100jt * 0.01 / (1 - 1.01^-12)
    const expected = (100_000_000 * 0.01) / (1 - Math.pow(1.01, -12));
    const result = loanPayment({
      principal: 100_000_000,
      annualRate: 12,
      months: 12,
      method: "effective",
    });
    expect(result!.monthlyPayment).toBe(Math.round(expected));
  });

  it("menjamin totalPayment = angsuran x tenor tanpa sisa pembulatan", () => {
    const result = loanPayment({
      principal: 33_333_333,
      annualRate: 3.5,
      months: 7,
      method: "effective",
    });
    expect(result!.totalPayment).toBe(result!.monthlyPayment * 7);
    expect(result!.totalInterest).toBe(result!.totalPayment - 33_333_333);
  });

  it("beri angsuran pokok saat bunga nol", () => {
    for (const method of ["flat", "effective"] as const) {
      const result = loanPayment({
        principal: 10_000_000,
        annualRate: 0,
        months: 10,
        method,
      });
      expect(result!.monthlyPayment).toBe(1_000_000);
      expect(result!.totalInterest).toBe(0);
    }
  });

  it("tidak menghasilkan bagi bunga negatif", () => {
    const result = loanPayment({
      principal: 10_000_000,
      annualRate: -5,
      months: 12,
      method: "flat",
    });
    expect(result!.monthlyPayment).toBe(Math.round(10_000_000 / 12));
  });

  it("mengembalikan null untuk input tidak valid", () => {
    expect(loanPayment({ principal: 0, annualRate: 5, months: 12, method: "flat" })).toBeNull();
    expect(loanPayment({ principal: -1, annualRate: 5, months: 12, method: "flat" })).toBeNull();
    expect(loanPayment({ principal: 1000, annualRate: 5, months: 0, method: "flat" })).toBeNull();
    expect(loanPayment({ principal: 1000, annualRate: 5, months: -12, method: "flat" })).toBeNull();
    expect(loanPayment({ principal: NaN, annualRate: 5, months: 12, method: "flat" })).toBeNull();
  });
});

describe("monthsToGoal", () => {
  it("membulatkan ke atas ke bulan penuh", () => {
    expect(monthsToGoal(1_000_000, 300_000)).toBe(4);
    expect(monthsToGoal(1_200_000, 400_000)).toBe(3);
  });

  it("nol saat target sudah tercapai", () => {
    expect(monthsToGoal(0, 100_000)).toBe(0);
    expect(monthsToGoal(-500, 100_000)).toBe(0);
  });

  it("null saat sisa positif tapi setoran nol", () => {
    expect(monthsToGoal(1_000_000, 0)).toBeNull();
    expect(monthsToGoal(1_000_000, -100)).toBeNull();
  });
});

describe("emergencyFund", () => {
  it("menghitung target dari pengeluaran dan pengali", () => {
    const result = emergencyFund({
      monthlyExpense: 5_000_000,
      multiplier: 6,
      saved: 10_000_000,
      monthlyContribution: 2_000_000,
    });
    expect(result!.target).toBe(30_000_000);
    expect(result!.remaining).toBe(20_000_000);
    expect(result!.monthsToGoal).toBe(10);
  });

  it("mengabaikan tabungan negatif dan lebih dari target", () => {
    const over = emergencyFund({
      monthlyExpense: 5_000_000,
      multiplier: 3,
      saved: 99_000_000,
      monthlyContribution: 500_000,
    });
    expect(over!.remaining).toBe(0);
    expect(over!.monthsToGoal).toBe(0);

    const negative = emergencyFund({
      monthlyExpense: 5_000_000,
      multiplier: 6,
      saved: -5_000_000,
      monthlyContribution: 1_000_000,
    });
    expect(negative!.remaining).toBe(30_000_000);
  });

  it("null tanpa setoran tapi menyorot target tetap", () => {
    const result = emergencyFund({
      monthlyExpense: 4_000_000,
      multiplier: 12,
      saved: 0,
      monthlyContribution: 0,
    });
    expect(result!.target).toBe(48_000_000);
    expect(result!.monthsToGoal).toBeNull();
  });

  it("null untuk pengeluaran atau pengali tidak valid", () => {
    expect(
      emergencyFund({ monthlyExpense: 0, multiplier: 6, saved: 0, monthlyContribution: 1 }),
    ).toBeNull();
    expect(
      emergencyFund({ monthlyExpense: 1000, multiplier: 0, saved: 0, monthlyContribution: 1 }),
    ).toBeNull();
  });
});

describe("savingsGoal", () => {
  it("menghitung sisa dan bulan menuju target", () => {
    const result = savingsGoal({
      current: 2_500_000,
      target: 50_000_000,
      monthlyContribution: 2_500_000,
    });
    expect(result!.remaining).toBe(47_500_000);
    expect(result!.monthsToGoal).toBe(19);
  });

  it("nol saat saldo sudah mencapai target", () => {
    const result = savingsGoal({ current: 60_000_000, target: 50_000_000, monthlyContribution: 0 });
    expect(result!.remaining).toBe(0);
    expect(result!.monthsToGoal).toBe(0);
  });

  it("null untuk target tidak valid", () => {
    expect(savingsGoal({ current: 0, target: 0, monthlyContribution: 1 })).toBeNull();
    expect(savingsGoal({ current: 0, target: -5, monthlyContribution: 1 })).toBeNull();
  });
});

describe("salaryAllocation", () => {
  it("menghitung pembagian gaji dari persentase dan rasio 0.x", () => {
    const result = salaryAllocation({
      income: 10_000_000,
      allocations: [
        { label: "Kebutuhan", percent: 50 },
        { label: "Keinginan", percent: 0.3 },
        { label: "Tabungan", percent: 20 },
      ],
    });

    expect(result).not.toBeNull();
    expect(result!.totalPercent).toBe(100);
    expect(result!.items[0].amount).toBe(5_000_000);
    expect(result!.items[1].amount).toBe(3_000_000);
    expect(result!.items[2].amount).toBe(2_000_000);
    expect(result!.remaining).toBe(0);
  });

  it("mengembalikan null untuk input tidak valid", () => {
    expect(salaryAllocation({ income: -1, allocations: [{ label: "A", percent: 50 }] })).toBeNull();
    expect(salaryAllocation({ income: 10_000_000, allocations: [] })).toBeNull();
  });
});

describe("evaluateArithmetic", () => {
  it("menghitung operasi dasar dan prioritas operator", () => {
    expect(evaluateArithmetic("2+3").value).toBe(5);
    expect(evaluateArithmetic("10-4-3").value).toBe(3);
    expect(evaluateArithmetic("2+3*4").value).toBe(14);
    expect(evaluateArithmetic("100/5/2").value).toBe(10);
  });

  it("menghormati tanda kurung dan bilangan negatif", () => {
    expect(evaluateArithmetic("(2+3)*4").value).toBe(20);
    expect(evaluateArithmetic("-(3+4)").value).toBe(-7);
    expect(evaluateArithmetic("-5+2").value).toBe(-3);
  });

  it("menghitung persen", () => {
    expect(evaluateArithmetic("200*10%").value).toBe(20);
    expect(evaluateArithmetic("50%").value).toBe(0.5);
  });

  it("menangani desimal", () => {
    expect(evaluateArithmetic("7/3").value).toBeCloseTo(2.3333, 4);
    expect(evaluateArithmetic("1.5+2.25").value).toBe(3.75);
  });

  it("mengabaikan spasi", () => {
    expect(evaluateArithmetic(" 1 2 + 3 ").value).toBe(15);
  });

  it("nol untuk ekspresi kosong", () => {
    expect(evaluateArithmetic("")).toEqual({ value: 0, error: null });
    expect(evaluateArithmetic("   ")).toEqual({ value: 0, error: null });
  });

  it("memberi error divide by zero", () => {
    expect(evaluateArithmetic("10/0")).toEqual({ value: 0, error: "divideByZero" });
    expect(evaluateArithmetic("5/(2-2)")).toEqual({ value: 0, error: "divideByZero" });
  });

  it("memberi error invalid untuk ekspresi rusak", () => {
    expect(evaluateArithmetic("2+").error).toBe("invalid");
    expect(evaluateArithmetic("(2+3").error).toBe("invalid");
    expect(evaluateArithmetic("2)3(").error).toBe("invalid");
    expect(evaluateArithmetic("abc").error).toBe("invalid");
    expect(evaluateArithmetic("1..2").error).toBe("invalid");
  });
});