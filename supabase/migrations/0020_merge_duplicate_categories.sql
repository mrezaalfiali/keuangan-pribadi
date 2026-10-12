-- Merge category rows that render as the same label.
--
-- A legacy slug normalisation (0003) renames colliding rows to
-- `<slug>-<first 8 chars of id>` and keeps them. `labels.ts` strips that suffix
-- back off for display, so `hiburan` and `hiburan-d22c0e0e` both show up as
-- "Hiburan" in every category picker.
--
-- Rules:
--   * rows are partitioned per (user_id, type, normalised slug). System rows
--     (user_id IS NULL) are never merged with a user's rows: row level security
--     currently hides the shared catalog from the app, so repointing a
--     transaction at a system row would blank its label on screen.
--   * the canonical row is the one the app's `dedupeCategories` would pick:
--     no generated suffix first, then is_system = false, then oldest id.
--   * references are repointed before anything is deleted, and a row is only
--     deleted once nothing references it anymore.
--
-- Idempotent: running it again reports no duplicates and changes nothing.

drop table if exists category_merge_map;

create temporary table category_merge_map as
with normalised as (
  select
    c.id,
    c.user_id,
    c.type,
    c.slug,
    c.is_system,
    c.created_at,
    case
      when c.slug ~ '^.+-[^-]+$'
        and length(substring(c.slug from '-([^-]+)$')) >= 5
        and substring(c.slug from '-([^-]+)$') ~ '[0-9]'
      then regexp_replace(c.slug, '-[^-]+$', '')
      else c.slug
    end as norm_slug
  from public.categories c
),
ranked as (
  select
    n.id,
    n.user_id,
    n.type,
    n.slug,
    n.norm_slug,
    row_number() over (
      partition by n.user_id, n.type, n.norm_slug
      order by
        case when n.slug = n.norm_slug then 0 else 1 end,
        n.is_system,
        n.created_at,
        n.id
    ) as row_rank
  from normalised n
)
select
  d.id as duplicate_id,
  k.id as canonical_id
from ranked d
join ranked k
  on k.user_id is not distinct from d.user_id
 and k.type = d.type
 and k.norm_slug = d.norm_slug
 and k.row_rank = 1
where d.row_rank > 1;

update public.transactions t
set category_id = m.canonical_id
from category_merge_map m
where m.duplicate_id = t.category_id;

update public.transactions t
set funding_source_id = m.canonical_id
from category_merge_map m
where m.duplicate_id = t.funding_source_id;

update public.recurring_transactions r
set category_id = m.canonical_id
from category_merge_map m
where m.duplicate_id = r.category_id;

update public.recurring_transactions r
set funding_source_id = m.canonical_id
from category_merge_map m
where m.duplicate_id = r.funding_source_id;

update public.allocation_rules a
set source_category_id = m.canonical_id
from category_merge_map m
where m.duplicate_id = a.source_category_id;

-- budgets.scope_id is a bare uuid guarded by unique (user_id, scope, scope_id,
-- starts_on). Repoint only when the canonical row does not already own a budget
-- for the same period; anything skipped keeps its category and is reported by
-- the verification query below instead of aborting the whole run.
update public.budgets b
set scope_id = m.canonical_id
from category_merge_map m
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

delete from public.categories c
using category_merge_map m
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

drop table category_merge_map;

-- Verification: this must return zero rows.
with normalised as (
  select
    coalesce(c.user_id::text, '(system)') as owner,
    c.type,
    c.slug,
    case
      when c.slug ~ '^.+-[^-]+$'
        and length(substring(c.slug from '-([^-]+)$')) >= 5
        and substring(c.slug from '-([^-]+)$') ~ '[0-9]'
      then regexp_replace(c.slug, '-[^-]+$', '')
      else c.slug
    end as norm_slug
  from public.categories c
)
select owner, type, norm_slug, count(*) as rows_left, string_agg(slug, ' | ' order by slug) as slugs
from normalised
group by owner, type, norm_slug
having count(*) > 1;
