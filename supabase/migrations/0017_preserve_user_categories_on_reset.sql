-- Keep user-created categories when resetting financial data.
-- Existing deployments may have already applied 0014, so replace the function
-- instead of changing the previously-applied migration.
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
  delete from public.allocation_rules where user_id = v_uid;
  delete from public.budgets where user_id = v_uid;
  delete from public.recurring_transactions where user_id = v_uid;
  delete from public.vaults where user_id = v_uid;

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
