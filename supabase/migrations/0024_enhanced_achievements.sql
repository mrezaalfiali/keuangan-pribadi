-- ============================================================
-- 0024 — Enhanced gamification achievements & standalone sync
--
-- Adds new achievement catalog items (first vault, first budget,
-- first note, 100 tx, 100-day streak), improves vault matching
-- (handles 'dana-darurat', 'tabungan-utama', etc.), and exposes
-- `check_user_achievements()` so users can claim achievements at any time.
--
-- Run manually in the Supabase SQL Editor after migration 0023.
-- Re-running this migration is safe.
-- ============================================================

-- 1. Insert new achievements
insert into public.achievements (code, name_key, description_key, icon, points_reward, criteria) values
  ('streak_100',   'ach.streak100.name',  'ach.streak100.desc',  'flame',      500, '{"type":"streak_days","days":100}'),
  ('tx_100',       'ach.tx100.name',      'ach.tx100.desc',      'list-check', 120, '{"type":"transaction_count","count":100}'),
  ('first_vault',  'ach.firstVault.name', 'ach.firstVault.desc', 'vault',       40,  '{"type":"vault_count","count":1}'),
  ('first_budget', 'ach.firstBudget.name','ach.firstBudget.desc','pie-chart',   40,  '{"type":"budget_count","count":1}'),
  ('first_note',   'ach.firstNote.name',  'ach.firstNote.desc',  'file-text',   25,  '{"type":"note_count","count":1}')
on conflict (code) do nothing;

-- 2. Standalone achievement checker
create or replace function public.check_user_achievements()
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
  v_transaction_count bigint;
  v_vault_count bigint;
  v_budget_count bigint;
  v_note_count bigint;
  v_achievement record;
  v_unlocked jsonb := '[]'::jsonb;
  v_total_points integer := 0;
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

  v_streak := coalesce(v_state.streak_current, 0);

  select count(distinct coalesce(group_id::text, id::text))
    into v_transaction_count
    from public.transactions
   where user_id = v_user_id;

  select count(*)
    into v_vault_count
    from public.vaults
   where user_id = v_user_id;

  select count(*)
    into v_budget_count
    from public.budgets
   where user_id = v_user_id;

  if to_regclass('public.notes') is not null then
    select count(*)
      into v_note_count
      from public.notes
     where user_id = v_user_id;
  else
    v_note_count := 0;
  end if;

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
         when 'vault_count' then
           v_vault_count >= coalesce((a.criteria->>'count')::integer, 2147483647)
         when 'budget_count' then
           v_budget_count >= coalesce((a.criteria->>'count')::integer, 2147483647)
         when 'note_count' then
           v_note_count >= coalesce((a.criteria->>'count')::integer, 2147483647)
         when 'vault_goal' then
           exists (
             select 1
               from public.vaults v
              where v.user_id = v_user_id
                and (
                  a.criteria->>'vault_slug' is null
                  or a.criteria->>'vault_slug' = 'any'
                  or v.slug = a.criteria->>'vault_slug'
                  or v.slug like '%' || (a.criteria->>'vault_slug') || '%'
                  or lower(v.name) like '%' || lower(a.criteria->>'vault_slug') || '%'
                )
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
                and (
                  a.criteria->>'vault_slug' is null
                  or a.criteria->>'vault_slug' = 'any'
                  or v.slug = a.criteria->>'vault_slug'
                  or v.slug like '%' || (a.criteria->>'vault_slug') || '%'
                  or lower(v.name) like '%' || lower(a.criteria->>'vault_slug') || '%'
                )
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
           exists (
             select 1
               from (
                 select
                   coalesce(sum(tx.amount) filter (where tx.type = 'income'), 0) as income,
                   coalesce(sum(tx.amount) filter (where tx.type = 'expense'), 0) as expense
                   from public.transactions tx
                  where tx.user_id = v_user_id
                    and tx.date >= date_trunc('month', v_today)::date
               ) cur
              where cur.income > 0
                and (cur.income - cur.expense)::numeric / cur.income >= coalesce((a.criteria->>'ratio')::numeric, 0)
           )
           or not exists (
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

  if v_total_points > 0 then
    update public.gamification_state
       set points = points + v_total_points,
           level = case
             when points + v_total_points >= 7000 then 10
             when points + v_total_points >= 5600 then 9
             when points + v_total_points >= 4200 then 8
             when points + v_total_points >= 3000 then 7
             when points + v_total_points >= 2200 then 6
             when points + v_total_points >= 1500 then 5
             when points + v_total_points >= 1000 then 4
             when points + v_total_points >= 600 then 3
             when points + v_total_points >= 250 then 2
             else 1
           end,
           updated_at = statement_timestamp()
     where user_id = v_user_id;
  end if;

  return jsonb_build_object(
    'unlocked', v_unlocked,
    'total_points_added', v_total_points
  );
end;
$$;

-- 3. Upgrade award_transaction_rewards to also include the new checks & matching
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
  v_vault_count bigint;
  v_budget_count bigint;
  v_note_count bigint;
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

  select count(*)
    into v_vault_count
    from public.vaults
   where user_id = v_user_id;

  select count(*)
    into v_budget_count
    from public.budgets
   where user_id = v_user_id;

  if to_regclass('public.notes') is not null then
    select count(*)
      into v_note_count
      from public.notes
     where user_id = v_user_id;
  else
    v_note_count := 0;
  end if;

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
         when 'vault_count' then
           v_vault_count >= coalesce((a.criteria->>'count')::integer, 2147483647)
         when 'budget_count' then
           v_budget_count >= coalesce((a.criteria->>'count')::integer, 2147483647)
         when 'note_count' then
           v_note_count >= coalesce((a.criteria->>'count')::integer, 2147483647)
         when 'vault_goal' then
           exists (
             select 1
               from public.vaults v
              where v.user_id = v_user_id
                and (
                  a.criteria->>'vault_slug' is null
                  or a.criteria->>'vault_slug' = 'any'
                  or v.slug = a.criteria->>'vault_slug'
                  or v.slug like '%' || (a.criteria->>'vault_slug') || '%'
                  or lower(v.name) like '%' || lower(a.criteria->>'vault_slug') || '%'
                )
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
                and (
                  a.criteria->>'vault_slug' is null
                  or a.criteria->>'vault_slug' = 'any'
                  or v.slug = a.criteria->>'vault_slug'
                  or v.slug like '%' || (a.criteria->>'vault_slug') || '%'
                  or lower(v.name) like '%' || lower(a.criteria->>'vault_slug') || '%'
                )
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
           exists (
             select 1
               from (
                 select
                   coalesce(sum(tx.amount) filter (where tx.type = 'income'), 0) as income,
                   coalesce(sum(tx.amount) filter (where tx.type = 'expense'), 0) as expense
                   from public.transactions tx
                  where tx.user_id = v_user_id
                    and tx.date >= date_trunc('month', v_today)::date
               ) cur
              where cur.income > 0
                and (cur.income - cur.expense)::numeric / cur.income >= coalesce((a.criteria->>'ratio')::numeric, 0)
           )
           or not exists (
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

revoke all on function public.check_user_achievements() from public;
revoke all on function public.check_user_achievements() from anon;
grant execute on function public.check_user_achievements() to authenticated;

notify pgrst, 'reload schema';

-- ------------------------------------------------------------
-- SELF-CHECK
-- ------------------------------------------------------------
select
  count(*) as total_achievements,
  exists (
    select 1
    from pg_proc
    where proname = 'check_user_achievements'
  ) as check_fn_exists,
  exists (
    select 1
    from pg_proc
    where proname = 'award_transaction_rewards'
  ) as award_fn_exists
from public.achievements;
