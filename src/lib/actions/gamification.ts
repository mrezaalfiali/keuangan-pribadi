"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/src/lib/supabase/server";

export interface SyncAchievementsResult {
  ok: boolean;
  unlocked?: Array<{ name_key: string; points_reward: number }>;
  pointsAdded?: number;
  error?: string;
}

/**
 * Invokes the atomic `check_user_achievements` RPC to evaluate eligible achievements,
 * grant points, log them into `points_log`, and update user rank level.
 */
export async function syncAchievementsAction(
  locale: string
): Promise<SyncAchievementsResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return { ok: false, error: "err.auth" };
  }

  const { data, error } = await supabase.rpc("check_user_achievements");

  if (error) {
    // If migration 0024 has not been run yet, gracefully report without crashing
    return { ok: false, error: error.message };
  }

  const result = data as {
    unlocked?: Array<{ name_key: string; points_reward: number }>;
    total_points_added?: number;
  } | null;

  revalidatePath(`/${locale}/rewards`);

  return {
    ok: true,
    unlocked: result?.unlocked ?? [],
    pointsAdded: result?.total_points_added ?? 0,
  };
}

