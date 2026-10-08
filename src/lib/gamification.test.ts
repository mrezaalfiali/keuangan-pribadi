import { describe, expect, it } from "vitest";
import {
  milestoneBonus,
  nextStreakReward,
  pointsForStreak,
} from "./gamification";

describe("streak rewards", () => {
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
