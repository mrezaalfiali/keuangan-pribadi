import { describe, expect, it } from "vitest";
import {
  activeStreak,
  countAchievementTransactions,
  computeAchievementProgress,
  milestoneBonus,
  nextStreakReward,
  pointsForStreak,
  savingsRate,
} from "./gamification";

describe("streak rewards", () => {
  it("expires a streak after a full missed day", () => {
    expect(activeStreak(
      { streak_current: 5, last_log_date: "2026-10-27" },
      "2026-10-29"
    )).toBe(0);
    expect(activeStreak(
      { streak_current: 5, last_log_date: "2026-10-28" },
      "2026-10-29"
    )).toBe(5);
    expect(activeStreak(
      { streak_current: 5, last_log_date: "2026-10-29" },
      "2026-10-29"
    )).toBe(5);
  });

  it("counts grouped transactions as a single achievement transaction", () => {
    expect(countAchievementTransactions([
      { id: 1, group_id: "split-a" },
      { id: 2, group_id: "split-a" },
      { id: 3, group_id: null },
    ])).toBe(2);
  });

  it("calculates savings as a share of income", () => {
    expect(savingsRate(1_000, 700)).toBeCloseTo(0.3);
    expect(savingsRate(1_000, 1_100)).toBe(0);
    expect(savingsRate(0, 0)).toBe(0);
  });

  it("awards daily points and escalating weekly, monthly, and 100-day bonuses", () => {
    expect(pointsForStreak(1)).toBe(10);
    expect(pointsForStreak(7)).toBe(60);
    expect(pointsForStreak(14)).toBe(60);
    expect(pointsForStreak(30)).toBe(160);
    expect(pointsForStreak(100)).toBe(1010);
  });

  it("uses the monthly bonus when a weekly milestone overlaps", () => {
    expect(milestoneBonus(210)).toBe(150);
  });

  it("does not award points for a zero or negative streak", () => {
    expect(pointsForStreak(0)).toBe(0);
    expect(pointsForStreak(-7)).toBe(0);
  });

  it("returns the next upcoming streak reward", () => {
    expect(nextStreakReward(0)).toEqual({ day: 7, bonus: 50 });
    expect(nextStreakReward(7)).toEqual({ day: 14, bonus: 50 });
    expect(nextStreakReward(29)).toEqual({ day: 30, bonus: 150 });
    expect(nextStreakReward(100)).toEqual({ day: 105, bonus: 50 });
  });
});

describe("computeAchievementProgress", () => {
  const dummyStats = {
    transactionCount: 25,
    streak: 4,
    vaults: [
      { id: "v1", slug: "dana-darurat", name: "Dana Darurat", target_amount: 10_000_000 },
      { id: "v2", slug: "tabungan", name: "Tabungan Utama", target_amount: 5_000_000 },
    ],
    vaultBalances: new Map([
      ["v1", 4_500_000],
      ["v2", 5_000_000],
    ]),
    budgetCount: 2,
    noteCount: 1,
    savingsRatio: 0.25,
    transactions: [],
    today: "2026-10-29",
  };

  it("computes progress for transaction_count", () => {
    const res = computeAchievementProgress(
      { type: "transaction_count", count: 50 },
      dummyStats
    );
    expect(res).toEqual({
      current: 25,
      target: 50,
      percent: 50,
      currentDisplay: "25",
      targetDisplay: "50",
    });
  });

  it("computes progress for streak_days", () => {
    const res = computeAchievementProgress(
      { type: "streak_days", days: 7 },
      dummyStats
    );
    expect(res).toEqual({
      current: 4,
      target: 7,
      percent: 57,
      currentDisplay: "4",
      targetDisplay: "7",
    });
  });

  it("computes progress for vault_count and budget_count", () => {
    const vRes = computeAchievementProgress({ type: "vault_count", count: 1 }, dummyStats);
    expect(vRes?.percent).toBe(100);

    const bRes = computeAchievementProgress({ type: "budget_count", count: 3 }, dummyStats);
    expect(bRes?.percent).toBe(67);
  });

  it("computes progress for vault_goal with slug substring match", () => {
    const res = computeAchievementProgress(
      { type: "vault_goal", vault_slug: "darurat", ratio: 0.9 },
      dummyStats
    );
    expect(res?.percent).toBe(50);
  });

  it("uses the matching vault with the highest goal progress", () => {
    const res = computeAchievementProgress(
      { type: "vault_goal", vault_slug: "darurat", ratio: 0.9 },
      {
        ...dummyStats,
        vaults: [
          ...dummyStats.vaults,
          { id: "v3", slug: "dana-darurat-utama", name: "Dana Darurat Utama", target_amount: 10_000_000 },
        ],
        vaultBalances: new Map([
          ["v1", 0],
          ["v2", 5_000_000],
          ["v3", 9_000_000],
        ]),
      }
    );
    expect(res?.percent).toBe(100);
    expect(res?.currentDisplay).toBe("90%");
  });

  it("calculates safe-withdrawal progress in completed months", () => {
    const res = computeAchievementProgress(
      { type: "no_vault_withdraw", vault_slug: "darurat", months: 2 },
      {
        ...dummyStats,
        transactions: [
          {
            vault_id: "v1",
            type: "income",
            transfer_direction: null,
            date: "2026-09-10",
          },
        ],
      }
    );
    expect(res).toEqual({
      current: 1,
      target: 2,
      percent: 50,
      currentDisplay: "1 bln",
      targetDisplay: "2 bln",
    });
  });

  it("restarts safe-withdrawal progress from the latest withdrawal", () => {
    const res = computeAchievementProgress(
      { type: "no_vault_withdraw", vault_slug: "darurat", months: 2 },
      {
        ...dummyStats,
        transactions: [
          {
            vault_id: "v1",
            type: "income",
            transfer_direction: null,
            date: "2026-01-01",
          },
          {
            vault_id: "v1",
            type: "expense",
            transfer_direction: null,
            date: "2026-09-15",
          },
        ],
      }
    );
    expect(res?.current).toBe(1);
    expect(res?.percent).toBe(50);
  });
});
