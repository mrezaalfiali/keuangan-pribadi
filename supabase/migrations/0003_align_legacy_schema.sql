  -- ============================================================
  -- 0003 — Align a legacy database with the application schema
  --
  -- WHY THIS FILE EXISTS
  -- On a project whose tables were created by an older version of the
  -- app, 0001_init.sql silently did almost nothing. Every statement in
  -- it uses `create table if not exists`, so pre-existing tables were
  -- left in their old shape and never gained the new columns. The run
  -- then aborted at the first statement that referenced a column the
  -- old tables did not have:
  --
  --   0001_init.sql:100  create index ... on public.transactions(user_id, date desc)
  --
  -- That error cancelled the rest of 0001. The result is a database
  -- where some tables match the app and the rest are legacy, and every
  -- page fails to load with "Tidak dapat memuat data dari Supabase".
  --
  -- GUARANTEES
  --   - Nothing is dropped. No table, no column, no row.
  --   - Every statement is idempotent; re-running this file is a no-op.
  --   - Legacy values are copied into the new columns, not discarded.
  --
  -- Run this in the Supabase SQL Editor. It is safe to run repeatedly.
  -- ============================================================


  -- ------------------------------------------------------------
  -- STEP 0 — relax every legacy NOT NULL the app may legitimately omit
  --
  -- Why this is computed instead of a hand-written list: a legacy table can
  -- require a column that neither the app nor the seed below ever sends, and
  -- the insert then fails with a bare 23502. Three separate rounds of that
  -- happened before this block existed (categories.user_id, categories.name,
  -- transactions.name, achievements.user_id) — each time the offending column
  -- was a surprise, because PostgREST cannot reveal nullability and the
  -- legacy schema cannot be fully reconstructed from the app's queries.
  --
  -- So derive it: any NOT NULL column with no default is a column nothing can
  -- be relied upon to fill. Columns that do have a DEFAULT are left alone —
  -- they fill themselves and cannot reject an insert.
  --
  -- Two exclusions:
  --   id        — every row needs one; never nullable.
  --   user_id   — stays NOT NULL on user-owned tables (vaults, transactions,
  --               allocation_*, budgets, gamification_state, points_log).
  --               It is deliberately excluded for categories and achievements,
  --               which are shared catalogs identified by user_id IS NULL:
  --               0001 seeds 13 system categories that way, and the app reads
  --               them with `user_id.is.null,user_id.eq.<uid>`.
  --
  -- Anything dropped here that the app genuinely always sends is re-tightened
  -- further down, after the legacy values have been backfilled.
  -- ------------------------------------------------------------

  do $$
  declare
    relax_target record;
  begin
    for relax_target in
      select table_name, column_name
      from information_schema.columns
      where table_schema = 'public'
        -- Only the six tables this migration actually rewrites. allocation_slots,
        -- budgets, gamification_state and points_log are created wholesale by
        -- 0002 and already match the app, so their NOT NULL columns are genuine
        -- and must survive: allocation_slots.method/value/rule_id, for example,
        -- are sent on every insert and losing the constraint would let a slot
        -- row be written with no vault at all.
        and table_name in (
          'profiles', 'categories', 'vaults',
          'transactions', 'allocation_rules', 'achievements'
        )
        and is_nullable = 'NO'
        and column_name <> 'id'
        and not (
          column_name = 'user_id'
          and table_name not in ('categories', 'achievements')
        )
    loop
      execute format(
        'alter table public.%I alter column %I drop not null',
        relax_target.table_name, relax_target.column_name
      );
      raise notice 'relaxed %.% (NOT NULL with no default)',
        relax_target.table_name, relax_target.column_name;
    end loop;
  end $$;


  -- ------------------------------------------------------------
  -- PROFILES — add display_name, currency, monthly_income, onboarded
  -- ------------------------------------------------------------

  alter table public.profiles add column if not exists display_name text;
  alter table public.profiles add column if not exists currency text;
  alter table public.profiles add column if not exists monthly_income integer;
  alter table public.profiles add column if not exists onboarded boolean;

  update public.profiles set currency = 'IDR' where currency is null;
  update public.profiles set monthly_income = 0 where monthly_income is null;
  update public.profiles set onboarded = false where onboarded is null;

  alter table public.profiles alter column currency set default 'IDR';
  alter table public.profiles alter column currency set not null;
  alter table public.profiles alter column monthly_income set default 0;
  alter table public.profiles alter column monthly_income set not null;
  alter table public.profiles alter column onboarded set default false;
  alter table public.profiles alter column onboarded set not null;

  -- Best-effort display name from the auth account, then from the local
  -- part of the email, mirroring what the app falls back to.
  update public.profiles p
  set display_name = coalesce(
        nullif(btrim(p.display_name), ''),
        nullif(btrim(split_part(u.email, '@', 1)), '')
      )
  from auth.users u
  where u.id = p.id and p.display_name is null;

  -- A legacy `avatar_url` left NOT NULL would reject the app's upsert, which
  -- only ever sends id and display_name.
  do $$
  begin
    if exists (
      select 1 from information_schema.columns
      where table_schema = 'public' and table_name = 'profiles'
        and column_name = 'avatar_url' and is_nullable = 'NO'
    ) then
      alter table public.profiles alter column avatar_url drop not null;
    end if;
  end $$;


  -- ------------------------------------------------------------
  -- CATEGORIES — add type, slug, name_key, icon, is_system
  -- ------------------------------------------------------------

  alter table public.categories add column if not exists type text;
  alter table public.categories add column if not exists slug text;
  alter table public.categories add column if not exists name_key text;
  alter table public.categories add column if not exists icon text;
  alter table public.categories add column if not exists is_system boolean;

  -- Derive a slug from the legacy free-text `name` column when present.
  -- Generation and de-duplication happen in one statement so that two
  -- legacy rows sharing a name under the same user cannot both pick the
  -- same slug. Scoped per user, matching the unique index below.
  do $$
  declare
    source_column text;
  begin
    select case when exists (
        select 1 from information_schema.columns
        where table_schema = 'public' and table_name = 'categories' and column_name = 'name'
      ) then 'name' else 'slug' end
    into source_column;

    execute format($fmt$
      with base as (
        select id, user_id,
          coalesce(
            nullif(btrim(lower(regexp_replace(c.%1$I, '[^a-zA-Z0-9]+', '-', 'g')), '-'), ''),
            'legacy-' || left(id::text, 8)
          ) as candidate
        from public.categories c
        where c.slug is null
      ),
      ranked as (
        select id,
          candidate || case
            when row_number() over (
              partition by coalesce(user_id, '00000000-0000-0000-0000-000000000000'::uuid), candidate
              order by id
            ) = 1 then ''
            else '-' || left(id::text, 8)
          end as final_slug
        from base
      )
      update public.categories c
      set slug = r.final_slug
      from ranked r
      where c.id = r.id
    $fmt$, source_column);
  end $$;

  update public.categories set name_key = null where name_key = '';
  update public.categories set icon = null where icon = '';
  update public.categories set is_system = (user_id is null) where is_system is null;

  -- Legacy categories carry no income/expense signal, so they default to
  -- 'expense'. Re-tag real rows before relying on income budgets.
  update public.categories set type = 'expense' where type is null;

  -- A fresh 0001 schema seeds two system rows that both use the slug
  -- 'lainnya'. Point them at the slugs this migration seeds, so re-seeding
  -- does not add two extra categories on top of them.
  update public.categories set slug = 'lainnya-in'
  where user_id is null and slug = 'lainnya' and type = 'income';
  update public.categories set slug = 'lainnya-ex'
  where user_id is null and slug = 'lainnya' and type = 'expense';

  -- Normalise any slug still shared by two rows of the same user. Must run
  -- before the unique index below, otherwise index creation fails.
  with ranked as (
    select id,
      row_number() over (
        partition by coalesce(user_id, '00000000-0000-0000-0000-000000000000'::uuid), slug
        order by id
      ) as rn
    from public.categories
  )
  update public.categories c
  set slug = c.slug || '-' || left(c.id::text, 8)
  from ranked
  where c.id = ranked.id and ranked.rn > 1;

  -- System rows have user_id IS NULL, and Postgres treats NULLs as distinct
  -- in a unique index. Without coalescing them, re-running the seed below
  -- would insert a second copy of all 13 system categories.
  create unique index if not exists idx_categories_user_slug
    on public.categories (coalesce(user_id, '00000000-0000-0000-0000-000000000000'::uuid), slug);
  create index if not exists idx_categories_user
    on public.categories(user_id);

  alter table public.categories alter column slug set not null;
  alter table public.categories alter column type set default 'expense';
  alter table public.categories alter column type set not null;
  alter table public.categories alter column is_system set default false;
  alter table public.categories alter column is_system set not null;

  do $$
  begin
    if not exists (
      select 1 from pg_constraint
      where conrelid = 'public.categories'::regclass
        and conname = 'categories_type_check'
    ) then
      alter table public.categories
        add constraint categories_type_check check (type in ('income', 'expense')) not valid;
    end if;
  end $$;

  alter table public.categories validate constraint categories_type_check;

  -- Legacy schemas often made user_id NOT NULL, which makes a shared system
  -- catalog impossible — 0001 and every query in the app rely on
  -- user_id IS NULL for those rows.
  do $$
  declare
    nullable_target record;
  begin
    for nullable_target in
      select * from (values
        ('categories',    'user_id'),
        ('vaults',        'name_key'),
        ('vaults',        'icon'),
        ('vaults',        'color'),
        ('vaults',        'target_amount'),
        ('vaults',        'locked_until'),
        ('transactions',  'note'),
        ('transactions',  'category_id'),
        ('transactions',  'vault_id'),
        ('allocation_rules', 'name'),
        ('allocation_rules', 'source_category_id'),
        ('profiles',      'display_name'),
        ('profiles',      'avatar_url')
      ) as t(table_name, column_name)
    loop
      if exists (
        select 1 from information_schema.columns
        where table_schema = 'public'
          and table_name = nullable_target.table_name
          and column_name = nullable_target.column_name
          and is_nullable = 'NO'
      ) then
        execute format(
          'alter table public.%I alter column %I drop not null',
          nullable_target.table_name, nullable_target.column_name
        );
        raise notice 'relaxed %.%: drop not null',
          nullable_target.table_name, nullable_target.column_name;
      end if;
    end loop;
  end $$;


  -- ------------------------------------------------------------
  -- VAULTS — add slug, name_key, icon, color, priority
  -- ------------------------------------------------------------

  alter table public.vaults add column if not exists slug text;
  alter table public.vaults add column if not exists name_key text;
  alter table public.vaults add column if not exists icon text;
  alter table public.vaults add column if not exists color text;
  alter table public.vaults add column if not exists priority integer;

  do $$
  declare
    source_column text;
  begin
    select case when exists (
        select 1 from information_schema.columns
        where table_schema = 'public' and table_name = 'vaults' and column_name = 'name'
      ) then 'name' else 'slug' end
    into source_column;

    execute format($fmt$
      with base as (
        select id, user_id,
          coalesce(
            nullif(btrim(lower(regexp_replace(v.%1$I, '[^a-zA-Z0-9]+', '-', 'g')), '-'), ''),
            'vault-' || left(id::text, 8)
          ) as candidate
        from public.vaults v
        where v.slug is null
      ),
      ranked as (
        select id,
          candidate || case
            when row_number() over (
              partition by coalesce(user_id, '00000000-0000-0000-0000-000000000000'::uuid), candidate
              order by id
            ) = 1 then ''
            else '-' || left(id::text, 8)
          end as final_slug
        from base
      )
      update public.vaults v
      set slug = r.final_slug
      from ranked r
      where v.id = r.id
    $fmt$, source_column);
  end $$;

  update public.vaults set name_key = null where name_key = '';

  -- Normalise any slug still shared by two vaults of the same user.
  with ranked as (
    select id,
      row_number() over (
        partition by coalesce(user_id, '00000000-0000-0000-0000-000000000000'::uuid), slug
        order by id
      ) as rn
    from public.vaults
  )
  update public.vaults v
  set slug = v.slug || '-' || left(v.id::text, 8)
  from ranked
  where v.id = ranked.id and ranked.rn > 1;

  -- The app orders vaults by priority, so existing rows get a stable
  -- per-user ordering. Legacy vaults have created_at; a fresh 0001 schema
  -- does not, so fall back to id there.
  do $$
  declare
    has_created_at boolean;
  begin
    select exists (
      select 1 from information_schema.columns
      where table_schema = 'public' and table_name = 'vaults' and column_name = 'created_at'
    ) into has_created_at;

    if has_created_at then
      execute $q$
        update public.vaults v set priority = r.rn
        from (
          select id, row_number() over (
            partition by user_id order by created_at asc nulls last, id asc
          ) as rn
          from public.vaults
        ) r
        where v.id = r.id and v.priority is null
      $q$;
    else
      execute $q$
        update public.vaults v set priority = r.rn
        from (
          select id, row_number() over (partition by user_id order by id) as rn
          from public.vaults
        ) r
        where v.id = r.id and v.priority is null
      $q$;
    end if;
  end $$;

  alter table public.vaults alter column slug set not null;
  alter table public.vaults alter column priority set default 0;
  alter table public.vaults alter column priority set not null;

  create unique index if not exists idx_vaults_user_slug
    on public.vaults (coalesce(user_id, '00000000-0000-0000-0000-000000000000'::uuid), slug);
  create index if not exists idx_vaults_user
    on public.vaults(user_id);


  -- ------------------------------------------------------------
  -- TRANSACTIONS — add date, note, vault_id (+ the missing FK)
  -- ------------------------------------------------------------

  alter table public.transactions add column if not exists date date;
  alter table public.transactions add column if not exists note text;
  alter table public.transactions add column if not exists vault_id uuid;

  -- The app's date column is derived from the transaction timestamp.
  update public.transactions set date = created_at::date where date is null;

  -- Legacy rows stored the label in `name`; the app reads it as `note`.
  do $$
  begin
    if exists (
      select 1 from information_schema.columns
      where table_schema = 'public' and table_name = 'transactions' and column_name = 'name'
    ) then
      update public.transactions set note = name where note is null;
    end if;
  end $$;

  alter table public.transactions alter column date set default current_date;
  alter table public.transactions alter column date set not null;

  -- Legacy transactions may carry a NULL type. The app writes one of the
  -- three values, so default the gaps to 'expense' and restore the
  -- constraints that a fresh 0001 schema would have created.
  update public.transactions set type = 'expense' where type is null;
  alter table public.transactions alter column type set not null;

  -- Legacy databases may model `type` as an enum (`transaction_type`) whose
  -- labels stop at income/expense. The app writes 'transfer' for vault
  -- transfers, so the label has to exist or those inserts fail with 22P02.
  -- A CHECK constraint over an enum is impossible anyway — the literals would
  -- have to cast — so the constraint is only added for a genuine text column.
  do $$
  declare
    column_udt text;
  begin
    select udt_name into column_udt
    from information_schema.columns
    where table_schema = 'public' and table_name = 'transactions' and column_name = 'type';

    if column_udt is not null and column_udt <> 'text' then
      if not exists (
        select 1 from pg_type t
        join pg_enum e on e.enumtypid = t.oid
        where t.typname = column_udt and e.enumlabel = 'transfer'
      ) then
        begin
          execute format('alter type %I add value if not exists %L', column_udt, 'transfer');
          raise notice 'added label ''transfer'' to enum %', column_udt;
        exception when others then
          raise warning
            'could not add ''transfer'' to enum % (%) — vault transfers will fail', column_udt, sqlerrm;
        end;
      end if;
    elsif not exists (
      select 1 from pg_constraint
      where conrelid = 'public.transactions'::regclass
        and conname = 'transactions_type_check'
    ) then
      alter table public.transactions
        add constraint transactions_type_check
        check (type in ('income', 'expense', 'transfer')) not valid;
    end if;
  end $$;

  -- amount cannot be invented, so only tighten it when every legacy row
  -- already has one.
  do $$
  begin
    if not exists (select 1 from public.transactions where amount is null) then
      alter table public.transactions alter column amount set not null;
    end if;
  end $$;

  do $$
  begin
    if not exists (
      select 1 from pg_constraint
      where conrelid = 'public.transactions'::regclass
        and conname = 'transactions_amount_check'
    ) then
      alter table public.transactions
        add constraint transactions_amount_check check (amount > 0) not valid;
    end if;
  end $$;

  -- This foreign key is what lets PostgREST embed vault:vaults(...).
  -- Without it the dashboard query fails with PGRST200.
  do $$
  begin
    if not exists (
      select 1 from pg_constraint
      where conrelid = 'public.transactions'::regclass
        and conname = 'transactions_vault_id_fkey'
    ) then
      alter table public.transactions
        add constraint transactions_vault_id_fkey
        foreign key (vault_id) references public.vaults(id) on delete set null;
    end if;
  end $$;

  create index if not exists idx_tx_user_date
    on public.transactions(user_id, "date" desc);
  create index if not exists idx_tx_user_type
    on public.transactions(user_id, type);


  -- ------------------------------------------------------------
  -- ALLOCATION RULES — add source_category_id
  -- ------------------------------------------------------------

  alter table public.allocation_rules add column if not exists source_category_id uuid;

  do $$
  begin
    if not exists (
      select 1 from pg_constraint
      where conrelid = 'public.allocation_rules'::regclass
        and conname = 'allocation_rules_source_category_id_fkey'
    ) then
      alter table public.allocation_rules
        add constraint allocation_rules_source_category_id_fkey
        foreign key (source_category_id) references public.categories(id) on delete set null;
    end if;
  end $$;


  -- ------------------------------------------------------------
  -- ACHIEVEMENTS — add the catalog columns the rewards page reads
  -- ------------------------------------------------------------

  alter table public.achievements add column if not exists code text;
  alter table public.achievements add column if not exists name_key text;
  alter table public.achievements add column if not exists description_key text;
  alter table public.achievements add column if not exists icon text;
  alter table public.achievements add column if not exists points_reward integer;
  alter table public.achievements add column if not exists criteria jsonb;

  update public.achievements
  set code = 'legacy-' || left(id::text, 8) where code is null or code = '';
  update public.achievements
  set name_key = 'ach.unknown.name' where name_key is null or name_key = '';
  update public.achievements
  set description_key = 'ach.unknown.desc' where description_key is null or description_key = '';
  update public.achievements
  set points_reward = 0 where points_reward is null;
  update public.achievements
  set criteria = '{"type":"transaction_count","count":0}'::jsonb where criteria is null;

  alter table public.achievements alter column code set not null;
  alter table public.achievements alter column name_key set not null;
  alter table public.achievements alter column description_key set not null;
  alter table public.achievements alter column points_reward set default 0;
  alter table public.achievements alter column points_reward set not null;
  alter table public.achievements alter column criteria set not null;

  -- The seed below lists columns explicitly and never sends `id`, so a legacy
  -- id without a default would reject every one of the 12 catalog rows with
  -- 23502. `id` is excluded from the STEP 0 relaxation on purpose (it must
  -- never be nullable), which makes the default the thing to repair here.
  do $$
  begin
    if exists (
      select 1 from information_schema.columns
      where table_schema = 'public' and table_name = 'achievements'
        and column_name = 'id' and column_default is null
    ) then
      alter table public.achievements alter column id set default gen_random_uuid();
      raise notice 'achievements.id had no default — added gen_random_uuid()';
    end if;
  end $$;

  create unique index if not exists idx_achievements_code
    on public.achievements(code);


  -- ------------------------------------------------------------
  -- SEED: system categories and achievement catalog
  -- Both inserts are re-runnable: categories relies on the coalesced unique
  -- index above, achievements on the unique index on code.
  -- ------------------------------------------------------------

  -- 0001 seeds two rows with the slug 'lainnya' (one for income, one for
  -- expense). Under the unique index only one of them could ever land, so
  -- they are given distinct slugs here. Display still comes from name_key,
  -- so nothing user-facing changes.
insert into public.categories (user_id, type, slug, name_key, icon, color, is_system) values
  (null, 'income',  'gaji',       'cat.gaji',        'briefcase',    'emerald', true),
  (null, 'income',  'freelance',  'cat.freelance',   'laptop',      'cyan',    true),
  (null, 'income',  'investasi',  'cat.investasi',   'trending-up', 'violet',  true),
  (null, 'income',  'bisnis',     'cat.bisnis',      'store',       'sky',     true),
  (null, 'income',  'lainnya-in', 'cat.incomeLain',  'coffee',      'slate',   true),
  (null, 'expense', 'makanan',    'cat.makanan',     'utensils',    'amber',   true),
  (null, 'expense', 'transportasi','cat.transportasi','car',        'sky',     true),
  (null, 'expense', 'belanja',    'cat.belanja',     'shopping-bag','rose',    true),
  (null, 'expense', 'tagihan',    'cat.tagihan',     'receipt',     'violet',  true),
  (null, 'expense', 'hiburan',    'cat.hiburan',     'clapperboard','pink',    true),
  (null, 'expense', 'kesehatan',  'cat.kesehatan',   'heart-pulse', 'red',     true),
  (null, 'expense', 'pendidikan', 'cat.pendidikan',  'graduation-cap','blue',  true),
  (null, 'expense', 'lainnya-ex', 'cat.expenseLain', 'circle-ellipsis','slate', true)
-- `on conflict` needs a concrete target, and (user_id, slug) cannot be used
-- because NULL user_id never matches itself. Routing through a NOT NULL
-- text column lets ON CONFLICT DO NOTHING suppress the duplicate instead.
on conflict do nothing;

  insert into public.achievements (code, name_key, description_key, icon, points_reward, criteria) values
    ('first_transaction',   'ach.firstTx.name', 'ach.firstTx.desc',  'play',         25,  '{"type":"transaction_count","count":1}'),
    ('streak_3',            'ach.streak3.name', 'ach.streak3.desc',  'flame',        40,  '{"type":"streak_days","days":3}'),
    ('streak_7',            'ach.streak7.name', 'ach.streak7.desc',  'flame',       100,  '{"type":"streak_days","days":7}'),
    ('streak_30',           'ach.streak30.name','ach.streak30.desc', 'flame',       300,  '{"type":"streak_days","days":30}'),
    ('tx_50',               'ach.tx50.name',    'ach.tx50.desc',     'list-check',   80,  '{"type":"transaction_count","count":50}'),
    ('tx_500',              'ach.tx500.name',   'ach.tx500.desc',    'list-check',  250,  '{"type":"transaction_count","count":500}'),
    ('vault_darat_target',  'ach.vaultDaratTarget.name', 'ach.vaultDaratTarget.desc', 'target',      75, '{"type":"vault_goal","vault_slug":"darurat","ratio":0.9}'),
    ('vault_tabungan_target','ach.vaultTabunganTarget.name','ach.vaultTabunganTarget.desc','piggy-bank',75,'{"type":"vault_goal","vault_slug":"tabungan","ratio":0.9}'),
    ('safe_darat_1m',       'ach.safeDarat1m.name', 'ach.safeDarat1m.desc', 'shield-check', 100, '{"type":"no_vault_withdraw","vault_slug":"darurat","months":1}'),
    ('safe_darat_3m',       'ach.safeDarat3m.name', 'ach.safeDarat3m.desc', 'shield-check', 250, '{"type":"no_vault_withdraw","vault_slug":"darurat","months":3}'),
    ('safe_darat_6m',       'ach.safeDarat6m.name', 'ach.safeDarat6m.desc', 'shield-check', 500, '{"type":"no_vault_withdraw","vault_slug":"darurat","months":6}'),
    ('savings_ratio_20',    'ach.ratio20.name',   'ach.ratio20.desc', 'gauge',        150, '{"type":"savings_ratio","ratio":0.2,"months":1}')
  on conflict (code) do nothing;


  -- ------------------------------------------------------------
  -- GRANTS — 0001 never granted anything explicitly; without these
  -- an anon/authenticated key can be refused on a freshly repaired DB.
  --
  -- Guarded by to_regclass because a legacy database may never have received
  -- the tables defined after `transactions` in 0001: that script aborts at
  -- `create index ... (user_id, date desc)`, so a bare grant on one of them
  -- would fail and take the rest of this migration down with it.
  -- ------------------------------------------------------------

  do $$
  declare
    grant_target record;
  begin
    for grant_target in
      select * from (values
        ('profiles',             'select, insert, update, delete'),
        ('categories',           'select, insert, update, delete'),
        ('vaults',               'select, insert, update, delete'),
        ('transactions',         'select, insert, update, delete'),
        ('allocation_rules',     'select, insert, update, delete'),
        ('allocation_slots',     'select, insert, update, delete'),
        ('budgets',              'select, insert, update, delete'),
        ('gamification_state',   'select, insert, update'),
        ('achievements',         'select, insert, update, delete'),
        ('points_log',           'select, insert'),
        ('user_achievements',    'select, insert')
      ) as t(table_name, privileges)
    loop
      if to_regclass('public.' || grant_target.table_name) is null then
        raise warning
          'skipping grant on public.% — table does not exist (run 0002)',
          grant_target.table_name;
        continue;
      end if;

      execute format(
        'grant %s on public.%I to authenticated',
        grant_target.privileges, grant_target.table_name
      );
    end loop;
  end $$;


  -- PostgREST caches its schema; without this the new columns and the
  -- new foreign key are invisible and PGRST200/42703 keep firing.
  notify pgrst, 'reload schema';


  -- ------------------------------------------------------------
  -- SELF-CHECK — report anything left that can still reject an insert
  --
  -- STEP 0 relaxes every NOT NULL column that has no default on the six tables
  -- this migration rewrites, so on a database we could read in full this block
  -- stays silent. It is here for the case we cannot: a NOT NULL added by
  -- something else after STEP 0 ran. A warning in the SQL Editor output is far
  -- cheaper to act on than an opaque 23502 from the app.
  --
  -- The 0002-created tables are deliberately excluded — their NOT NULL columns
  -- are correct and the app always sends them.
  -- ------------------------------------------------------------

  do $$
  declare
    leftover record;
  begin
    for leftover in
      select table_name, column_name
      from information_schema.columns
      where table_schema = 'public'
        and table_name in (
          'profiles', 'categories', 'vaults',
          'transactions', 'allocation_rules', 'achievements'
        )
        and is_nullable = 'NO'
        and column_default is null
        and column_name <> 'id'
    order by table_name, column_name
    loop
      raise warning
        '%.% is still NOT NULL with no default — if the app omits it, inserts will fail with 23502',
        leftover.table_name, leftover.column_name;
    end loop;
  end $$;
