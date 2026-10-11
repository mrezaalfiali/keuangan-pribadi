-- ============================================================
-- 0011 — Expense must leave a real vault
--
-- WHAT THIS FILE DOES
-- Closes the hole where a locked vault could still be spent from: an
-- expense was validated only against its income *source* balance, never
-- against the vault the money physically sits in. Because a row with
-- vault_id = null is skipped by the vault ledger, a user could record an
-- expense with "no vault" and the locked vault kept its full balance while
-- the source dropped — the same money counted twice, and the lock did
-- nothing.
--
-- The rule now: an expense must point at a vault that belongs to the user,
-- is not locked, and holds enough balance. Income keeps its own rules
-- (allocation may split it, and income may land on a locked vault).
--
-- WHY A NEW FILE
-- 0009 and 0010 already shipped. Migrations are append-only, so the two
-- functions are re-created here rather than edited in place. Every
-- statement is idempotent.
--
-- Run this in the Supabase SQL Editor. It is safe to run repeatedly.
-- ============================================================


-- ------------------------------------------------------------
-- edit_financial_transaction
--
-- Adds the same vault rule for an edited expense. The old version allowed
-- p_vault_id = null and allowed keeping a locked vault ("same vault"
-- bypass); both are removed for expenses. Vault balance is now checked too,
-- ignoring the row being edited so an expense can be changed without
-- tripping over itself.
-- ------------------------------------------------------------

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
  v_vault_balance bigint;
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

  if v_transaction.type = 'expense' then
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
    where t.user_id = auth.uid() and t.vault_id = p_vault_id and t.id <> p_transaction_id;
    if v_vault_balance < p_amount then
      raise exception 'transactions.insufficient';
    end if;
  elsif p_vault_id is not null and not exists (
    select 1 from public.vaults v
    where v.id = p_vault_id and v.user_id = auth.uid()
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


-- ------------------------------------------------------------
-- record_recurring_transaction
--
-- Same rule for a recorded recurring occurrence: an expense needs an
-- unlocked, owned vault with enough balance. Income behaviour is unchanged
-- (it may still be split by the active allocation rule).
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
  p_note text
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
  v_source_balance bigint;
  v_vault_balance bigint;
begin
  if auth.uid() is null then
    raise exception 'err.auth';
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

    select coalesce(sum(
      case
        when t.type = 'income' and t.category_id = p_funding_source_id then t.amount
        when t.type = 'expense' and t.funding_source_id = p_funding_source_id then -t.amount
        else 0
      end
    ), 0)
    into v_source_balance
    from public.transactions t
    where t.user_id = auth.uid();

    if v_source_balance < p_amount then
      raise exception 'transactions.insufficientSource';
    end if;
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
  elsif p_vault_id is not null and not exists (
    select 1 from public.vaults v
    where v.id = p_vault_id and v.user_id = auth.uid()
  ) then
    raise exception 'err.vault';
  end if;

  if v_template.type = 'income' then
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
      user_id, type, amount, date, note, category_id, vault_id,
      recurring_template_id, recurring_due_on
    )
    values (
      auth.uid(), v_template.type, p_amount, p_transaction_date,
      nullif(left(trim(coalesce(p_note, v_template.note, '')), 240), ''),
      p_category_id, p_vault_id, p_template_id, p_due_on
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

grant execute on function public.record_recurring_transaction(uuid, date, date, date, integer, uuid, uuid, uuid, text) to authenticated;

notify pgrst, 'reload schema';
