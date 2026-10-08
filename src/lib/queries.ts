import { createClient } from "@/src/lib/supabase/server";
import type {
  AllocationRule,
  AllocationSlot,
  Budget,
  Category,
  GamificationState,
  Profile,
  Transaction,
  Vault,
  VaultBalance,
} from "./types";
import { vaultBalanceDelta } from "./vault-ledger";

export type TxWithRelations = Transaction & {
  category: Category | null;
  vault: Vault | null;
};

export async function getProfile(): Promise<Profile | null> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;

  const { data, error } = await supabase
    .from("profiles")
    .select("*")
    .eq("id", user.id)
    .maybeSingle();
  if (error) throw error;
  if (data === null) {
    const { error: profileError } = await supabase.from("profiles").upsert({
      id: user.id,
      display_name: user.email?.split("@")[0] ?? null,
    });
    if (profileError) throw profileError;
    const { data: inserted, error: readError } = await supabase
      .from("profiles")
      .select("*")
      .eq("id", user.id)
      .single();
    if (readError) throw readError;
    return inserted as Profile;
  }
  return data as Profile;
}

export async function getCategories(): Promise<Category[]> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return [];
  const { data, error } = await supabase
    .from("categories")
    .select("*")
    .or(`user_id.is.null,user_id.eq.${user.id}`)
    .order("is_system", { ascending: false });
  if (error) throw error;
  return (data as Category[]) ?? [];
}

export async function getVaults(): Promise<Vault[]> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return [];
  const { data, error } = await supabase
    .from("vaults")
    .select("*")
    .order("priority", { ascending: true });
  if (error) throw error;
  return (data as Vault[]) ?? [];
}

/** Balance per vault derived from the user's full transaction ledger. */
export function computeVaultBalances(
  transactions: TxWithRelations[],
  vaults: Vault[]
): Map<string, number> {
  const balances = new Map<string, number>();
  vaults.forEach((v) => balances.set(v.id, 0));

  for (const tx of transactions) {
    if (!tx.vault_id) continue;
    const cur = balances.get(tx.vault_id) ?? 0;
    balances.set(
      tx.vault_id,
      cur + vaultBalanceDelta(tx.type, tx.amount, tx.transfer_direction)
    );
  }
  return balances;
}

/** All transactions (with relations) for a user, newest first. */
export async function getTransactions(options?: {
  limit?: number;
  since?: string;
}): Promise<TxWithRelations[]> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return [];

  let query = supabase
    .from("transactions")
    .select("*, category:categories(*), vault:vaults(*)")
    .eq("user_id", user.id)
    .order("date", { ascending: false });

  if (options?.limit) query = query.limit(options.limit);
  if (options?.since) query = query.gte("date", options.since);

  const { data, error } = await query;
  if (error) throw error;
  return (data as TxWithRelations[]) ?? [];
}

export async function getGamification(): Promise<GamificationState | null> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;

  const { data, error } = await supabase
    .from("gamification_state")
    .select("*")
    .eq("user_id", user.id)
    .maybeSingle();
  if (error) throw error;
  return data as GamificationState | null;
}

export async function getVaultBalances(): Promise<VaultBalance[]> {
  const [vaults, transactions] = await Promise.all([
    getVaults(),
    getTransactions(),
  ]);
  const balances = computeVaultBalances(transactions, vaults);
  return vaults.map((vault) => ({
    vault,
    balance: balances.get(vault.id) ?? 0,
  }));
}

export async function getBudgets(month: string): Promise<Budget[]> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return [];
  const { data, error } = await supabase
    .from("budgets")
    .select("*")
    .eq("user_id", user.id)
    .eq("month", month);
  if (error) throw error;
  return (data as Budget[]) ?? [];
}

export async function getAllocationRules(): Promise<
  Array<AllocationRule & { slots: AllocationSlot[] }>
> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return [];

  const { data: rules, error } = await supabase
    .from("allocation_rules")
    .select("*, slots:allocation_slots(*, vault:vaults(*))")
    .eq("user_id", user.id)
    .order("created_at", { ascending: false });
  if (error) throw error;
  return (rules as Array<AllocationRule & { slots: AllocationSlot[] }>) ?? [];
}