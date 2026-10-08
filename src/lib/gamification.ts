import type { GamificationState } from "./types";

export const POINTS = {
  TRANSACTION_DAY: 10,
  STREAK_DAY_7: 50,
  STREAK_DAY_30: 150,
  STREAK_DAY_100: 1000,
} as const;

/** Bonus awarded when a streak reaches a milestone day. */
export function milestoneBonus(streak: number): number {
  if (streak <= 0) return 0;
  if (streak % 100 === 0) return POINTS.STREAK_DAY_100;
  if (streak % 30 === 0) return POINTS.STREAK_DAY_30;
  if (streak % 7 === 0) return POINTS.STREAK_DAY_7;
  return 0;
}

/** Daily points plus any weekly, monthly, or 100-day streak bonus. */
export function pointsForStreak(streak: number): number {
  if (streak <= 0) return 0;
  return POINTS.TRANSACTION_DAY + milestoneBonus(streak);
}

export function nextStreakReward(
  streak: number
): { day: number; bonus: number } {
  let day = Math.max(0, Math.trunc(streak)) + 1;
  while (milestoneBonus(day) === 0) day += 1;
  return { day, bonus: milestoneBonus(day) };
}

export function isSameDay(a: string | null, b: string): boolean {
  return a === b;
}

/**
 * Advance the streak given a "logging day". Pure function — returns the new
 * streak values and whether the streak was broken (a missed day).
 */
export function advanceStreak(
  state: GamificationState,
  today: string
): { streak: number; broke: boolean; lastLogDate: string } {
  const last = state.last_log_date;
  if (!last) {
    return { streak: 1, broke: false, lastLogDate: today };
  }
  if (last === today) {
    return { streak: state.streak_current, broke: false, lastLogDate: today };
  }
  const lastDate = new Date(`${last}T00:00:00`);
  const todayDate = new Date(`${today}T00:00:00`);
  const diffDays = Math.round(
    (todayDate.getTime() - lastDate.getTime()) / 86_400_000
  );
  if (diffDays === 1) {
    return { streak: state.streak_current + 1, broke: false, lastLogDate: today };
  }
  return { streak: 1, broke: true, lastLogDate: today };
}

export const LEVEL_KEYS = [
  "rank.bronze",
  "rank.bronze2",
  "rank.silver",
  "rank.silver2",
  "rank.gold",
  "rank.gold2",
  "rank.platinum",
  "rank.platinum2",
  "rank.obsidian",
  "rank.obsidian2",
] as const;