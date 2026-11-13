-- ============================================================
-- 0031_restore_category_overrides.sql
--
-- Fungsi restore_financial_backup ditulis ulang agar memuat
-- `category_overrides` -- catatan rename/sembunyi kategori per
-- akun (migrasi 0022). Tanpa baris ini, restore ke akun baru
-- mengembalikan nama kategori bawaan (dan sumber pemasukan)
-- ke nama aslinya, karena catatan itu tidak pernah ikut
-- diekspor dan restore bersifat merge (tidak menghapus baris
-- yang sudah ada di akun yang sama).
--
-- Penambahan terhadap salinan 0030:
--   1. validasi jumlah baris untuk kunci opsional
--      `category_overrides`;
--   2. loop pemulihan catatan rename/sembunyi setelah loop
--      `categories` (FK category_id menuntut kategori sudah ada);
--   3. self-check memuat fungsi baru.
--
-- Idempoten: hanya `create or replace function` (pola 0029/0030).
--
-- PENTING: Jalankan 0022_category_overrides.sql dan
-- 0030_vault_borrows.sql terlebih dahulu sebelum migrasi ini.
-- ============================================================

create or replace function public.restore_financial_backup(p_backup jsonb)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_source_user_id uuid;
  v_count integer;
  v_total integer := 0;
  v_rows integer := 0;
  v_row record;
  v_transaction_id bigint;
  v_source_id uuid;
begin
  if v_user_id is null then raise exception 'err.auth'; end if;
  if jsonb_typeof(p_backup) is distinct from 'object'
    or p_backup->'schema_version' is distinct from '1'::jsonb
    or p_backup->'app' is distinct from '"nexora"'::jsonb
    or jsonb_typeof(p_backup->'account') is distinct from 'object'
    or (
      jsonb_typeof(p_backup->'profile') is distinct from 'object'
      and jsonb_typeof(p_backup->'profile') is distinct from 'null'
    ) then
    raise exception 'err.backupFormat';
  end if;

  begin
    v_source_user_id := (p_backup->'account'->>'id')::uuid;
  exception when invalid_text_representation then
    raise exception 'err.backupFormat';
  end;
  if v_source_user_id is null then raise exception 'err.backupFormat'; end if;
  if v_source_user_id <> v_user_id then raise exception 'err.backupOwner'; end if;

  for v_row in
    select key, value from jsonb_each(p_backup)
    where key = any(array[
      'categories', 'vaults', 'transactions', 'budgets',
      'allocation_rules', 'allocation_slots', 'recurring_transactions'
    ])
  loop
    if jsonb_typeof(v_row.value) is distinct from 'array' then
      raise exception 'err.backupFormat';
    end if;
    v_rows := v_rows + jsonb_array_length(v_row.value);
    if jsonb_array_length(v_row.value) > 20000 or v_rows > 20000 then
      raise exception 'err.backupFormat';
    end if;
  end loop;

  if p_backup ? 'budget_borrows' then
    if jsonb_typeof(p_backup->'budget_borrows') is distinct from 'array' then
      raise exception 'err.backupFormat';
    end if;
    v_rows := v_rows + jsonb_array_length(p_backup->'budget_borrows');
    if jsonb_array_length(p_backup->'budget_borrows') > 20000 or v_rows > 20000 then
      raise exception 'err.backupFormat';
    end if;
  end if;

  if p_backup ? 'vault_borrows' then
    if jsonb_typeof(p_backup->'vault_borrows') is distinct from 'array' then
      raise exception 'err.backupFormat';
    end if;
    v_rows := v_rows + jsonb_array_length(p_backup->'vault_borrows');
    if jsonb_array_length(p_backup->'vault_borrows') > 20000 or v_rows > 20000 then
      raise exception 'err.backupFormat';
    end if;
  end if;

  if p_backup ? 'category_overrides' then
    if jsonb_typeof(p_backup->'category_overrides') is distinct from 'array' then
      raise exception 'err.backupFormat';
    end if;
    v_rows := v_rows + jsonb_array_length(p_backup->'category_overrides');
    if jsonb_array_length(p_backup->'category_overrides') > 20000 or v_rows > 20000 then
      raise exception 'err.backupFormat';
    end if;
  end if;

  if not (p_backup ? 'categories')
    or not (p_backup ? 'vaults')
    or not (p_backup ? 'transactions')
    or not (p_backup ? 'budgets')
    or not (p_backup ? 'allocation_rules')
    or not (p_backup ? 'allocation_slots')
    or not (p_backup ? 'recurring_transactions') then
    raise exception 'err.backupFormat';
  end if;

  for v_row in
    select * from jsonb_to_recordset(p_backup->'categories') as x(
      id uuid, user_id uuid, type text, slug text, name_key text, icon text,
      color text, is_system boolean
    )
  loop
    if v_row.user_id is not null and v_row.user_id <> v_source_user_id then
      raise exception 'err.backupOwner';
    end if;
    if v_row.user_id = v_source_user_id then
      insert into public.categories(id, user_id, type, slug, name_key, icon, color, is_system)
      values (v_row.id, v_user_id, v_row.type, v_row.slug, v_row.name_key, v_row.icon, v_row.color, false)
      on conflict do nothing;
      get diagnostics v_count = row_count;
      v_total := v_total + v_count;
    end if;
  end loop;

  -- category_overrides (dari 0031): catatan rename/sembunyi per akun.
  -- Diletakkan setelah loop categories karena FK category_id menuntut
  -- kategori (milik akun) sudah ada; baris katalog bersama sudah pasti
  -- ada sebagai seed 0001. Baris yang kategorinya tidak ditemukan
  -- dilewati, bukan gagal -- merge-longgar seperti loop borrows.
  if p_backup ? 'category_overrides' and jsonb_typeof(p_backup->'category_overrides') = 'array' then
    for v_row in
      select * from jsonb_to_recordset(p_backup->'category_overrides') as x(
        category_id uuid, custom_name text, hidden boolean,
        created_at timestamptz, updated_at timestamptz
      )
    loop
      if v_row.category_id is null then
        continue;
      end if;
      if not exists (
        select 1 from public.categories c where c.id = v_row.category_id
          and (c.user_id is null or c.user_id = v_user_id)
      ) then
        continue;
      end if;
      insert into public.category_overrides(
        user_id, category_id, custom_name, hidden, created_at, updated_at
      )
      values (
        v_user_id, v_row.category_id,
        case
          when v_row.custom_name is not null
            and char_length(v_row.custom_name) between 1 and 80
            then v_row.custom_name
          else null
        end,
        coalesce(v_row.hidden, false),
        coalesce(v_row.created_at, now()),
        coalesce(v_row.updated_at, now())
      )
      on conflict (user_id, category_id) do nothing;
      get diagnostics v_count = row_count;
      v_total := v_total + v_count;
    end loop;
  end if;

  for v_row in
    select * from jsonb_to_recordset(p_backup->'vaults') as x(
      id uuid, slug text, name_key text, name text, icon text, color text,
      target_amount integer, is_locked boolean, locked_until timestamptz, priority integer
    )
  loop
    insert into public.vaults(id, user_id, slug, name_key, name, icon, color, target_amount, is_locked, locked_until, priority)
    values (v_row.id, v_user_id, v_row.slug, v_row.name_key, v_row.name, v_row.icon, v_row.color, v_row.target_amount, v_row.is_locked, v_row.locked_until, v_row.priority)
    on conflict do nothing;
    get diagnostics v_count = row_count;
    v_total := v_total + v_count;
  end loop;

  for v_row in
    select * from jsonb_to_recordset(p_backup->'recurring_transactions') as x(
      id uuid, name text, note text, type text, amount integer, category_id uuid,
      funding_source_id uuid, vault_id uuid, frequency text, interval_count integer,
      anchor_day integer, due_on date, ends_on date, snoozed_until date, is_active boolean,
      created_at timestamptz, updated_at timestamptz
    )
  loop
    if (v_row.category_id is not null and not exists (
      select 1 from public.categories c where c.id = v_row.category_id
        and (c.user_id is null or c.user_id = v_user_id)
    )) or (v_row.funding_source_id is not null and not exists (
      select 1 from public.categories c where c.id = v_row.funding_source_id
        and c.type = 'income' and (c.user_id is null or c.user_id = v_user_id)
    )) or (v_row.vault_id is not null and not exists (
      select 1 from public.vaults v where v.id = v_row.vault_id and v.user_id = v_user_id
    )) then
      raise exception 'err.backupReference';
    end if;
    insert into public.recurring_transactions(
      id, user_id, name, note, type, amount, category_id, funding_source_id, vault_id,
      frequency, interval_count, anchor_day, due_on, ends_on, snoozed_until, is_active,
      created_at, updated_at
    )
    values (
      v_row.id, v_user_id, v_row.name, v_row.note, v_row.type, v_row.amount, v_row.category_id,
      v_row.funding_source_id, v_row.vault_id, v_row.frequency, v_row.interval_count,
      v_row.anchor_day, v_row.due_on, v_row.ends_on, v_row.snoozed_until, v_row.is_active,
      v_row.created_at, v_row.updated_at
    )
    on conflict do nothing;
    get diagnostics v_count = row_count;
    v_total := v_total + v_count;
  end loop;

  for v_row in
    select * from jsonb_to_recordset(p_backup->'transactions') as x(
      backup_key uuid, type text, amount integer, date date, note text, category_id uuid,
      funding_source_id uuid, vault_id uuid, group_id uuid, transfer_direction text,
      recurring_template_id uuid, recurring_due_on date
    )
  loop
    if v_row.backup_key is null
      or v_row.type not in ('income', 'expense', 'transfer')
      or v_row.amount is null
      or v_row.amount <= 0
      or v_row.date is null
      or (v_row.category_id is not null and not exists (
      select 1 from public.categories c where c.id = v_row.category_id
        and (c.user_id is null or c.user_id = v_user_id)
    )) or (v_row.funding_source_id is not null and not exists (
      select 1 from public.categories c where c.id = v_row.funding_source_id
        and c.type = 'income' and (c.user_id is null or c.user_id = v_user_id)
    )) or (v_row.vault_id is not null and not exists (
      select 1 from public.vaults v where v.id = v_row.vault_id and v.user_id = v_user_id
    )) or (v_row.recurring_template_id is not null and not exists (
      select 1 from public.recurring_transactions r
      where r.id = v_row.recurring_template_id and r.user_id = v_user_id
    )) then
      raise exception 'err.backupReference';
    end if;
    insert into public.transactions(
      user_id, backup_key, type, amount, date, note, category_id, funding_source_id,
      vault_id, group_id, transfer_direction, recurring_template_id, recurring_due_on
    )
    values (
      v_user_id, v_row.backup_key, v_row.type, v_row.amount, v_row.date, v_row.note,
      v_row.category_id, v_row.funding_source_id, v_row.vault_id, v_row.group_id,
      v_row.transfer_direction, v_row.recurring_template_id, v_row.recurring_due_on
    )
    on conflict do nothing;
    get diagnostics v_count = row_count;
    v_total := v_total + v_count;
  end loop;

  for v_row in
    select * from jsonb_to_recordset(p_backup->'allocation_rules') as x(
      id uuid, name text, source_category_id uuid, is_active boolean, created_at timestamptz
    )
  loop
    if v_row.source_category_id is not null and not exists (
      select 1 from public.categories c
      where c.id = v_row.source_category_id
        and c.type = 'income' and (c.user_id is null or c.user_id = v_user_id)
    ) then
      raise exception 'err.backupReference';
    end if;
    insert into public.allocation_rules(id, user_id, name, source_category_id, is_active, created_at)
    values (v_row.id, v_user_id, v_row.name, v_row.source_category_id, v_row.is_active, v_row.created_at)
    on conflict do nothing;
    get diagnostics v_count = row_count;
    v_total := v_total + v_count;
  end loop;

  for v_row in
    select * from jsonb_to_recordset(p_backup->'allocation_slots') as x(
      id uuid, rule_id uuid, vault_id uuid, method text, value numeric, priority integer
    )
  loop
    if not exists (select 1 from public.allocation_rules r where r.id = v_row.rule_id and r.user_id = v_user_id)
      or not exists (select 1 from public.vaults v where v.id = v_row.vault_id and v.user_id = v_user_id) then
      raise exception 'err.backupReference';
    end if;
    insert into public.allocation_slots(id, rule_id, vault_id, method, value, priority)
    values (v_row.id, v_row.rule_id, v_row.vault_id, v_row.method, v_row.value, v_row.priority)
    on conflict do nothing;
    get diagnostics v_count = row_count;
    v_total := v_total + v_count;
  end loop;

  for v_row in
    select * from jsonb_to_recordset(p_backup->'budgets') as x(
      id uuid, scope text, scope_id uuid, starts_on date, ends_on date,
      limit_amount integer, alert_threshold numeric, rolled_over_from uuid
    )
    order by starts_on
  loop
    if v_row.scope = 'category' and not exists (
      select 1 from public.categories c where c.id = v_row.scope_id
        and c.type = 'expense' and (c.user_id is null or c.user_id = v_user_id)
    ) then raise exception 'err.backupReference'; end if;
    if v_row.scope = 'vault' and not exists (
      select 1 from public.vaults v where v.id = v_row.scope_id and v.user_id = v_user_id
    ) then raise exception 'err.backupReference'; end if;
    insert into public.budgets(id, user_id, scope, scope_id, starts_on, ends_on, limit_amount, alert_threshold, rolled_over_from)
    values (v_row.id, v_user_id, v_row.scope, v_row.scope_id, v_row.starts_on, v_row.ends_on, v_row.limit_amount, v_row.alert_threshold, v_row.rolled_over_from)
    on conflict do nothing;
    get diagnostics v_count = row_count;
    v_total := v_total + v_count;
  end loop;

  -- budget_borrows (dari 0028)
  if p_backup ? 'budget_borrows' and jsonb_typeof(p_backup->'budget_borrows') = 'array' then
    for v_row in
      select * from jsonb_to_recordset(p_backup->'budget_borrows') as x(
        id uuid, from_budget_id uuid, to_budget_id uuid, amount integer,
        created_at timestamptz, transaction_backup_key uuid
      )
    loop
      if v_row.id is null
        or v_row.amount is null
        or v_row.amount <= 0
        or v_row.from_budget_id is null
        or v_row.to_budget_id is null
        or v_row.from_budget_id = v_row.to_budget_id then
        continue;
      end if;

      if not exists (select 1 from public.budgets b where b.id = v_row.from_budget_id and b.user_id = v_user_id)
        or not exists (select 1 from public.budgets b where b.id = v_row.to_budget_id and b.user_id = v_user_id) then
        continue;
      end if;

      v_transaction_id := null;
      if v_row.transaction_backup_key is not null then
        select t.id into v_transaction_id
        from public.transactions t
        where t.user_id = v_user_id and t.backup_key = v_row.transaction_backup_key;
      end if;
      if v_transaction_id is null then
        continue;
      end if;

      insert into public.budget_borrows(
        id, user_id, from_budget_id, to_budget_id, transaction_id, amount, created_at
      )
      values (
        v_row.id, v_user_id, v_row.from_budget_id, v_row.to_budget_id,
        v_transaction_id, v_row.amount, coalesce(v_row.created_at, now())
      )
      on conflict (id) do nothing;
      get diagnostics v_count = row_count;
      v_total := v_total + v_count;
    end loop;
  end if;

  -- vault_borrows (dari 0030)
  if p_backup ? 'vault_borrows' and jsonb_typeof(p_backup->'vault_borrows') = 'array' then
    for v_row in
      select * from jsonb_to_recordset(p_backup->'vault_borrows') as x(
        id uuid, from_vault_id uuid, to_vault_id uuid, funding_source_id uuid,
        amount integer, outstanding integer, status text,
        created_at timestamptz, transfer_backup_key uuid
      )
    loop
      if v_row.id is null
        or v_row.amount is null
        or v_row.amount <= 0
        or v_row.from_vault_id is null
        or v_row.to_vault_id is null
        or v_row.from_vault_id = v_row.to_vault_id then
        continue;
      end if;

      if not exists (select 1 from public.vaults v where v.id = v_row.from_vault_id and v.user_id = v_user_id)
        or not exists (select 1 from public.vaults v where v.id = v_row.to_vault_id and v.user_id = v_user_id) then
        continue;
      end if;

      v_source_id := v_row.funding_source_id;
      if v_source_id is not null and not exists (
        select 1 from public.categories c where c.id = v_source_id
          and c.type = 'income' and (c.user_id is null or c.user_id = v_user_id)
      ) then
        v_source_id := null;
      end if;

      v_transaction_id := null;
      if v_row.transfer_backup_key is not null then
        select t.id into v_transaction_id
        from public.transactions t
        where t.user_id = v_user_id and t.backup_key = v_row.transfer_backup_key;
      end if;

      insert into public.vault_borrows(
        id, user_id, from_vault_id, to_vault_id, funding_source_id,
        amount, outstanding, status, transfer_out_id, created_at
      )
      values (
        v_row.id, v_user_id, v_row.from_vault_id, v_row.to_vault_id, v_source_id,
        v_row.amount,
        case
          when v_row.outstanding is null or v_row.outstanding < 0
            or v_row.outstanding > v_row.amount then v_row.amount
          else v_row.outstanding
        end,
        case when v_row.status in ('open', 'repaid') then v_row.status else 'open' end,
        v_transaction_id,
        coalesce(v_row.created_at, now())
      )
      on conflict (id) do nothing;
      get diagnostics v_count = row_count;
      v_total := v_total + v_count;
    end loop;
  end if;

  if jsonb_typeof(p_backup->'profile') = 'object' then
    insert into public.profiles(id, display_name, currency, monthly_income, onboarded)
    select v_user_id, x.display_name, coalesce(x.currency, 'IDR'),
      coalesce(x.monthly_income, 0), coalesce(x.onboarded, false)
    from jsonb_to_record(p_backup->'profile') as x(
      display_name text, currency text, monthly_income integer, onboarded boolean
    )
    on conflict (id) do nothing;
    get diagnostics v_count = row_count;
    v_total := v_total + v_count;
  end if;

  return v_total;
end;
$$;

revoke all on function public.restore_financial_backup(jsonb) from public, anon;
grant execute on function public.restore_financial_backup(jsonb) to authenticated;

notify pgrst, 'reload schema';

-- ------------------------------------------------------------
-- SELF-CHECK
-- ------------------------------------------------------------
select
  pg_get_functiondef('public.restore_financial_backup(jsonb)'::regprocedure)
    like '%category_overrides%' as restore_has_category_overrides,
  pg_get_functiondef('public.restore_financial_backup(jsonb)'::regprocedure)
    like '%custom_name%' as restore_has_override_fields,
  pg_get_functiondef('public.restore_financial_backup(jsonb)'::regprocedure)
    like '%vault_borrows%' as restore_has_vault_borrows,
  exists (
    select 1
      from pg_policies
     where schemaname = 'public'
       and tablename = 'category_overrides'
       and policyname = 'category overrides own'
  ) as override_policy_exists,
  (select count(*) from public.category_overrides) as existing_category_overrides;
