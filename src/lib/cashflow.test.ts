import { describe, expect, it } from "vitest";
import { buildCashflow, hasCashflowActivity, recentMonths } from "./cashflow";

describe("recentMonths", () => {
  it("returns the requested number of months ending at the anchor, oldest first", () => {
    expect(recentMonths("2026-03", 3)).toEqual(["2026-01", "2026-02", "2026-03"]);
  });

  it("rolls back across the year boundary", () => {
    expect(recentMonths("2026-01", 3)).toEqual(["2025-11", "2025-12", "2026-01"]);
  });

  it("rolls forward across the year boundary", () => {
    expect(recentMonths("2025-12", 2)).toEqual(["2025-11", "2025-12"]);
  });

  it("spans twelve months by default without gaps", () => {
    const months = recentMonths("2026-03");
    expect(months).toHaveLength(12);
    expect(months[0]).toBe("2025-04");
    expect(months.at(-1)).toBe("2026-03");
  });

  it("handles a leap-year February without drifting", () => {
    expect(recentMonths("2028-03", 2)).toEqual(["2028-02", "2028-03"]);
  });
});

describe("buildCashflow", () => {
  it("sums income and expense per month", () => {
    const series = buildCashflow(
      [
        { type: "income", amount: 5000, date: "2026-03-01" },
        { type: "expense", amount: 1500, date: "2026-03-05" },
        { type: "expense", amount: 500, date: "2026-03-20" },
      ],
      "2026-03",
      1
    );
    expect(series).toEqual([{ month: "2026-03", income: 5000, expense: 2000, net: 3000 }]);
  });

  it("zero-fills months with no transactions instead of dropping them", () => {
    const series = buildCashflow(
      [{ type: "expense", amount: 900, date: "2026-03-02" }],
      "2026-03",
      3
    );
    expect(series).toEqual([
      { month: "2026-01", income: 0, expense: 0, net: 0 },
      { month: "2026-02", income: 0, expense: 0, net: 0 },
      { month: "2026-03", income: 0, expense: 900, net: -900 },
    ]);
  });

  it("ignores transactions older than the window", () => {
    const series = buildCashflow(
      [
        { type: "expense", amount: 10_000, date: "2020-01-01" },
        { type: "expense", amount: 100, date: "2026-03-01" },
      ],
      "2026-03",
      3
    );
    expect(series.reduce((sum, month) => sum + month.expense, 0)).toBe(100);
  });

  it("excludes transfers from both sides of the net", () => {
    const series = buildCashflow(
      [
        { type: "income", amount: 1000, date: "2026-03-01" },
        { type: "expense", amount: 400, date: "2026-03-02" },
        { type: "transfer", amount: 5000, date: "2026-03-03" },
      ],
      "2026-03",
      1
    );
    expect(series[0]).toEqual({ month: "2026-03", income: 1000, expense: 400, net: 600 });
  });

  it("lets net go negative when spending exceeds income", () => {
    const series = buildCashflow(
      [
        { type: "income", amount: 100, date: "2026-03-01" },
        { type: "expense", amount: 250, date: "2026-03-02" },
      ],
      "2026-03",
      1
    );
    expect(series[0].net).toBe(-150);
  });

  it("keeps transactions on the last day of a month in that month", () => {
    const series = buildCashflow(
      [{ type: "expense", amount: 700, date: "2026-03-31" }],
      "2026-03",
      1
    );
    expect(series[0].expense).toBe(700);
  });

  it("returns an all-zero series for an empty ledger", () => {
    const series = buildCashflow([], "2026-03", 12);
    expect(series).toHaveLength(12);
    expect(series.every((month) => month.income === 0 && month.expense === 0)).toBe(true);
  });
});

describe("hasCashflowActivity", () => {
  it("is false when every month is zero", () => {
    expect(hasCashflowActivity(buildCashflow([], "2026-03", 3))).toBe(false);
  });

  it("is true as soon as one month has movement", () => {
    const series = buildCashflow(
      [{ type: "income", amount: 1, date: "2026-02-01" }],
      "2026-03",
      3
    );
    expect(hasCashflowActivity(series)).toBe(true);
  });

  it("is false when a month nets to zero but has no transactions", () => {
    expect(hasCashflowActivity(buildCashflow([], "2026-03", 1))).toBe(false);
  });
});
