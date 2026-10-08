alter table public.transactions
  add column if not exists backup_key uuid;

update public.transactions
set backup_key = gen_random_uuid()
where backup_key is null;

create unique index if not exists idx_transactions_user_backup_key
  on public.transactions(user_id, backup_key)
  where backup_key is not null;
grant select (backup_key), insert (backup_key) on public.transactions to authenticated;

create or replace function public.edit_financial_transaction(
  p_transaction_id bigint,
  p_amount integer,
  p_date date,
  p_category_id uuid,
  p_funding_source_id uuid,
  p_vault_id uuid,
  p_note text
)
returns void
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_transaction public.transactions%rowtype;
  v_source_balance bigint;
begin
  if auth.uid() is null then raise exception 'err.auth'; end if;
  if p_amount is null or p_amount <= 0 then raise exception 'err.amount'; end if;
  if p_date is null then raise exception 'err.period'; end if;

  select * into v_transaction
  from public.transactions
  where id = p_transaction_id and user_id = auth.uid()
  for update;
  if not found then raise exception 'err.notFound'; end if;
  if v_transaction.type not in ('income', 'expense') or v_transaction.group_id is not null then
    raise exception 'err.editUnsupported';
  end if;

  if p_category_id is not null and not exists (
    select 1 from public.categories c
    where c.id = p_category_id and c.type = v_transaction.type
      and (c.user_id is null or c.user_id = auth.uid())
  ) then
    raise exception 'err.category';
  end if;
  if v_transaction.type = 'income' then
    perform 1 from public.categories c
    where c.id in (v_transaction.category_id, p_category_id)
    order by c.id
    for update;

    if v_transaction.category_id is not null then
      select coalesce(sum(
        case
          when t.type = 'income' and t.category_id = v_transaction.category_id then t.amount
          when t.type = 'expense' and t.funding_source_id = v_transaction.category_id then -t.amount
          else 0
        end
      ), 0) + case when p_category_id = v_transaction.category_id then p_amount else 0 end
      into v_source_balance
      from public.transactions t
      where t.user_id = auth.uid() and t.id <> p_transaction_id;
      if v_source_balance < 0 then raise exception 'transactions.insufficientSource'; end if;
    end if;
  elsif v_transaction.type = 'expense' then
    if p_funding_source_id is null then raise exception 'err.source'; end if;
    if not exists (
      select 1 from public.categories c
      where c.id = p_funding_source_id and c.type = 'income'
        and (c.user_id is null or c.user_id = auth.uid())
    ) then
      raise exception 'err.source';
    end if;
    perform 1 from public.categories c
    where c.id = p_funding_source_id
      and (c.user_id is null or c.user_id = auth.uid())
    for update;
    select coalesce(sum(
      case
        when t.type = 'income' and t.category_id = p_funding_source_id then t.amount
        when t.type = 'expense' and t.funding_source_id = p_funding_source_id then -t.amount
        else 0
      end
    ), 0)
    into v_source_balance
    from public.transactions t
    where t.user_id = auth.uid() and t.id <> p_transaction_id;
    if v_source_balance < p_amount then raise exception 'transactions.insufficientSource'; end if;
  elsif p_funding_source_id is not null then
    raise exception 'err.source';
  end if;

  if p_vault_id is not null and not exists (
    select 1 from public.vaults v
    where v.id = p_vault_id and v.user_id = auth.uid()
      and (
        v_transaction.type <> 'expense'
        or not v.is_locked
        or p_vault_id is not distinct from v_transaction.vault_id
      )
  ) then
    raise exception 'err.vault';
  end if;

  update public.transactions
  set amount = p_amount,
      date = p_date,
      category_id = p_category_id,
      funding_source_id = p_funding_source_id,
      vault_id = p_vault_id,
      note = nullif(left(trim(coalesce(p_note, '')), 200), '')
  where id = p_transaction_id and user_id = auth.uid();
end;
$$;

revoke all on function public.edit_financial_transaction(bigint, integer, date, uuid, uuid, uuid, text) from public, anon;
grant execute on function public.edit_financial_transaction(bigint, integer, date, uuid, uuid, uuid, text) to authenticated;

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
