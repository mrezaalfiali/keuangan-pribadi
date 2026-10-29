-- ============================================================
-- 0025 — Align achievement progress and streak checks
--
-- Run manually in the Supabase SQL Editor after migration 0024.
-- Re-running this migration is safe.
-- ============================================================

do $$
declare
  v_function regprocedure;
  v_definition text;
  v_updated_definition text;
  v_stale_streak text :=
    'v_streak := coalesce(v_state.streak_current, 0);';
  v_active_streak text :=
    'v_streak := case
    when v_state.last_log_date between v_today - 1 and v_today
      then coalesce(v_state.streak_current, 0)
    else 0
  end;';
  v_old_monthly_check text :=
    'where monthly.expense <= 0
                 or (monthly.income - monthly.expense)::numeric / monthly.expense';
  v_new_monthly_check text :=
    'where monthly.income <= 0
                 or (monthly.income - monthly.expense)::numeric / monthly.income';
begin
  foreach v_function in array array[
    'public.check_user_achievements()'::regprocedure,
    'public.award_transaction_rewards()'::regprocedure
  ]
  loop
    select pg_get_functiondef(v_function) into v_definition;
    v_updated_definition := v_definition;

    if v_function = 'public.check_user_achievements()'::regprocedure then
      if position(v_stale_streak in v_updated_definition) > 0 then
        v_updated_definition := replace(
          v_updated_definition,
          v_stale_streak,
          v_active_streak
        );
      elsif position(v_active_streak in v_updated_definition) = 0 then
        raise exception 'Could not find stale streak check in %', v_function;
      end if;
    end if;

    if position(v_old_monthly_check in v_updated_definition) > 0 then
      v_updated_definition := replace(
        v_updated_definition,
        v_old_monthly_check,
        v_new_monthly_check
      );
    elsif position(v_new_monthly_check in v_updated_definition) = 0 then
      raise exception 'Could not find monthly savings ratio check in %', v_function;
    end if;

    if v_updated_definition <> v_definition then
      execute v_updated_definition;
    end if;
  end loop;
end;
$$;

-- Verification
select
  pg_get_functiondef('public.check_user_achievements()'::regprocedure)
    like '%last_log_date between v_today - 1 and v_today%' as streak_expires_after_missed_day,
  (
    select count(*) = 2
    from (
      select proname
      from pg_proc
      where pronamespace = 'public'::regnamespace
        and proname in ('check_user_achievements', 'award_transaction_rewards')
        and pg_get_functiondef(oid) like '%monthly.income - monthly.expense)::numeric / monthly.income%'
    ) corrected_functions
  ) as savings_ratio_uses_income
;
