-- ============================================================
-- Keuangan Pribadi — Initial schema + RLS + seed
-- Apply via: supabase db push  (or the Supabase SQL editor)
-- ============================================================

create extension if not exists pgcrypto;

-- ------------------------------------------------------------
-- LEGACY GUARD
--
-- Everything below uses `create table if not exists`, so on a database
-- whose tables came from an older version of the app every statement is a
-- silent no-op and the script then dies further down on a column that was
-- never created:
--
--   ERROR: 42703: column "date" does not exist
--
-- Fail loudly and actionably here instead of 100 lines later.
-- ------------------------------------------------------------
do $$
begin
  if exists (
      select 1 from information_schema.columns
      where table_schema = 'public' and table_name = 'transactions'
    )
    and not exists (
      select 1 from information_schema.columns
      where table_schema = 'public' and table_name = 'transactions'
        and column_name = 'date'
    ) then
    raise exception
      '0001 cannot repair this database: public.transactions already exists but was created without the "date" column, so the create-table statements below are silently skipped. Run supabase/migrations/0002_complete_supabase_schema.sql followed by supabase/migrations/0003_align_legacy_schema.sql instead.';
  end if;
end $$;

-- ------------------------------------------------------------
-- PROFILES
-- ------------------------------------------------------------
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text,
  currency text not null default 'IDR',
  monthly_income integer not null default 0,
  onboarded boolean not null default false,
  created_at timestamptz not null default now()
);

alter table public.profiles enable row level security;

create policy "profiles select own" on public.profiles
  for select using (auth.uid() = id);
create policy "profiles insert own" on public.profiles
  for insert with check (auth.uid() = id);
create policy "profiles update own" on public.profiles
  for update using (auth.uid() = id);

-- ------------------------------------------------------------
-- CATEGORIES (system rows have user_id = NULL)
-- ------------------------------------------------------------
create table if not exists public.categories (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete cascade,
  type text not null check (type in ('income','expense')),
  slug text not null,
  name_key text,
  icon text,
  color text,
  is_system boolean not null default false,
  unique (user_id, slug)
);
create index if not exists idx_categories_user on public.categories(user_id);

alter table public.categories enable row level security;

create policy "categories select" on public.categories
  for select using (user_id is null or auth.uid() = user_id);
create policy "categories insert own" on public.categories
  for insert with check (user_id = auth.uid());
create policy "categories update own" on public.categories
  for update using (user_id = auth.uid());
create policy "categories delete own" on public.categories
  for delete using (user_id = auth.uid());

-- ------------------------------------------------------------
-- VAULTS
-- ------------------------------------------------------------
create table if not exists public.vaults (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  slug text not null,
  name_key text,
  name text,
  icon text,
  color text,
  target_amount integer,
  is_locked boolean not null default false,
  locked_until timestamptz,
  priority integer not null default 0,
  unique (user_id, slug)
);
create index if not exists idx_vaults_user on public.vaults(user_id);

alter table public.vaults enable row level security;

create policy "vaults select own" on public.vaults
  for select using (auth.uid() = user_id);
create policy "vaults insert own" on public.vaults
  for insert with check (auth.uid() = user_id);
create policy "vaults update own" on public.vaults
  for update using (auth.uid() = user_id);
create policy "vaults delete own" on public.vaults
  for delete using (auth.uid() = user_id);

-- ------------------------------------------------------------
-- TRANSACTIONS (double-entry lite: income/expense/transfer)
-- ------------------------------------------------------------
create table if not exists public.transactions (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  type text not null check (type in ('income','expense','transfer')),
  category_id uuid references public.categories(id) on delete set null,
  vault_id uuid references public.vaults(id) on delete set null,
  amount integer not null check (amount > 0),
  date date not null default current_date,
  note text,
  created_at timestamptz not null default now()
);
create index if not exists idx_tx_user_date on public.transactions(user_id, date desc);
create index if not exists idx_tx_user_type on public.transactions(user_id, type);

alter table public.transactions enable row level security;

create policy "transactions select own" on public.transactions
  for select using (auth.uid() = user_id);
create policy "transactions insert own" on public.transactions
  for insert with check (auth.uid() = user_id);
create policy "transactions update own" on public.transactions
  for update using (auth.uid() = user_id);
create policy "transactions delete own" on public.transactions
  for delete using (auth.uid() = user_id);

-- ------------------------------------------------------------
-- ALLOCATION RULES + SLOTS
-- ------------------------------------------------------------
create table if not exists public.allocation_rules (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text,
  source_category_id uuid references public.categories(id) on delete set null,
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);
create index if not exists idx_alloc_rules_user on public.allocation_rules(user_id);

alter table public.allocation_rules enable row level security;

create policy "alloc rules select own" on public.allocation_rules
  for select using (auth.uid() = user_id);
create policy "alloc rules insert own" on public.allocation_rules
  for insert with check (auth.uid() = user_id);
create policy "alloc rules update own" on public.allocation_rules
  for update using (auth.uid() = user_id);
create policy "alloc rules delete own" on public.allocation_rules
  for delete using (auth.uid() = user_id);

create table if not exists public.allocation_slots (
  id uuid primary key default gen_random_uuid(),
  rule_id uuid not null references public.allocation_rules(id) on delete cascade,
  vault_id uuid not null references public.vaults(id) on delete cascade,
  method text not null check (method in ('percent','amount','remainder')),
  value numeric not null default 0,
  priority integer not null default 0
);
create index if not exists idx_alloc_slots_rule on public.allocation_slots(rule_id);

alter table public.allocation_slots enable row level security;

create policy "alloc slots select own" on public.allocation_slots
  for select using (
    exists (select 1 from public.allocation_rules r where r.id = rule_id and r.user_id = auth.uid())
  );
create policy "alloc slots insert own" on public.allocation_slots
  for insert with check (
    exists (select 1 from public.allocation_rules r where r.id = rule_id and r.user_id = auth.uid())
  );
create policy "alloc slots update own" on public.allocation_slots
  for update using (
    exists (select 1 from public.allocation_rules r where r.id = rule_id and r.user_id = auth.uid())
  );
create policy "alloc slots delete own" on public.allocation_slots
  for delete using (
    exists (select 1 from public.allocation_rules r where r.id = rule_id and r.user_id = auth.uid())
  );

-- ------------------------------------------------------------
-- BUDGETS (budget limits + alert threshold)
-- ------------------------------------------------------------
create table if not exists public.budgets (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  scope text not null check (scope in ('category','vault')),
  scope_id uuid not null,
  month date not null,
  limit_amount integer not null check (limit_amount > 0),
  alert_threshold numeric not null default 0.8 check (alert_threshold between 0 and 1),
  unique (user_id, scope, scope_id, month)
);
create index if not exists idx_budgets_user on public.budgets(user_id, month);

alter table public.budgets enable row level security;

create policy "budgets select own" on public.budgets
  for select using (auth.uid() = user_id);
create policy "budgets insert own" on public.budgets
  for insert with check (auth.uid() = user_id);
create policy "budgets update own" on public.budgets
  for update using (auth.uid() = user_id);
create policy "budgets delete own" on public.budgets
  for delete using (auth.uid() = user_id);

-- ------------------------------------------------------------
-- GAMIFICATION
-- ------------------------------------------------------------
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

create policy "gamification select own" on public.gamification_state
  for select using (auth.uid() = user_id);
create policy "gamification insert own" on public.gamification_state
  for insert with check (auth.uid() = user_id);
create policy "gamification update own" on public.gamification_state
  for update using (auth.uid() = user_id);

create table if not exists public.points_log (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  action text not null,
  delta integer not null,
  reason text,
  created_at timestamptz not null default now()
);
create index if not exists idx_points_user on public.points_log(user_id, created_at desc);

alter table public.points_log enable row level security;

create policy "points select own" on public.points_log
  for select using (auth.uid() = user_id);
create policy "points insert own" on public.points_log
  for insert with check (auth.uid() = user_id);

-- ACHIEVEMENTS (system catalog, readable by everyone)
create table if not exists public.achievements (
  id uuid primary key default gen_random_uuid(),
  code text unique not null,
  name_key text not null,
  description_key text not null,
  icon text,
  points_reward integer not null default 0,
  criteria jsonb not null
);

alter table public.achievements enable row level security;

create policy "achievements select all" on public.achievements
  for select using (true);

create table if not exists public.user_achievements (
  user_id uuid not null references auth.users(id) on delete cascade,
  achievement_id uuid not null references public.achievements(id) on delete cascade,
  unlocked_at timestamptz not null default now(),
  primary key (user_id, achievement_id)
);
create index if not exists idx_user_ach_user on public.user_achievements(user_id);

alter table public.user_achievements enable row level security;

create policy "user ach select own" on public.user_achievements
  for select using (auth.uid() = user_id);
create policy "user ach insert own" on public.user_achievements
  for insert with check (auth.uid() = user_id);

-- ------------------------------------------------------------
-- SEED: system categories
-- ------------------------------------------------------------
insert into public.categories (user_id, type, slug, name_key, icon, color, is_system) values
  (null, 'income',  'gaji',      'cat.gaji',        'briefcase',  'emerald', true),
  (null, 'income',  'freelance', 'cat.freelance',   'laptop',     'cyan',    true),
  (null, 'income',  'investasi', 'cat.investasi',   'trending-up','violet',  true),
  (null, 'income',  'bisnis',    'cat.bisnis',      'store',      'sky',     true),
  (null, 'income',  'lainnya',   'cat.incomeLain',  'coffee',     'slate',   true),
  (null, 'expense', 'makanan',   'cat.makanan',     'utensils',   'amber',   true),
  (null, 'expense', 'transportasi','cat.transportasi','car',      'sky',     true),
  (null, 'expense', 'belanja',   'cat.belanja',     'shopping-bag','rose',   true),
  (null, 'expense', 'tagihan',   'cat.tagihan',     'receipt',    'violet',  true),
  (null, 'expense', 'hiburan',   'cat.hiburan',     'clapperboard','pink',   true),
  (null, 'expense', 'kesehatan', 'cat.kesehatan',   'heart-pulse', 'red',    true),
  (null, 'expense', 'pendidikan','cat.pendidikan',  'graduation-cap','blue', true),
  (null, 'expense', 'lainnya',   'cat.expenseLain', 'circle-ellipsis','slate', true)
on conflict do nothing;

-- ------------------------------------------------------------
-- SEED: achievement catalog
-- ------------------------------------------------------------
insert into public.achievements (code, name_key, description_key, icon, points_reward, criteria) values
  ('first_transaction',  'ach.firstTx.name', 'ach.firstTx.desc',  'play',        25,  '{"type":"transaction_count","count":1}'),
  ('streak_3',           'ach.streak3.name', 'ach.streak3.desc',  'flame',       40,  '{"type":"streak_days","days":3}'),
  ('streak_7',           'ach.streak7.name', 'ach.streak7.desc',  'flame',      100,  '{"type":"streak_days","days":7}'),
  ('streak_30',          'ach.streak30.name','ach.streak30.desc', 'flame',      300,  '{"type":"streak_days","days":30}'),
  ('tx_50',              'ach.tx50.name',    'ach.tx50.desc',     'list-check',  80,  '{"type":"transaction_count","count":50}'),
  ('tx_500',             'ach.tx500.name',   'ach.tx500.desc',    'list-check', 250,  '{"type":"transaction_count","count":500}'),
  ('vault_darat_target', 'ach.vaultDaratTarget.name','ach.vaultDaratTarget.desc','target', 75, '{"type":"vault_goal","vault_slug":"darurat","ratio":0.9}'),
  ('vault_tabungan_target','ach.vaultTabunganTarget.name','ach.vaultTabunganTarget.desc','piggy-bank', 75, '{"type":"vault_goal","vault_slug":"tabungan","ratio":0.9}'),
  ('safe_darat_1m',      'ach.safeDarat1m.name', 'ach.safeDarat1m.desc','shield-check', 100, '{"type":"no_vault_withdraw","vault_slug":"darurat","months":1}'),
  ('safe_darat_3m',      'ach.safeDarat3m.name', 'ach.safeDarat3m.desc','shield-check', 250, '{"type":"no_vault_withdraw","vault_slug":"darurat","months":3}'),
  ('safe_darat_6m',      'ach.safeDarat6m.name', 'ach.safeDarat6m.desc','shield-check', 500, '{"type":"no_vault_withdraw","vault_slug":"darurat","months":6}'),
  ('savings_ratio_20',   'ach.ratio20.name',   'ach.ratio20.desc', 'gauge', 150, '{"type":"savings_ratio","ratio":0.2,"months":1}')
on conflict (code) do nothing;