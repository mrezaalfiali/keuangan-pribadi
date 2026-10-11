-- ============================================================
-- 0012 — Source×vault pools
--
-- WHAT THIS FILE DOES
-- 0011 made an expense leave a real vault. That closed the "no vault"
-- bypass, but the source check stayed *aggregate*: it added up an income
-- source across every vault and only then compared to the expense. Two
-- vaults could hold the same source, so money sitting in "Tabungan" could
-- fund an expense paid from "Darat" as long as the source's total was big
-- enough — the vault was never really the one paying.
--
-- The rule now: an expense must be covered by the (source, vault) *pool*
-- it names. `transaction_source_vault_balance` sums one source inside one
-- vault, and the two write paths below require that pool to hold the
-- amount. The existing vault-balance check is kept as a backstop, so a
-- vault cannot overdraw even when it holds money with no source attached.
--
-- It also backfills legacy rows that predate source tracking, so their
-- money is attributable (and spendable) again:
--   - transfers with no source get the system "Lainnya" income source;
--   - income with no category gets the same source.
-- Both are no-ops on a database that already has them.
--
-- WHY A NEW FILE
-- 0009–0011 already shipped. Migrations are append-only, so the two
-- functions are re-created here rather than edited in place. Every
-- statement is idempotent.
--
-- Run this in the Supabase SQL Editor. It is safe to run repeatedly.
-- ============================================================


-- ------------------------------------------------------------
-- HELPER — transaction_source_vault_balance
--
-- Running balance of ONE income source inside ONE vault, mirroring the
-- client helper `computeSourceVaultBalances`: income adds, expense and
-- transfer-out subtract, transfer-in adds. A transfer without a direction
-- is treated as an incoming row, exactly like `vaultBalanceDelta`.
--
-- SECURITY INVOKER: it reads through the caller's RLS, and only the
-- caller's own rows (user_id = auth.uid()) are considered.
-- ------------------------------------------------------------

create or replace function public.transaction_source_vault_balance(
  p_source uuid,
  p_vault uuid
)
returns bigint
language sql
security invoker
set search_path = public
as $$
  select coalesce(sum(
    case
      when t.type = 'income' and t.category_id = p_source then t.amount
      when t.type = 'expense' and t.funding_source_id = p_source then -t.amount
      when t.type = 'transfer' and t.funding_source_id = p_source
        and t.transfer_direction = 'out' then -t.amount
      when t.type = 'transfer' and t.funding_source_id = p_source then t.amount
      else 0
    end
  ), 0)::bigint
  from public.transactions t
  where t.user_id = auth.uid()
    and t.vault_id = p_vault;
$$;

revoke all on function public.transaction_source_vault_balance(uuid, uuid) from public, anon;
grant execute on function public.transaction_source_vault_balance(uuid, uuid) to authenticated;


-- ------------------------------------------------------------
-- edit_financial_transaction
--
-- Same vault rule as 0011 for an edited expense, plus the pool rule: the
-- (source, vault) pair must cover the amount. The row being edited is
-- excluded from both balances so an expense can be changed without
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
  v_pair_balance bigint;
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
    if p_vault_id is null then raise exception 'transactions.expenseVaultRequired'; end if;
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

    -- Pool rule: only the money this source actually holds in this vault
    -- may pay for the edited expense. Add back the old row's debit when the
    -- editor kept the same (source, vault), so the row does not block itself.
    v_pair_balance := public.transaction_source_vault_balance(p_funding_source_id, p_vault_id);
    if v_transaction.funding_source_id = p_funding_source_id
      and v_transaction.vault_id = p_vault_id then
      v_pair_balance := v_pair_balance + v_transaction.amount;
    end if;
    if v_pair_balance < p_amount then raise exception 'transactions.sourceNotInVault'; end if;
  elsif p_funding_source_id is not null then
    raise exception 'err.source';
  end if;

  if v_transaction.type = 'expense' then
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
-- Same pool rule for a recorded recurring expense. Income behaviour is
-- unchanged (it may still be split by the active allocation rule).
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
  v_vault_balance bigint;
  v_pair_balance bigint;
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


-- ------------------------------------------------------------
-- BACKFILL — legacy rows without a source
--
-- Rows recorded before source tracking carry vault money that cannot be
-- attributed to any source, so under the pool rule it would be unspendable.
-- Tag them with the system "Lainnya" income source. Prefer the slugged
-- seeded row, then any system income source; skip with a warning when the
-- database has none (a legacy schema that never ran 0001/0003).
-- ------------------------------------------------------------

do $$
declare
  v_source uuid;
  v_transfers integer;
  v_income integer;
begin
  if to_regclass('public.transactions') is null then
    raise warning 'skipping source backfill — public.transactions does not exist';
    return;
  end if;

  select id into v_source
  from public.categories
  where user_id is null and type = 'income' and is_system
  order by (slug = 'lainnya-in') desc, (slug = 'lainnya') desc, id
  limit 1;

  if v_source is null then
    raise warning 'no system income source found — legacy transfers/income keep funding_source_id = null';
    return;
  end if;

  update public.transactions
  set funding_source_id = v_source
  where type = 'transfer'
    and funding_source_id is null
    and vault_id is not null;
  get diagnostics v_transfers = row_count;

  update public.transactions
  set category_id = v_source
  where type = 'income'
    and category_id is null
    and vault_id is not null;
  get diagnostics v_income = row_count;

  raise notice 'source backfill: % transfer rows, % income rows tagged to the system source', v_transfers, v_income;
end $$;

notify pgrst, 'reload schema';
