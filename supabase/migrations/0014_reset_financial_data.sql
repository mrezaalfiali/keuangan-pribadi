-- ============================================================
-- 0014_reset_financial_data.sql
--
-- "Start from zero" — wipes every ledger and reward row owned by the
-- caller. Account-level data (profiles) and the shared catalogs
-- (system categories with user_id IS NULL, and public.achievements)
-- are preserved.
--
-- Why SECURITY DEFINER: 0008_atomic_gamification_rewards.sql revokes
-- insert/update on gamification_state, points_log and user_achievements
-- from the authenticated role, so an INVOKER function could not clear
-- the rewards. The function still scopes every statement to auth.uid(),
-- so it can never touch another user's rows.
--
-- Deletion order matters because several FKs are ON DELETE SET NULL:
-- deleting a parent first would silently orphan ledger rows instead of
-- removing them. Children are removed before their parents:
--   user_achievements -> points_log -> transactions
--   -> allocation_rules (cascades allocation_slots)
--   -> budgets (polymorphic scope_id: delete explicitly, no FK)
--   -> recurring_transactions -> vaults -> own categories
-- Then gamification_state is reset to defaults.
-- System categories (user_id IS NULL) and the achievements catalog are
-- never deleted.
-- ============================================================

create or replace function public.reset_financial_data()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'err.auth';
  end if;

  delete from public.user_achievements where user_id = v_uid;
  delete from public.points_log where user_id = v_uid;
  delete from public.transactions where user_id = v_uid;

  -- allocation_slots cascade from allocation_rules.
  delete from public.allocation_rules where user_id = v_uid;

  -- budgets.scope_id is a bare uuid (no FK), so it must be deleted
  -- explicitly or it would dangle once categories/vaults are gone.
  delete from public.budgets where user_id = v_uid;

  delete from public.recurring_transactions where user_id = v_uid;

  delete from public.vaults where user_id = v_uid;

  -- Only the user's own categories; the shared system catalog
  -- (user_id is null) and the achievements catalog must survive.
  delete from public.categories where user_id = v_uid;

  update public.gamification_state
     set points = 0,
         streak_current = 0,
         streak_longest = 0,
         last_log_date = null,
         last_checkin_date = null,
         level = 1,
         updated_at = now()
   where user_id = v_uid;
end;
$$;

revoke all on function public.reset_financial_data() from public;
revoke all on function public.reset_financial_data() from anon;
grant execute on function public.reset_financial_data() to authenticated;

notify pgrst, 'reload schema';
