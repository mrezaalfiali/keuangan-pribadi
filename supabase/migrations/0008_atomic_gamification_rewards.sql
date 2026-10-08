-- ============================================================
-- 0008 — Atomic points and automatic achievements
--
-- Serializes reward updates per user, awards daily/streak points once,
-- unlocks eligible achievements once, and keeps reward writes in one
-- database transaction.
-- ============================================================

create or replace function public.award_transaction_rewards()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_today date := (statement_timestamp() at time zone 'Asia/Jakarta')::date;
  v_state public.gamification_state%rowtype;
  v_streak integer;
  v_daily_points integer := 0;
  v_total_points integer := 0;
  v_transaction_count bigint;
  v_achievement record;
  v_unlocked jsonb := '[]'::jsonb;
begin
  if v_user_id is null then
    raise exception 'authentication required' using errcode = '42501';
  end if;

  insert into public.gamification_state (user_id)
  values (v_user_id)
  on conflict (user_id) do nothing;

  select *
    into v_state
    from public.gamification_state
   where user_id = v_user_id
   for update;

  v_streak := case
    when v_state.last_log_date = v_today then v_state.streak_current
    when v_state.last_log_date = v_today - 1 then v_state.streak_current + 1
    else 1
  end;

  if v_state.last_log_date is distinct from v_today then
    v_daily_points := 10;
    if v_streak % 100 = 0 then
      v_daily_points := v_daily_points + 1000;
    elsif v_streak % 30 = 0 then
      v_daily_points := v_daily_points + 150;
    elsif v_streak % 7 = 0 then
      v_daily_points := v_daily_points + 50;
    end if;

    insert into public.points_log (user_id, action, delta, reason)
    values (
      v_user_id,
      'transaction',
      v_daily_points,
      format('Daily transaction · %s-day streak', v_streak)
    );
  end if;

  select count(distinct coalesce(group_id::text, id::text))
    into v_transaction_count
    from public.transactions
   where user_id = v_user_id;

  for v_achievement in
    select a.id, a.code, a.name_key, a.points_reward
      from public.achievements a
     where not exists (
       select 1
         from public.user_achievements ua
        where ua.user_id = v_user_id
          and ua.achievement_id = a.id
     )
       and case a.criteria->>'type'
         when 'transaction_count' then
           v_transaction_count >= coalesce((a.criteria->>'count')::integer, 2147483647)
         when 'streak_days' then
           v_streak >= coalesce((a.criteria->>'days')::integer, 2147483647)
         when 'vault_goal' then
           exists (
             select 1
               from public.vaults v
              where v.user_id = v_user_id
                and v.slug = a.criteria->>'vault_slug'
                and v.target_amount > 0
                and coalesce((
                  select sum(
                    case
                      when tx.type = 'expense'
                        or (tx.type = 'transfer' and tx.transfer_direction = 'out')
                      then -tx.amount
                      else tx.amount
                    end
                  )
                    from public.transactions tx
                   where tx.user_id = v_user_id
                     and tx.vault_id = v.id
                ), 0) >= v.target_amount * coalesce((a.criteria->>'ratio')::numeric, 1)
           )
         when 'no_vault_withdraw' then
           exists (
             select 1
               from public.vaults v
              where v.user_id = v_user_id
                and v.slug = a.criteria->>'vault_slug'
                and exists (
                  select 1
                    from public.transactions deposit
                   where deposit.user_id = v_user_id
                     and deposit.vault_id = v.id
                     and deposit.date <= v_today - make_interval(
                       months => greatest(1, coalesce((a.criteria->>'months')::integer, 1))
                     )
                     and (
                       deposit.type = 'income'
                       or (
                         deposit.type = 'transfer'
                         and deposit.transfer_direction = 'in'
                       )
                     )
                )
                and not exists (
                  select 1
                    from public.transactions tx
                   where tx.user_id = v_user_id
                     and tx.vault_id = v.id
                     and tx.date > v_today - make_interval(
                       months => greatest(1, coalesce((a.criteria->>'months')::integer, 1))
                     )
                     and (
                       tx.type = 'expense'
                       or (tx.type = 'transfer' and tx.transfer_direction = 'out')
                     )
                )
           )
         when 'savings_ratio' then
           not exists (
             select 1
               from generate_series(
                 1,
                 greatest(1, coalesce((a.criteria->>'months')::integer, 1))
               ) as month_offset(n)
               cross join lateral (
                 select
                   coalesce(sum(tx.amount) filter (where tx.type = 'income'), 0) as income,
                   coalesce(sum(tx.amount) filter (where tx.type = 'expense'), 0) as expense
                   from public.transactions tx
                  where tx.user_id = v_user_id
                    and tx.date >= date_trunc('month', v_today)::date
                      - make_interval(months => month_offset.n)
                    and tx.date < date_trunc('month', v_today)::date
                      - make_interval(months => month_offset.n - 1)
               ) monthly
              where monthly.expense <= 0
                 or (monthly.income - monthly.expense)::numeric / monthly.expense
                      < coalesce((a.criteria->>'ratio')::numeric, 0)
           )
         else false
       end
  loop
    insert into public.user_achievements (user_id, achievement_id)
    values (v_user_id, v_achievement.id)
    on conflict (user_id, achievement_id) do nothing;

    if found then
      v_total_points := v_total_points + v_achievement.points_reward;
      v_unlocked := v_unlocked || jsonb_build_array(jsonb_build_object(
        'name_key', v_achievement.name_key,
        'points_reward', v_achievement.points_reward
      ));

      insert into public.points_log (user_id, action, delta, reason)
      values (
        v_user_id,
        'achievement',
        v_achievement.points_reward,
        'Achievement: ' || v_achievement.code
      );
    end if;
  end loop;

  update public.gamification_state
     set streak_current = v_streak,
         streak_longest = greatest(v_state.streak_longest, v_streak),
         last_log_date = case
           when v_state.last_log_date is distinct from v_today then v_today
           else v_state.last_log_date
         end,
         points = v_state.points + v_daily_points + v_total_points,
         level = case
           when v_state.points + v_daily_points + v_total_points >= 7000 then 10
           when v_state.points + v_daily_points + v_total_points >= 5600 then 9
           when v_state.points + v_daily_points + v_total_points >= 4200 then 8
           when v_state.points + v_daily_points + v_total_points >= 3000 then 7
           when v_state.points + v_daily_points + v_total_points >= 2200 then 6
           when v_state.points + v_daily_points + v_total_points >= 1500 then 5
           when v_state.points + v_daily_points + v_total_points >= 1000 then 4
           when v_state.points + v_daily_points + v_total_points >= 600 then 3
           when v_state.points + v_daily_points + v_total_points >= 250 then 2
           else 1
         end,
         updated_at = statement_timestamp()
   where user_id = v_user_id;

  return jsonb_build_object(
    'points_earned', v_daily_points,
    'unlocked', v_unlocked
  );
end;
$$;

revoke all on function public.award_transaction_rewards() from public;
revoke all on function public.award_transaction_rewards() from anon;
grant execute on function public.award_transaction_rewards() to authenticated;

-- Reward state is now writable only through the authenticated, serialized
-- function above; users can no longer grant themselves points via table writes.
revoke insert, update on public.gamification_state from authenticated;
revoke insert on public.points_log from authenticated;
revoke insert on public.user_achievements from authenticated;

notify pgrst, 'reload schema';
