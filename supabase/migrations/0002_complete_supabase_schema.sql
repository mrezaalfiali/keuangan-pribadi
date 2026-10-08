-- Adds account data tables that may be missing from a partially applied 0001.
-- Safe to run more than once.

create extension if not exists pgcrypto;

create table if not exists public.allocation_slots (
  id uuid primary key default gen_random_uuid(),
  rule_id uuid not null references public.allocation_rules(id) on delete cascade,
  vault_id uuid not null references public.vaults(id) on delete cascade,
  method text not null check (method in ('percent', 'amount', 'remainder')),
  value numeric not null default 0,
  priority integer not null default 0
);
create index if not exists idx_alloc_slots_rule
  on public.allocation_slots(rule_id);
alter table public.allocation_slots enable row level security;
drop policy if exists "alloc slots select own" on public.allocation_slots;
create policy "alloc slots select own" on public.allocation_slots
  for select using (
    exists (
      select 1 from public.allocation_rules r
      where r.id = rule_id and r.user_id = auth.uid()
    )
  );
drop policy if exists "alloc slots insert own" on public.allocation_slots;
create policy "alloc slots insert own" on public.allocation_slots
  for insert with check (
    exists (
      select 1 from public.allocation_rules r
      where r.id = rule_id and r.user_id = auth.uid()
    )
  );
drop policy if exists "alloc slots update own" on public.allocation_slots;
create policy "alloc slots update own" on public.allocation_slots
  for update using (
    exists (
      select 1 from public.allocation_rules r
      where r.id = rule_id and r.user_id = auth.uid()
    )
  );
drop policy if exists "alloc slots delete own" on public.allocation_slots;
create policy "alloc slots delete own" on public.allocation_slots
  for delete using (
    exists (
      select 1 from public.allocation_rules r
      where r.id = rule_id and r.user_id = auth.uid()
    )
  );
grant select, insert, update, delete on public.allocation_slots to authenticated;

create table if not exists public.budgets (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  scope text not null check (scope in ('category', 'vault')),
  scope_id uuid not null,
  month date not null,
  limit_amount integer not null check (limit_amount > 0),
  alert_threshold numeric not null default 0.8
    check (alert_threshold between 0 and 1),
  unique (user_id, scope, scope_id, month)
);
create index if not exists idx_budgets_user
  on public.budgets(user_id, month);
alter table public.budgets enable row level security;
drop policy if exists "budgets select own" on public.budgets;
create policy "budgets select own" on public.budgets
  for select using (auth.uid() = user_id);
drop policy if exists "budgets insert own" on public.budgets;
create policy "budgets insert own" on public.budgets
  for insert with check (auth.uid() = user_id);
drop policy if exists "budgets update own" on public.budgets;
create policy "budgets update own" on public.budgets
  for update using (auth.uid() = user_id);
drop policy if exists "budgets delete own" on public.budgets;
create policy "budgets delete own" on public.budgets
  for delete using (auth.uid() = user_id);
grant select, insert, update, delete on public.budgets to authenticated;

create table if not exists public.gamification_state (
  user_id uuid primary key references auth.users(id) on delete cascade,
  points integer not null default 0,
  streak_current integer not null default 0,
  streak_longest integer not null default 0,
  last_log_date date,
  last_checkin_date date,
  level integer not null default 1,
  updated_at timestamptz not null default now()
);
alter table public.gamification_state enable row level security;
drop policy if exists "gamification select own" on public.gamification_state;
create policy "gamification select own" on public.gamification_state
  for select using (auth.uid() = user_id);
drop policy if exists "gamification insert own" on public.gamification_state;
create policy "gamification insert own" on public.gamification_state
  for insert with check (auth.uid() = user_id);
drop policy if exists "gamification update own" on public.gamification_state;
create policy "gamification update own" on public.gamification_state
  for update using (auth.uid() = user_id);
grant select, insert, update on public.gamification_state to authenticated;

create table if not exists public.points_log (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  action text not null,
  delta integer not null,
  reason text,
  created_at timestamptz not null default now()
);
create index if not exists idx_points_user
  on public.points_log(user_id, created_at desc);
alter table public.points_log enable row level security;
drop policy if exists "points select own" on public.points_log;
create policy "points select own" on public.points_log
  for select using (auth.uid() = user_id);
drop policy if exists "points insert own" on public.points_log;
create policy "points insert own" on public.points_log
  for insert with check (auth.uid() = user_id);
grant select, insert on public.points_log to authenticated;

create table if not exists public.user_achievements (
  user_id uuid not null references auth.users(id) on delete cascade,
  achievement_id uuid not null references public.achievements(id) on delete cascade,
  unlocked_at timestamptz not null default now(),
  primary key (user_id, achievement_id)
);
create index if not exists idx_user_ach_user
  on public.user_achievements(user_id);
alter table public.user_achievements enable row level security;
drop policy if exists "user ach select own" on public.user_achievements;
create policy "user ach select own" on public.user_achievements
  for select using (auth.uid() = user_id);
drop policy if exists "user ach insert own" on public.user_achievements;
create policy "user ach insert own" on public.user_achievements
  for insert with check (auth.uid() = user_id);
grant select, insert on public.user_achievements to authenticated;

notify pgrst, 'reload schema';
