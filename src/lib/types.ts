export type TxType = "income" | "expense" | "transfer";
export type TransferDirection = "out" | "in" | null;
export type CategoryType = "income" | "expense";
export type AllocMethod = "percent" | "amount" | "remainder";
export type BudgetScope = "category" | "vault";

export interface Profile {
  id: string;
  display_name: string | null;
  currency: string;
  monthly_income: number;
  created_at: string;
}

export interface Category {
  id: string;
  user_id: string | null;
  type: CategoryType;
  slug: string;
  name_key: string | null;
  icon: string | null;
  color: string | null;
  is_system: boolean;
}

export interface Vault {
  id: string;
  user_id: string;
  slug: string;
  name_key: string | null;
  name: string | null;
  icon: string | null;
  color: string | null;
  target_amount: number | null;
  is_locked: boolean;
  locked_until: string | null;
  priority: number;
}

export interface Transaction {
  id: number;
  user_id: string;
  type: TxType;
  transfer_direction: TransferDirection;
  category_id: string | null;
  /** Sumber pemasukan yang membayar expense ini (added by migration 0004). */
  funding_source_id: string | null;
  vault_id: string | null;
  /** ID grup untuk transaksi yang dipecah (split). */
  group_id: string | null;
  amount: number;
  date: string;
  note: string | null;
  created_at: string;
  category?: Category | null;
  vault?: Vault | null;
}

export interface AllocationRule {
  id: string;
  user_id: string;
  name: string | null;
  source_category_id: string | null;
  is_active: boolean;
}

export interface AllocationSlot {
  id: string;
  rule_id: string;
  vault_id: string;
  method: AllocMethod;
  value: number;
  priority: number;
  vault?: Vault;
}

export interface Budget {
  id: string;
  user_id: string;
  scope: BudgetScope;
  scope_id: string;
  starts_on: string;
  ends_on: string;
  limit_amount: number;
  alert_threshold: number;
  rolled_over_from: string | null;
}

export interface RecurringTransaction {
  id: string;
  user_id: string;
  name: string;
  note: string | null;
  type: "income" | "expense";
  amount: number;
  category_id: string | null;
  funding_source_id: string | null;
  vault_id: string | null;
  frequency: "weekly" | "monthly";
  interval_count: number;
  anchor_day: number;
  due_on: string;
  ends_on: string | null;
  snoozed_until: string | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface GamificationState {
  user_id: string;
  points: number;
  streak_current: number;
  streak_longest: number;
  last_log_date: string | null;
  last_checkin_date: string | null;
  level: number;
}

export interface Achievement {
  id: string;
  code: string;
  name_key: string;
  icon: string | null;
  points_reward: number;
  criteria: AchievementCriteria;
}

export type AchievementCriteria =
  | { type: "streak_days"; days: number }
  | { type: "transaction_count"; count: number }
  | { type: "no_vault_withdraw"; vault_slug: string; months: number }
  | { type: "vault_goal"; vault_slug: string; ratio: number }
  | { type: "savings_ratio"; ratio: number; months: number };

export interface UserAchievement {
  user_id: string;
  achievement_id: string;
  unlocked_at: string;
  achievement?: Achievement;
}

export interface VaultBalance {
  vault: Vault;
  balance: number;
}
