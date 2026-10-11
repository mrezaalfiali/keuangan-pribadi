-- ============================================================
-- 0013_recurring_recording_fix.sql
--
-- Two fixes, both rooted in the legacy schema:
--
--   1. public.transactions.id is `uuid` in databases built from the
--      legacy schema, while the whole repo (0001_init.sql, the RPCs and
--      the app types) assumes `bigint`. 0003_align_legacy_schema.sql
--      deliberately skips the `id` column, so the divergence survived.
--      That mismatch is what makes "Tinjau & catat" fail with 22P02,
--      because record_recurring_transaction does
--      `returning id into v_transaction_id` where v_transaction_id is
--      bigint. It also silently breaks edit_financial_transaction
--      (p_transaction_id bigint + `where id = p_transaction_id`).
--      Nothing references transactions.id (no FKs, no views) and the
--      backup restore never inserts it, so realigning it is safe.
--
--   2. record_recurring_transaction never persisted funding_source_id on
--      a recorded expense, so recurring expenses lost the (source, vault)
--      pair the pool rule depends on. It also gets an explicit allocation
--      mode so a reviewed income occurrence can choose between the active
--      allocation rule ("auto") and a single chosen vault ("single").
-- ============================================================

-- ------------------------------------------------------------
-- 1. Align public.transactions.id with the app schema (bigint).
--    Existing rows are kept; the identity column backfills them with
--    fresh sequential ids. Nothing references the old uuid values.
-- ------------------------------------------------------------
do $$
declare
  r record;
begin
  if to_regclass('public.transactions') is null then
    raise warning 'skipping transactions.id realign — public.transactions does not exist';
    return;
  end if;

  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = 'transactions'
      and column_name = 'id'
      and data_type <> 'bigint'
  ) then
    -- Drop the primary key generically (its name is not guaranteed).
    for r in
      select conname
      from pg_constraint
      where conrelid = 'public.transactions'::regclass
        and contype = 'p'
    loop
      execute format('alter table public.transactions drop constraint %I', r.conname);
    end loop;

    alter table public.transactions drop column if exists id;
    alter table public.transactions
      add column id bigint generated always as identity primary key;

    raise notice 'transactions.id realigned from legacy type to bigint identity';
  end if;
end $$;

-- ------------------------------------------------------------
-- 2. Drop every overload of record_recurring_transaction so the new
--    10-argument signature (with p_allocation_mode) replaces them all.
-- ------------------------------------------------------------
do $$
declare
  r record;
begin
  for r in
    select n.nspname as schema_name,
           p.proname as func_name,
           pg_get_function_identity_arguments(p.oid) as args
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname = 'record_recurring_transaction'
  loop
    execute format('drop function if exists %I.%I(%s)', r.schema_name, r.func_name, r.args);
  end loop;
end $$;

-- ------------------------------------------------------------
-- 3. Recreate the recording RPC.
--    - p_allocation_mode: 'auto' (use the active allocation rule for
--      income, as before) or 'single' (record one income row into the
--      chosen vault).
--    - Expenses now persist funding_source_id.
-- ------------------------------------------------------------
create or replace function public.record_recurring_transaction(
  p_template_id uuid,
  p_due_on date,
  p_today date,
  p_transaction_date date,
  p_amount integer,
  p_category_id uuid,
  p_funding_source_id uuid,
  p_vault_id uuid,
  p_note text,
  p_allocation_mode text
)
returns table(transaction_id bigint)
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_template public.recurring_transactions%rowtype;
  v_transaction_id bigint;
  v_next_due date;
  v_rule_id uuid;
  v_group_id uuid;
  v_slot record;
  v_slot_count integer;
  v_remainder_count integer;
  v_total_percent numeric;
  v_used integer := 0;
  v_piece integer;
  v_first_row boolean := true;
  v_apply_allocation boolean := false;
  v_vault_balance bigint;
  v_pair_balance bigint;
begin
  if auth.uid() is null then
    raise exception 'err.auth';
  end if;
  if p_allocation_mode not in ('auto', 'single') then
    raise exception 'err.generic';
  end if;
  if p_today <> timezone('Asia/Jakarta', now())::date then
    raise exception 'err.period';
  end if;
  if p_amount <= 0 then
    raise exception 'err.amount';
  end if;
  if p_due_on > p_today or p_transaction_date > p_today then
    raise exception 'err.period';
  end if;

  select * into v_template
  from public.recurring_transactions
  where id = p_template_id and user_id = auth.uid()
  for update;
  if not found or not v_template.is_active or v_template.due_on <> p_due_on then
    raise exception 'err.occurrence';
  end if;
  if v_template.snoozed_until is not null and v_template.snoozed_until > p_today then
    raise exception 'err.snoozed';
  end if;
  if v_template.ends_on is not null and p_due_on > v_template.ends_on then
    raise exception 'err.occurrence';
  end if;
  if (v_template.type = 'expense' and p_funding_source_id is null)
    or (v_template.type = 'income' and p_funding_source_id is not null) then
    raise exception 'err.source';
  end if;

  if p_category_id is not null and not exists (
    select 1 from public.categories c
    where c.id = p_category_id
      and c.type = v_template.type
      and (c.user_id is null or c.user_id = auth.uid())
  ) then
    raise exception 'err.category';
  end if;
  if p_funding_source_id is not null and not exists (
    select 1 from public.categories c
    where c.id = p_funding_source_id
      and c.type = 'income'
      and (c.user_id is null or c.user_id = auth.uid())
  ) then
    raise exception 'err.source';
  end if;
  if p_funding_source_id is not null then
    perform 1
    from public.categories c
    where c.id = p_funding_source_id
      and c.type = 'income'
      and (c.user_id is null or c.user_id = auth.uid())
    for update;
  end if;

  if v_template.type = 'expense' then
    if p_vault_id is null then
      raise exception 'transactions.expenseVaultRequired';
    end if;
    if not exists (
      select 1 from public.vaults v
      where v.id = p_vault_id and v.user_id = auth.uid()
    ) then
      raise exception 'err.vault';
    end if;
    if exists (
      select 1 from public.vaults v
      where v.id = p_vault_id and v.user_id = auth.uid() and v.is_locked
    ) then
      raise exception 'transactions.lockedError';
    end if;

    perform 1 from public.vaults v
    where v.id = p_vault_id and v.user_id = auth.uid()
    for update;

    select coalesce(sum(
      case
        when t.type = 'expense' then -t.amount
        when t.type = 'transfer' and t.transfer_direction = 'out' then -t.amount
        else t.amount
      end
    ), 0)
    into v_vault_balance
    from public.transactions t
    where t.user_id = auth.uid() and t.vault_id = p_vault_id;
    if v_vault_balance < p_amount then
      raise exception 'transactions.insufficient';
    end if;

    v_pair_balance := public.transaction_source_vault_balance(p_funding_source_id, p_vault_id);
    if v_pair_balance < p_amount then
      raise exception 'transactions.sourceNotInVault';
    end if;
  else
    -- Income recorded into a single chosen vault must name that vault.
    if p_allocation_mode = 'single' and p_vault_id is null then
      raise exception 'err.vault';
    end if;
    if p_vault_id is not null and not exists (
      select 1 from public.vaults v
      where v.id = p_vault_id and v.user_id = auth.uid()
    ) then
      raise exception 'err.vault';
    end if;
  end if;

  if v_template.type = 'income' and p_allocation_mode = 'auto' then
    select r.id into v_rule_id
    from public.allocation_rules r
    where r.user_id = auth.uid() and r.is_active
    order by r.created_at desc
    limit 1;

    if v_rule_id is not null then
      select count(*),
        count(*) filter (where s.method = 'remainder'),
        coalesce(sum(s.value) filter (where s.method = 'percent'), 0)
      into v_slot_count, v_remainder_count, v_total_percent
      from public.allocation_slots s
      where s.rule_id = v_rule_id;

      v_apply_allocation := v_slot_count > 0
        and v_remainder_count = 1
        and v_total_percent <= 100
        and not exists (
          select 1 from public.allocation_slots s
          left join public.vaults v on v.id = s.vault_id and v.user_id = auth.uid()
          where s.rule_id = v_rule_id
            and (
              v.id is null
              or (s.method = 'percent' and (s.value < 0 or s.value > 100))
              or (s.method in ('amount', 'remainder') and s.value < 0)
            )
        )
        and v_slot_count = (
          select count(distinct s.vault_id)
          from public.allocation_slots s
          where s.rule_id = v_rule_id
        );
    end if;
  end if;

  -- Mode auto yang tidak bisa dipakai (tidak ada rule aktif, tidak ada slot,
  -- atau rule tidak valid) tidak punya vault tujuan. Baris dengan vault_id null
  -- tidak bisa dibelanjakan, jadi ditolak daripada disimpan setengah jalan.
  if v_template.type = 'income'
    and p_allocation_mode = 'auto'
    and not v_apply_allocation
    and p_vault_id is null then
    raise exception 'transactions.allocationRuleRequired';
  end if;

  if v_apply_allocation then
    v_group_id := gen_random_uuid();
    for v_slot in
      select s.vault_id, s.method, s.value
      from public.allocation_slots s
      where s.rule_id = v_rule_id
      order by case s.method when 'percent' then 1 when 'amount' then 2 else 3 end, s.priority
    loop
      if v_slot.method = 'percent' then
        v_piece := least(
          greatest(p_amount - v_used, 0),
          round(p_amount * v_slot.value / 100)::integer
        );
      elsif v_slot.method = 'amount' then
        v_piece := least(greatest(round(v_slot.value)::integer, 0), greatest(p_amount - v_used, 0));
      else
        v_piece := greatest(p_amount - v_used, 0);
      end if;
      v_used := v_used + v_piece;
      if v_piece > 0 then
        insert into public.transactions (
          user_id, type, amount, date, note, category_id, vault_id, group_id,
          recurring_template_id, recurring_due_on
        )
        values (
          auth.uid(), 'income', v_piece, p_transaction_date,
          nullif(left(trim(coalesce(p_note, v_template.note, '')), 240), ''),
          p_category_id, v_slot.vault_id, v_group_id,
          case when v_first_row then p_template_id else null end,
          case when v_first_row then p_due_on else null end
        )
        returning id into v_transaction_id;
        v_first_row := false;
      end if;
    end loop;
  else
    insert into public.transactions (
      user_id, type, amount, date, note, category_id, funding_source_id, vault_id,
      recurring_template_id, recurring_due_on
    )
    values (
      auth.uid(), v_template.type, p_amount, p_transaction_date,
      nullif(left(trim(coalesce(p_note, v_template.note, '')), 240), ''),
      p_category_id, p_funding_source_id, p_vault_id, p_template_id, p_due_on
    )
    returning id into v_transaction_id;
  end if;

  v_next_due := public.next_recurring_due_on(
    v_template.due_on, v_template.frequency, v_template.interval_count,
    v_template.anchor_day
  );
  update public.recurring_transactions
  set due_on = v_next_due,
      snoozed_until = null,
      is_active = (ends_on is null or v_next_due <= ends_on),
      updated_at = now()
  where id = p_template_id;

  return query select v_transaction_id;
end;
$$;

grant execute on function public.record_recurring_transaction(uuid, date, date, date, integer, uuid, uuid, uuid, text, text) to authenticated;

notify pgrst, 'reload schema';
