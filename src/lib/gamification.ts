import type { AchievementCriteria, GamificationState } from "./types";

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

export function activeStreak(
  state: Pick<GamificationState, "streak_current" | "last_log_date"> | null,
  today: string
): number {
  if (!state?.last_log_date) return 0;
  const lastDate = new Date(`${state.last_log_date}T00:00:00Z`);
  const todayDate = new Date(`${today}T00:00:00Z`);
  const diffDays = Math.round(
    (todayDate.getTime() - lastDate.getTime()) / 86_400_000
  );
  return diffDays >= 0 && diffDays <= 1
    ? Math.max(0, state.streak_current)
    : 0;
}

export function countAchievementTransactions(
  transactions: Array<{ id: number; group_id: string | null }>
): number {
  return new Set(
    transactions.map((transaction) =>
      transaction.group_id ?? String(transaction.id)
    )
  ).size;
}

export function savingsRate(income: number, expenses: number): number {
  if (income <= 0) return 0;
  return Math.max(0, (income - expenses) / income);
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

export interface AchievementProgress {
  current: number;
  target: number;
  percent: number;
  currentDisplay: string;
  targetDisplay: string;
}

export function computeAchievementProgress(
  criteria: AchievementCriteria,
  stats: {
    transactionCount: number;
    streak: number;
    vaults: Array<{ id: string; slug: string; name: string; target_amount: number | null }>;
    vaultBalances: Map<string, number>;
    budgetCount: number;
    noteCount: number;
    savingsRatio?: number;
    transactions: Array<{
      vault_id: string | null;
      type: "income" | "expense" | "transfer";
      transfer_direction: "in" | "out" | null;
      date: string;
    }>;
    today: string;
  }
): AchievementProgress | null {
  if (!criteria || !criteria.type) return null;

  const matchesVault = (vault: { slug: string; name: string }, slugKey: string) => {
    if (!slugKey || slugKey === "any") return true;
    return (
      vault.slug.toLowerCase().includes(slugKey) ||
      vault.name.toLowerCase().includes(slugKey)
    );
  };

  switch (criteria.type) {
    case "transaction_count": {
      const current = Math.max(0, stats.transactionCount);
      const target = Math.max(1, criteria.count);
      const percent = Math.min(100, Math.round((current / target) * 100));
      return {
        current,
        target,
        percent,
        currentDisplay: current.toString(),
        targetDisplay: target.toString(),
      };
    }
    case "streak_days": {
      const current = Math.max(0, stats.streak);
      const target = Math.max(1, criteria.days);
      const percent = Math.min(100, Math.round((current / target) * 100));
      return {
        current,
        target,
        percent,
        currentDisplay: `${current}`,
        targetDisplay: `${target}`,
      };
    }
    case "vault_count": {
      const current = stats.vaults.length;
      const target = Math.max(1, criteria.count);
      const percent = Math.min(100, Math.round((current / target) * 100));
      return {
        current,
        target,
        percent,
        currentDisplay: current.toString(),
        targetDisplay: target.toString(),
      };
    }
    case "budget_count": {
      const current = stats.budgetCount;
      const target = Math.max(1, criteria.count);
      const percent = Math.min(100, Math.round((current / target) * 100));
      return {
        current,
        target,
        percent,
        currentDisplay: current.toString(),
        targetDisplay: target.toString(),
      };
    }
    case "note_count": {
      const current = stats.noteCount;
      const target = Math.max(1, criteria.count);
      const percent = Math.min(100, Math.round((current / target) * 100));
      return {
        current,
        target,
        percent,
        currentDisplay: current.toString(),
        targetDisplay: target.toString(),
      };
    }
    case "vault_goal": {
      const slugKey = (criteria.vault_slug ?? "").toLowerCase();
      const ratio = criteria.ratio ?? 1;
      const vaultProgress = stats.vaults
        .filter((vault) => matchesVault(vault, slugKey))
        .flatMap((vault) => {
          const targetAmount = vault.target_amount;
          if (targetAmount === null || targetAmount <= 0) return [];
          const balance = Math.max(0, stats.vaultBalances.get(vault.id) ?? 0);
          const targetGoal = targetAmount * ratio;
          return [{
            balance,
            targetGoal,
            targetAmount,
            percent: targetGoal > 0
              ? Math.min(100, Math.round((balance / targetGoal) * 100))
              : 0,
          }];
        })
        .sort((a, b) => b.percent - a.percent)[0];
      if (!vaultProgress) {
        return {
          current: 0,
          target: 100,
          percent: 0,
          currentDisplay: "0%",
          targetDisplay: `${Math.round(ratio * 100)}%`,
        };
      }
      return {
        current: Math.round(vaultProgress.balance),
        target: Math.round(vaultProgress.targetGoal),
        percent: vaultProgress.percent,
        currentDisplay: `${Math.min(100, Math.round((vaultProgress.balance / vaultProgress.targetAmount) * 100))}%`,
        targetDisplay: `${Math.round(ratio * 100)}%`,
      };
    }
    case "no_vault_withdraw": {
      const target = Math.max(1, criteria.months);
      const slugKey = (criteria.vault_slug ?? "").toLowerCase();
      const current = stats.vaults.reduce((bestProgress, vault) => {
        if (!matchesVault(vault, slugKey)) return bestProgress;
        const vaultTransactions = stats.transactions.filter(
          (transaction) => transaction.vault_id === vault.id
        );
        const deposits = vaultTransactions
          .filter((transaction) =>
            transaction.type === "income" ||
            (transaction.type === "transfer" && transaction.transfer_direction === "in")
          )
          .map((transaction) => transaction.date)
          .sort();
        if (deposits.length === 0) return bestProgress;

        const withdrawals = vaultTransactions
          .filter((transaction) =>
            transaction.type === "expense" ||
            (transaction.type === "transfer" && transaction.transfer_direction === "out")
          )
          .map((transaction) => transaction.date)
          .sort();
        const latestWithdrawal = withdrawals[withdrawals.length - 1];
        const progressStart =
          latestWithdrawal && latestWithdrawal > deposits[0]
            ? latestWithdrawal
            : deposits[0];
        let months = 0;
        for (let elapsed = 1; elapsed <= target; elapsed += 1) {
          if (subtractMonths(stats.today, elapsed) < progressStart) break;
          months = elapsed;
        }
        return Math.max(bestProgress, months);
      }, 0);
      return {
        current,
        target,
        percent: Math.min(100, Math.round((current / target) * 100)),
        currentDisplay: `${current} bln`,
        targetDisplay: `${target} bln`,
      };
    }
    case "savings_ratio": {
      const ratio = Math.max(0, stats.savingsRatio ?? 0);
      const target = Math.max(1, Math.round((criteria.ratio ?? 0.2) * 100));
      const current = Math.round(ratio * 100);
      const percent = Math.min(100, Math.round((current / target) * 100));
      return {
        current,
        target,
        percent,
        currentDisplay: `${current}%`,
        targetDisplay: `${target}%`,
      };
    }
    default:
      return null;
  }
}

function subtractMonths(date: string, months: number): string {
  const [year, month, day] = date.split("-").map(Number);
  const result = new Date(Date.UTC(year, month - 1, 1));
  result.setUTCMonth(result.getUTCMonth() - months);
  const lastDay = new Date(
    Date.UTC(result.getUTCFullYear(), result.getUTCMonth() + 1, 0)
  ).getUTCDate();
  result.setUTCDate(Math.min(day, lastDay));
  return result.toISOString().slice(0, 10);
}