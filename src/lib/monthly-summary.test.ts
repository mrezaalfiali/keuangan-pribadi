import { describe, expect, it } from "vitest";
import { buildMonthlySummary, shiftMonth } from "./monthly-summary";

describe("buildMonthlySummary", () => {
  it("summarizes income, expense, balance change, and expense categories for a month", () => {
    const food = { id: "food", slug: "makanan", name_key: "cat.makanan" };
    const transport = { id: "transport", slug: "transportasi", name_key: "cat.transportasi" };
    const summary = buildMonthlySummary(
      [
        { type: "income", amount: 5_000, date: "2026-10-01", category_id: null },
        { type: "expense", amount: 700, date: "2026-10-03", category_id: food.id, category: food },
        { type: "expense", amount: 200, date: "2026-10-04", category_id: food.id, category: food },
        { type: "expense", amount: 400, date: "2026-10-05", category_id: transport.id, category: transport },
        { type: "transfer", amount: 2_000, date: "2026-10-06", category_id: null },
        { type: "expense", amount: 9_000, date: "2026-09-30", category_id: food.id, category: food },
      ],
      "2026-10"
    );

    expect(summary.income).toBe(5_000);
    expect(summary.expense).toBe(1_300);
    expect(summary.balanceChange).toBe(3_700);
    expect(summary.expensesByCategory).toEqual([
      { id: food.id, category: food, amount: 900 },
      { id: transport.id, category: transport, amount: 400 },
    ]);
  });

  it("keeps uncategorized expenses as a visible category bucket", () => {
    expect(
      buildMonthlySummary(
        [{ type: "expense", amount: 250, date: "2026-10-01", category_id: null }],
        "2026-10"
      ).expensesByCategory
    ).toEqual([{ id: null, category: null, amount: 250 }]);
  });
});

describe("shiftMonth", () => {
  it("shifts across year boundaries", () => {
    expect(shiftMonth("2026-01", -1)).toBe("2025-12");
    expect(shiftMonth("2026-12", 1)).toBe("2027-01");
  });
});
