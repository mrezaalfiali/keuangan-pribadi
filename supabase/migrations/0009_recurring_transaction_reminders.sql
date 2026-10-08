create table if not exists public.recurring_transactions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 80),
  note text check (char_length(note) <= 240),
  type text not null check (type in ('income', 'expense')),
  amount integer not null check (amount > 0),
  category_id uuid references public.categories(id) on delete set null,
  funding_source_id uuid references public.categories(id) on delete set null,
  vault_id uuid references public.vaults(id) on delete set null,
  frequency text not null check (frequency in ('weekly', 'monthly')),
  interval_count integer not null default 1 check (interval_count between 1 and 12),
  anchor_day smallint not null check (anchor_day between 1 and 31),
  due_on date not null,
  ends_on date,
  snoozed_until date,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (ends_on is null or ends_on >= due_on or not is_active),
  check (type = 'expense' or funding_source_id is null)
);

create index if not exists idx_recurring_transactions_due
  on public.recurring_transactions(user_id, is_active, due_on);

alter table public.recurring_transactions enable row level security;
drop policy if exists "recurring transactions select own" on public.recurring_transactions;
create policy "recurring transactions select own" on public.recurring_transactions
  for select using (auth.uid() = user_id);
drop policy if exists "recurring transactions insert own" on public.recurring_transactions;
create policy "recurring transactions insert own" on public.recurring_transactions
  for insert with check (auth.uid() = user_id);
drop policy if exists "recurring transactions update own" on public.recurring_transactions;
create policy "recurring transactions update own" on public.recurring_transactions
  for update using (auth.uid() = user_id);
drop policy if exists "recurring transactions delete own" on public.recurring_transactions;
create policy "recurring transactions delete own" on public.recurring_transactions
  for delete using (auth.uid() = user_id);
grant select, insert, update, delete on public.recurring_transactions to authenticated;

alter table public.transactions
  add column if not exists recurring_template_id uuid
    references public.recurring_transactions(id) on delete set null,
  add column if not exists recurring_due_on date;

create unique index if not exists idx_transactions_recurring_occurrence
  on public.transactions(recurring_template_id, recurring_due_on)
  where recurring_template_id is not null and recurring_due_on is not null;
grant insert (recurring_template_id, recurring_due_on) on public.transactions to authenticated;

create or replace function public.next_recurring_due_on(
  p_due_on date,
  p_frequency text,
  p_interval_count integer,
  p_anchor_day integer
)
returns date
language plpgsql
immutable
set search_path = public
as $$
declare
  v_next date;
begin
  if p_frequency = 'weekly' then
    v_next := p_due_on + (p_interval_count * 7);
  elsif p_frequency = 'monthly' then
    v_next := ((
      date_trunc('month', p_due_on)::date + make_interval(months => p_interval_count)
    ))::date;
    v_next := make_date(
      extract(year from v_next)::integer,
      extract(month from v_next)::integer,
      least(
        p_anchor_day,
        extract(day from (date_trunc('month', v_next) + interval '1 month - 1 day'))::integer
      )
    );
  else
    raise exception 'err.frequency';
  end if;
  return v_next;
end;
$$;

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
  if p_vault_id is not null and not exists (
    select 1 from public.vaults v
    where v.id = p_vault_id and v.user_id = auth.uid()
      and (v_template.type <> 'expense' or not v.is_locked)
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

create or replace function public.skip_recurring_occurrence(
  p_template_id uuid,
  p_due_on date,
  p_today date
)
returns void
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_template public.recurring_transactions%rowtype;
  v_next_due date;
begin
  if auth.uid() is null then
    raise exception 'err.auth';
  end if;
  if p_today <> timezone('Asia/Jakarta', now())::date then
    raise exception 'err.period';
  end if;
  select * into v_template
  from public.recurring_transactions
  where id = p_template_id and user_id = auth.uid()
  for update;
  if not found or not v_template.is_active or v_template.due_on <> p_due_on then
    raise exception 'err.occurrence';
  end if;
  if p_due_on > p_today then
    raise exception 'err.occurrence';
  end if;
  if v_template.snoozed_until is not null and v_template.snoozed_until > p_today then
    raise exception 'err.snoozed';
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
end;
$$;

create or replace function public.snooze_recurring_occurrence(
  p_template_id uuid,
  p_due_on date,
  p_today date,
  p_until date
)
returns void
language plpgsql
security invoker
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'err.auth';
  end if;
  if p_today <> timezone('Asia/Jakarta', now())::date then
    raise exception 'err.period';
  end if;
  update public.recurring_transactions
  set snoozed_until = p_until, updated_at = now()
  where id = p_template_id
    and user_id = auth.uid()
    and is_active
    and due_on = p_due_on
    and p_due_on <= p_today
    and p_until = p_today + 1;
  if not found then
    raise exception 'err.occurrence';
  end if;
end;
$$;

grant execute on function public.record_recurring_transaction(uuid, date, date, date, integer, uuid, uuid, uuid, text) to authenticated;
grant execute on function public.skip_recurring_occurrence(uuid, date, date) to authenticated;
grant execute on function public.snooze_recurring_occurrence(uuid, date, date, date) to authenticated;

notify pgrst, 'reload schema';
