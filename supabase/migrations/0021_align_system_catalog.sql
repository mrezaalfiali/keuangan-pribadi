-- Make the live database match what the app was written for.
--
-- Three independent repairs, in the order they depend on each other:
--
--   1. Seed the shared catalog (0018 + 0019, idempotent). The app's
--      `ensureDefaultCategories` copies the shared catalog into every account
--      because it cannot see it; a complete system catalog is what stops the
--      copying from restarting.
--   2. Recreate the `categories` policies exactly as 0001 defined them,
--      including `user_id is null` in the select policy. Row level security
--      currently hides the shared catalog from the app, which is the reason
--      every account ends up owning its own copy of the same rows.
--   3. Fold those per-account copies into the shared rows: references are
--      repointed first, a row is only deleted once nothing references it
--      anymore, and a skipped repoint (budget period collision) keeps its row
--      and is reported by the verification query instead of aborting.
--
-- Rules:
--   * rows are matched on (type, normalised slug); the normalisation is the
--     same expression `labels.ts` uses to strip a generated suffix, so this
--     only ever merges rows that would have rendered as the same label.
--   * user rows are only ever merged into a system row (user_id IS NULL),
--     never into another account's row, and never the other way around.
--   * a unique index on the system catalog is created at the end so the
--     duplication cannot come back; it is guarded, so a leftover duplicate
--     reports a notice rather than failing the run.
--
-- Prerequisite: run 0020 first if the verification query at the bottom of
-- that file still returns rows. This script does not repair within-owner
-- duplicates, only the shared catalog.
--
-- Idempotent: running it again changes nothing and reports the same counts.

-- ---------------------------------------------------------------------------
-- 1) Shared catalog: the 13 built-ins from 0001/0018 plus the 14 from 0019.
--    Guarded with `not exists` rather than `on conflict do nothing` because
--    `unique (user_id, slug)` does not constrain rows where user_id is NULL,
--    so `on conflict` would never fire on this table.
-- ---------------------------------------------------------------------------
insert into public.categories (user_id, type, slug, name_key, icon, color, is_system)
select v.user_id, v.type, v.slug, v.name_key, v.icon, v.color, v.is_system
from (values
  (null::uuid, 'income',  'gaji',          'cat.gaji',         'briefcase',       'emerald', true),
  (null::uuid, 'income',  'freelance',     'cat.freelance',    'laptop',          'cyan',    true),
  (null::uuid, 'income',  'investasi',     'cat.investasi',    'trending-up',     'violet',  true),
  (null::uuid, 'income',  'bisnis',        'cat.bisnis',       'store',           'sky',     true),
  (null::uuid, 'income',  'lainnya-in',    'cat.incomeLain',   'coffee',          'slate',   true),
  (null::uuid, 'expense', 'makanan',       'cat.makanan',      'utensils',        'amber',   true),
  (null::uuid, 'expense', 'transportasi',  'cat.transportasi', 'car',             'sky',     true),
  (null::uuid, 'expense', 'belanja',       'cat.belanja',      'shopping-bag',    'rose',    true),
  (null::uuid, 'expense', 'tagihan',       'cat.tagihan',      'receipt',         'violet',  true),
  (null::uuid, 'expense', 'hiburan',       'cat.hiburan',      'clapperboard',    'pink',    true),
  (null::uuid, 'expense', 'kesehatan',     'cat.kesehatan',    'heart-pulse',     'red',     true),
  (null::uuid, 'expense', 'pendidikan',    'cat.pendidikan',   'graduation-cap',  'blue',    true),
  (null::uuid, 'expense', 'lainnya-ex',    'cat.expenseLain',  'circle-ellipsis', 'slate',   true),
  (null::uuid, 'expense', 'self-reward',   'cat.selfReward',   'sparkles',        'pink',    true),
  (null::uuid, 'expense', 'keluarga',      'cat.family',       'heart-handshake', 'rose',    true),
  (null::uuid, 'expense', 'anak',          'cat.children',     'baby',            'cyan',    true),
  (null::uuid, 'expense', 'rumah-tangga',  'cat.household',    'house',           'amber',   true),
  (null::uuid, 'expense', 'perawatan-diri','cat.personalCare', 'flower-2',        'violet',  true),
  (null::uuid, 'expense', 'komunikasi',    'cat.communication','wifi',            'blue',    true),
  (null::uuid, 'expense', 'kendaraan',     'cat.vehicle',      'wrench',          'sky',     true),
  (null::uuid, 'expense', 'hewan-peliharaan','cat.pets',       'paw-print',       'orange',  true),
  (null::uuid, 'expense', 'hadiah',        'cat.gifts',        'gift',            'pink',    true),
  (null::uuid, 'expense', 'donasi',        'cat.donations',    'hand-heart',      'emerald', true),
  (null::uuid, 'expense', 'langganan',     'cat.subscriptions','repeat',          'violet',  true),
  (null::uuid, 'expense', 'olahraga',      'cat.fitness',      'dumbbell',        'red',     true),
  (null::uuid, 'expense', 'liburan',       'cat.travel',       'plane',           'cyan',    true),
  (null::uuid, 'expense', 'pajak',         'cat.tax',          'landmark',        'slate',   true)
) as v(user_id, type, slug, name_key, icon, color, is_system)
where not exists (
  select 1
  from public.categories c
  where c.user_id is null and c.type = v.type and c.slug = v.slug
);

-- ---------------------------------------------------------------------------
-- 2) Row level security: drop whatever is there and recreate the four
--    policies 0001 declared. The select policy is the one that matters — it
--    must allow the shared catalog (`user_id is null`) to be read.
-- ---------------------------------------------------------------------------
do $$
declare pol record;
begin
  for pol in
    select policyname
    from pg_policies
    where schemaname = 'public' and tablename = 'categories'
  loop
    execute format('drop policy %I on public.categories', pol.policyname);
  end loop;
end $$;

create policy "categories select" on public.categories
  for select using (user_id is null or auth.uid() = user_id);
create policy "categories insert own" on public.categories
  for insert with check (user_id = auth.uid());
create policy "categories update own" on public.categories
  for update using (user_id = auth.uid());
create policy "categories delete own" on public.categories
  for delete using (user_id = auth.uid());

alter table public.categories enable row level security;

-- ---------------------------------------------------------------------------
-- 3) Build the merge map: every row that renders as a shared label but is not
--    the shared row itself. Matched on the same normalisation labels.ts uses.
-- ---------------------------------------------------------------------------
drop table if exists system_category_merge_map;

create temporary table system_category_merge_map as
with normalised as (
  select
    c.id,
    c.user_id,
    c.type,
    case
      when c.slug ~ '^.+-[^-]+$'
        and length(substring(c.slug from '-([^-]+)$')) >= 5
        and substring(c.slug from '-([^-]+)$') ~ '[0-9]'
      then regexp_replace(c.slug, '-[^-]+$', '')
      else c.slug
    end as norm_slug
  from public.categories c
),
canonical as (
  -- one shared row per (type, norm_slug), picked deterministically by id;
  -- PostgreSQL has no min(uuid) aggregate, so distinct on does the picking
  select distinct on (type, norm_slug)
    type,
    norm_slug,
    id as canonical_id
  from normalised
  where user_id is null
  order by type, norm_slug, id
),
duplicates as (
  -- per-account copies (and suffixed leftovers) folding into the shared row.
  -- canonical holds exactly one row per (type, norm_slug), so this join is 1:1
  select
    n.id as duplicate_id,
    k.canonical_id
  from normalised n
  join canonical k
    on k.type = n.type
   and k.norm_slug = n.norm_slug
  where n.user_id is not null
  union
  -- second and later copies of a shared row (e.g. 0018 run twice)
  select n.id, k.canonical_id
  from normalised n
  join canonical k
    on k.type = n.type
   and k.norm_slug = n.norm_slug
  where n.user_id is null
    and n.id <> k.canonical_id
)
select duplicate_id, canonical_id
from duplicates;

-- ---------------------------------------------------------------------------
-- 4) Repoint every reference before anything is deleted. All five foreign
--    keys are `on delete set null`, so skipping this step would blank labels
--    on screen instead of failing.
-- ---------------------------------------------------------------------------
update public.transactions t
set category_id = m.canonical_id
from system_category_merge_map m
where m.duplicate_id = t.category_id;

update public.transactions t
set funding_source_id = m.canonical_id
from system_category_merge_map m
where m.duplicate_id = t.funding_source_id;

update public.recurring_transactions r
set category_id = m.canonical_id
from system_category_merge_map m
where m.duplicate_id = r.category_id;

update public.recurring_transactions r
set funding_source_id = m.canonical_id
from system_category_merge_map m
where m.duplicate_id = r.funding_source_id;

update public.allocation_rules a
set source_category_id = m.canonical_id
from system_category_merge_map m
where m.duplicate_id = a.source_category_id;

-- budgets.scope_id is a bare uuid guarded by unique (user_id, scope, scope_id,
-- starts_on). Repoint only when the canonical row does not already own a budget
-- for the same period; anything skipped keeps its category and is reported by
-- the verification query instead of aborting the whole run.
update public.budgets b
set scope_id = m.canonical_id
from system_category_merge_map m
where b.scope = 'category'
  and m.duplicate_id = b.scope_id
  and not exists (
    select 1
    from public.budgets kept
    where kept.id <> b.id
      and kept.user_id = b.user_id
      and kept.scope = b.scope
      and kept.starts_on = b.starts_on
      and kept.scope_id = m.canonical_id
  );

-- ---------------------------------------------------------------------------
-- 5) Delete what nothing references anymore. Each row is re-checked against
--    all five references so a skipped repoint can never orphan data.
-- ---------------------------------------------------------------------------
delete from public.categories c
using system_category_merge_map m
where c.id = m.duplicate_id
  and not exists (
    select 1 from public.transactions t
    where t.category_id = c.id or t.funding_source_id = c.id
  )
  and not exists (
    select 1 from public.recurring_transactions r
    where r.category_id = c.id or r.funding_source_id = c.id
  )
  and not exists (
    select 1 from public.allocation_rules a
    where a.source_category_id = c.id
  )
  and not exists (
    select 1 from public.budgets b
    where b.scope = 'category' and b.scope_id = c.id
  );

select count(*) as merged_rows from system_category_merge_map;

drop table system_category_merge_map;

-- ---------------------------------------------------------------------------
-- 6) Guard the shared catalog so it cannot split again. `unique (user_id,
--    slug)` does not constrain NULL user_id, so only the shared side needs an
--    index. Guarded: a leftover duplicate raises a notice instead of failing.
-- ---------------------------------------------------------------------------
do $$
begin
  create unique index if not exists idx_categories_system_slug
    on public.categories (type, slug)
    where user_id is null;
exception
  when others then
    raise warning 'idx_categories_system_slug was not created: %', sqlerrm;
end $$;

notify pgrst, 'reload schema';

-- ---------------------------------------------------------------------------
-- Verification.
--   a) the four policies are back — 4 rows.
--   b) the shared catalog is complete — 27 rows.
--   c) no account shadows a shared row — 0 rows.
--   d) no shared row has a twin — 0 rows.
--   e) no two rows of one owner render the same label — 0 rows
--      (if this returns rows, run 0020 again).
-- ---------------------------------------------------------------------------
select policyname
from pg_policies
where schemaname = 'public' and tablename = 'categories'
order by policyname;

select count(*) as system_rows
from public.categories
where user_id is null;

select u.user_id, u.type, u.slug
from public.categories u
join public.categories s
  on s.user_id is null and s.type = u.type and s.slug = u.slug
where u.user_id is not null;

select type, slug, count(*) as rows_left
from public.categories
where user_id is null
group by type, slug
having count(*) > 1;

with normalised as (
  select
    coalesce(c.user_id::text, '(system)') as owner,
    c.type,
    case
      when c.slug ~ '^.+-[^-]+$'
        and length(substring(c.slug from '-([^-]+)$')) >= 5
        and substring(c.slug from '-([^-]+)$') ~ '[0-9]'
      then regexp_replace(c.slug, '-[^-]+$', '')
      else c.slug
    end as norm_slug,
    c.slug
  from public.categories c
)
select owner, type, norm_slug, count(*) as rows_left, string_agg(slug, ' | ' order by slug) as slugs
from normalised
group by owner, type, norm_slug
having count(*) > 1;
