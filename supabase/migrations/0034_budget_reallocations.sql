-- ============================================================
-- 0034_budget_reallocations.sql
--
-- Pengalihan permanen sisa anggaran kategori ke kategori lain
-- dalam periode aktif yang sama. Ini mengubah izin belanja, bukan
-- saldo uang; limit_amount tetap merupakan batas dasar periode.
--
-- Semua transaksi yang memakai anggaran dan semua pinjaman
-- mengunci baris budgets terkait sebelum menghitung sisa. RPC
-- pengalihan memakai lock yang sama, sehingga dua aksi bersamaan
-- tidak dapat menggunakan sisa yang sama dua kali.
--
-- Jalankan manual setelah migrasi 0033_edit_transfer.sql.
-- ============================================================

create table if not exists public.budget_reallocations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  from_budget_id uuid not null references public.budgets(id) on delete restrict,
  to_budget_id uuid not null references public.budgets(id) on delete restrict,
  amount integer not null check (amount > 0),
  created_at timestamptz not null default now(),
  reversed_at timestamptz,
  reversed_by uuid references auth.users(id) on delete cascade,
  check (from_budget_id <> to_budget_id),
  check ((reversed_at is null) = (reversed_by is null))
);

create index if not exists idx_budget_reallocations_user
  on public.budget_reallocations(user_id);
create index if not exists idx_budget_reallocations_from_active
  on public.budget_reallocations(from_budget_id)
  where reversed_at is null;
create index if not exists idx_budget_reallocations_to_active
  on public.budget_reallocations(to_budget_id)
  where reversed_at is null;

alter table public.budget_reallocations enable row level security;

drop policy if exists "budget reallocations select own"
  on public.budget_reallocations;
create policy "budget reallocations select own"
  on public.budget_reallocations
  for select using (auth.uid() = user_id);

revoke all on public.budget_reallocations from public, anon, authenticated;
grant select on public.budget_reallocations to authenticated;

-- Reset intentionally clears allocation history before deleting budgets.
create or replace function public.reset_financial_data()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then raise exception 'err.auth'; end if;

  delete from public.user_achievements where user_id = v_uid;
  delete from public.points_log where user_id = v_uid;
  delete from public.transactions where user_id = v_uid;
  delete from public.allocation_rules where user_id = v_uid;
  delete from public.budget_reallocations where user_id = v_uid;
  delete from public.budgets where user_id = v_uid;
  delete from public.recurring_transactions where user_id = v_uid;
  delete from public.vaults where user_id = v_uid;

  update public.gamification_state
     set points = 0,
         streak_current = 0,
         streak_longest = 0,
         last_log_date = null,
         last_checkin_date = null,
         level = 1,
         updated_at = now()
   where user_id = v_uid;
end;
$$;

revoke all on function public.reset_financial_data() from public, anon;
grant execute on function public.reset_financial_data() to authenticated;

create or replace function public.guard_budget_reallocation_identity()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if (
    new.scope is distinct from old.scope
    or new.scope_id is distinct from old.scope_id
    or new.starts_on is distinct from old.starts_on
    or new.ends_on is distinct from old.ends_on
  ) and exists (
    select 1
    from public.budget_reallocations r
    where r.from_budget_id = old.id or r.to_budget_id = old.id
  ) then
    raise exception 'err.budgetHasReallocations';
  end if;
  return new;
end;
$$;

drop trigger if exists budgets_reallocation_identity_guard on public.budgets;
create trigger budgets_reallocation_identity_guard
before update of scope, scope_id, starts_on, ends_on on public.budgets
for each row execute function public.guard_budget_reallocation_identity();

create or replace function public.budget_spent_for(
  p_budget_id uuid,
  p_exclude_transaction_id bigint default null,
  p_exclude_group_id uuid default null
)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  v_budget public.budgets%rowtype;
  v_spent bigint;
begin
  select * into v_budget
  from public.budgets
  where id = p_budget_id;
  if not found then return 0; end if;

  select coalesce(sum(t.amount), 0)
  into v_spent
  from public.transactions t
  where t.user_id = v_budget.user_id
    and t.date between v_budget.starts_on and v_budget.ends_on
    and (p_exclude_transaction_id is null or t.id <> p_exclude_transaction_id)
    and (p_exclude_group_id is null or t.group_id is distinct from p_exclude_group_id)
    and (
      (
        t.type = 'expense'
        and (
          (v_budget.scope = 'category' and t.category_id = v_budget.scope_id)
          or (v_budget.scope = 'vault' and t.vault_id = v_budget.scope_id)
        )
      )
      or (
        v_budget.scope = 'category'
        and t.type = 'transfer'
        and t.transfer_direction = 'out'
        and t.category_id = v_budget.scope_id
      )
    );
  return v_spent;
end;
$$;

create or replace function public.budget_effective_limit_for(
  p_budget_id uuid,
  p_spent bigint,
  p_exclude_reallocation_id uuid default null
)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  v_budget public.budgets%rowtype;
  v_borrowed_in bigint;
  v_borrowed_out bigint;
  v_reallocated_in bigint;
  v_reallocated_out bigint;
  v_limit bigint;
begin
  select * into v_budget
  from public.budgets
  where id = p_budget_id;
  if not found then return 0; end if;

  select
    coalesce(sum(amount) filter (where to_budget_id = p_budget_id), 0),
    coalesce(sum(amount) filter (where from_budget_id = p_budget_id), 0)
  into v_borrowed_in, v_borrowed_out
  from public.budget_borrows
  where to_budget_id = p_budget_id or from_budget_id = p_budget_id;

  select
    coalesce(sum(amount) filter (where to_budget_id = p_budget_id), 0),
    coalesce(sum(amount) filter (where from_budget_id = p_budget_id), 0)
  into v_reallocated_in, v_reallocated_out
  from public.budget_reallocations
  where reversed_at is null
    and id is distinct from p_exclude_reallocation_id
    and (to_budget_id = p_budget_id or from_budget_id = p_budget_id);

  v_limit := greatest(
    0,
    v_budget.limit_amount
      + v_borrowed_in - v_borrowed_out
      + v_reallocated_in - v_reallocated_out
  );
  if v_budget.leftover_discarded then
    return greatest(0, least(v_limit, p_spent));
  end if;
  return v_limit;
end;
$$;

create or replace function public.guard_budget_transaction_write()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid;
  v_old_spends boolean := false;
  v_new_spends boolean := false;
  v_budget public.budgets%rowtype;
  v_spent bigint;
  v_limit bigint;
  v_exclude_id bigint;
  v_exclude_group uuid;
  v_error text;
begin
  if current_setting('nexora.restore_financial_backup', true) = 'on' then
    if tg_op = 'DELETE' then return old; end if;
    return new;
  end if;

  if tg_op <> 'INSERT' then
    v_user_id := old.user_id;
    v_old_spends :=
      old.type = 'expense'
      or (old.type = 'transfer' and old.transfer_direction = 'out');
  end if;
  if tg_op <> 'DELETE' then
    v_user_id := new.user_id;
    v_new_spends :=
      new.type = 'expense'
      or (new.type = 'transfer' and new.transfer_direction = 'out');
  end if;

  for v_budget in
    select b.*
    from public.budgets b
    where b.user_id = v_user_id
      and (
        (
          v_old_spends
          and old.date between b.starts_on and b.ends_on
          and (
            (b.scope = 'category' and old.category_id = b.scope_id)
            or (old.type = 'expense' and b.scope = 'vault' and old.vault_id = b.scope_id)
          )
        )
        or (
          v_new_spends
          and new.date between b.starts_on and b.ends_on
          and (
            (b.scope = 'category' and new.category_id = b.scope_id)
            or (new.type = 'expense' and b.scope = 'vault' and new.vault_id = b.scope_id)
          )
        )
      )
    order by b.id
    for update
  loop
    if not v_new_spends
      or new.date < v_budget.starts_on
      or new.date > v_budget.ends_on
      or not (
        (v_budget.scope = 'category' and new.category_id = v_budget.scope_id)
        or (
          new.type = 'expense'
          and v_budget.scope = 'vault'
          and new.vault_id = v_budget.scope_id
        )
      ) then
      continue;
    end if;

    v_exclude_id := null;
    v_exclude_group := null;
    if tg_op = 'UPDATE' then
      v_exclude_id := old.id;
      if old.type = 'transfer' and old.transfer_direction = 'out' then
        v_exclude_group := old.group_id;
      end if;
    end if;

    v_spent := public.budget_spent_for(
      v_budget.id,
      v_exclude_id,
      v_exclude_group
    );
    v_limit := public.budget_effective_limit_for(v_budget.id, v_spent);
    if v_spent + new.amount > v_limit then
      v_error := case
        when v_budget.scope = 'category'
          then 'transactions.budgetExceededCategory'
        else 'transactions.budgetExceededVault'
      end;
      raise exception using
        message = v_error,
        detail = json_build_object(
          'budget_id', v_budget.id,
          'remaining', greatest(0, v_limit - v_spent),
          'projected', v_spent + new.amount,
          'effective_limit', v_limit
        )::text;
    end if;
  end loop;

  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

drop trigger if exists transactions_budget_guard on public.transactions;
create trigger transactions_budget_guard
before insert or update or delete on public.transactions
for each row execute function public.guard_budget_transaction_write();

create or replace function public.guard_budget_borrow_write()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid;
  v_budget_id uuid;
  v_budget public.budgets%rowtype;
  v_lock_count integer := 0;
  v_spent bigint;
  v_borrowed_in bigint;
  v_borrowed_out bigint;
  v_reallocated_in bigint;
  v_reallocated_out bigint;
  v_limit bigint;
  v_exclude_borrow_id uuid;
begin
  if current_setting('nexora.restore_financial_backup', true) = 'on' then
    if tg_op = 'DELETE' then return old; end if;
    return new;
  end if;

  v_user_id := case when tg_op = 'DELETE' then old.user_id else new.user_id end;

  for v_budget in
    select b.*
    from public.budgets b
    where b.user_id = v_user_id
      and b.id = any(
        case
          when tg_op = 'INSERT' then array[new.from_budget_id, new.to_budget_id]
          when tg_op = 'DELETE' then array[old.from_budget_id, old.to_budget_id]
          else array[
            old.from_budget_id, old.to_budget_id,
            new.from_budget_id, new.to_budget_id
          ]
        end
      )
    order by b.id
    for update
  loop
    v_lock_count := v_lock_count + 1;
  end loop;

  if tg_op = 'DELETE' then return old; end if;

  if tg_op = 'UPDATE' then v_exclude_borrow_id := old.id; end if;

  if new.transaction_id is not null and not exists (
    select 1
    from public.transactions t
    where t.id = new.transaction_id
      and t.user_id = new.user_id
      and (
        t.type = 'expense'
        or (t.type = 'transfer' and t.transfer_direction = 'out')
      )
  ) then
    raise exception 'err.borrowNotFound';
  end if;

  select count(*) into v_lock_count
  from public.budgets b
  where b.user_id = new.user_id
    and b.id in (new.from_budget_id, new.to_budget_id);
  if v_lock_count <> 2 then raise exception 'err.borrowNotFound'; end if;

  perform 1
  from public.budgets a
  join public.budgets b
    on b.id = new.to_budget_id and b.user_id = new.user_id
  where a.id = new.from_budget_id
    and a.user_id = new.user_id
    and a.starts_on = b.starts_on
    and a.ends_on = b.ends_on
    and not a.leftover_discarded
    and not b.leftover_discarded;
  if not found then raise exception 'err.borrowPeriod'; end if;

  for v_budget_id in
    select unnest(array[new.from_budget_id, new.to_budget_id])
  loop
    select * into v_budget from public.budgets where id = v_budget_id;
    v_spent := public.budget_spent_for(v_budget.id);

    select
      coalesce(sum(amount) filter (where to_budget_id = v_budget.id), 0),
      coalesce(sum(amount) filter (where from_budget_id = v_budget.id), 0)
    into v_borrowed_in, v_borrowed_out
    from public.budget_borrows
    where (to_budget_id = v_budget.id or from_budget_id = v_budget.id)
      and (v_exclude_borrow_id is null or budget_borrows.id <> v_exclude_borrow_id);

    if new.to_budget_id = v_budget.id then
      v_borrowed_in := v_borrowed_in + new.amount;
    end if;
    if new.from_budget_id = v_budget.id then
      v_borrowed_out := v_borrowed_out + new.amount;
    end if;

    select
      coalesce(sum(amount) filter (where to_budget_id = v_budget.id), 0),
      coalesce(sum(amount) filter (where from_budget_id = v_budget.id), 0)
    into v_reallocated_in, v_reallocated_out
    from public.budget_reallocations
    where reversed_at is null
      and (to_budget_id = v_budget.id or from_budget_id = v_budget.id);

    v_limit := greatest(
      0,
      v_budget.limit_amount
        + v_borrowed_in - v_borrowed_out
        + v_reallocated_in - v_reallocated_out
    );
    if v_budget.leftover_discarded then
      v_limit := greatest(0, least(v_limit, v_spent));
    end if;
    if v_budget.id = new.from_budget_id and v_spent > v_limit then
      raise exception 'err.borrowRemaining';
    end if;
  end loop;

  return new;
end;
$$;

drop trigger if exists budget_borrows_budget_guard on public.budget_borrows;
create trigger budget_borrows_budget_guard
before insert or update or delete on public.budget_borrows
for each row execute function public.guard_budget_borrow_write();

create or replace function public.reallocate_budget_remainder(
  p_from_budget_id uuid,
  p_to_budget_id uuid,
  p_amount integer
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_from public.budgets%rowtype;
  v_to public.budgets%rowtype;
  v_lock record;
  v_lock_count integer := 0;
  v_spent bigint;
  v_limit bigint;
  v_id uuid;
  v_today date := timezone('Asia/Jakarta', now())::date;
begin
  if v_user_id is null then raise exception 'err.auth'; end if;
  if p_from_budget_id is null or p_to_budget_id is null
    or p_from_budget_id = p_to_budget_id then
    raise exception 'err.reallocationSame';
  end if;
  if p_amount is null or p_amount <= 0 then
    raise exception 'err.reallocationAmount';
  end if;

  for v_lock in
    select b.id
    from public.budgets b
    where b.user_id = v_user_id
      and b.id in (p_from_budget_id, p_to_budget_id)
    order by b.id
    for update
  loop
    v_lock_count := v_lock_count + 1;
  end loop;
  if v_lock_count <> 2 then raise exception 'err.reallocationNotFound'; end if;

  select * into v_from from public.budgets
  where id = p_from_budget_id and user_id = v_user_id;
  select * into v_to from public.budgets
  where id = p_to_budget_id and user_id = v_user_id;

  if v_from.scope <> 'category' or v_to.scope <> 'category'
    or v_from.starts_on <> v_to.starts_on
    or v_from.ends_on <> v_to.ends_on
    or v_today < v_from.starts_on or v_today > v_from.ends_on
    or not exists (
      select 1 from public.categories c
      where c.id = v_from.scope_id
        and c.type = 'expense'
        and (c.user_id is null or c.user_id = v_user_id)
    )
    or not exists (
      select 1 from public.categories c
      where c.id = v_to.scope_id
        and c.type = 'expense'
        and (c.user_id is null or c.user_id = v_user_id)
    ) then
    raise exception 'err.reallocationPeriod';
  end if;
  if v_from.leftover_discarded or v_to.leftover_discarded then
    raise exception 'err.reallocationDiscarded';
  end if;

  v_spent := public.budget_spent_for(v_from.id);
  v_limit := public.budget_effective_limit_for(v_from.id, v_spent);
  if p_amount > greatest(0, v_limit - v_spent) then
    raise exception 'err.reallocationRemaining';
  end if;

  insert into public.budget_reallocations(user_id, from_budget_id, to_budget_id, amount)
  values (v_user_id, v_from.id, v_to.id, p_amount)
  returning id into v_id;
  return v_id;
end;
$$;

create or replace function public.undo_budget_reallocation(p_reallocation_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_reallocation public.budget_reallocations%rowtype;
  v_from public.budgets%rowtype;
  v_to public.budgets%rowtype;
  v_lock record;
  v_lock_count integer := 0;
  v_spent bigint;
  v_limit bigint;
begin
  if v_user_id is null then raise exception 'err.auth'; end if;

  select * into v_reallocation
  from public.budget_reallocations
  where id = p_reallocation_id and user_id = v_user_id
  for update;
  if not found or v_reallocation.reversed_at is not null then
    raise exception 'err.reallocationNotFound';
  end if;

  for v_lock in
    select b.id
    from public.budgets b
    where b.user_id = v_user_id
      and b.id in (v_reallocation.from_budget_id, v_reallocation.to_budget_id)
    order by b.id
    for update
  loop
    v_lock_count := v_lock_count + 1;
  end loop;
  if v_lock_count <> 2 then raise exception 'err.reallocationNotFound'; end if;

  select * into v_from from public.budgets
  where id = v_reallocation.from_budget_id and user_id = v_user_id;
  select * into v_to from public.budgets
  where id = v_reallocation.to_budget_id and user_id = v_user_id;
  if timezone('Asia/Jakarta', now())::date < v_from.starts_on
    or timezone('Asia/Jakarta', now())::date > v_from.ends_on then
    raise exception 'err.reallocationNotActive';
  end if;
  if v_from.leftover_discarded or v_to.leftover_discarded then
    raise exception 'err.reallocationDiscarded';
  end if;

  v_spent := public.budget_spent_for(v_to.id);
  v_limit := public.budget_effective_limit_for(
    v_to.id,
    v_spent,
    v_reallocation.id
  );
  if v_spent > v_limit then raise exception 'err.reallocationUsed'; end if;

  update public.budget_reallocations
  set reversed_at = now(), reversed_by = v_user_id
  where id = v_reallocation.id
    and user_id = v_user_id
    and reversed_at is null;
  if not found then raise exception 'err.reallocationNotFound'; end if;
end;
$$;

revoke all on function public.budget_spent_for(uuid, bigint, uuid)
  from public, anon, authenticated;
revoke all on function public.budget_effective_limit_for(uuid, bigint, uuid)
  from public, anon, authenticated;
revoke all on function public.guard_budget_transaction_write()
  from public, anon, authenticated;
revoke all on function public.guard_budget_borrow_write()
  from public, anon, authenticated;
revoke all on function public.guard_budget_reallocation_identity()
  from public, anon, authenticated;
revoke all on function public.reallocate_budget_remainder(uuid, uuid, integer)
  from public, anon;
revoke all on function public.undo_budget_reallocation(uuid)
  from public, anon;
grant execute on function public.reallocate_budget_remainder(uuid, uuid, integer)
  to authenticated;
grant execute on function public.undo_budget_reallocation(uuid)
  to authenticated;

-- Restore wrapper keeps old backups valid and restores allocation history
-- in the same transaction. The old implementation remains private so an
-- older restore path cannot bypass the new history table.
do $$
begin
  if to_regprocedure('public.restore_financial_backup_base(jsonb)') is null then
    execute 'alter function public.restore_financial_backup(jsonb) rename to restore_financial_backup_base';
  end if;
end;
$$;

revoke all on function public.restore_financial_backup_base(jsonb)
  from public, anon, authenticated;

create or replace function public.restore_financial_backup(p_backup jsonb)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_total integer;
  v_rows integer := 0;
  v_row record;
  v_inserted integer;
  v_item record;
begin
  if v_user_id is null then raise exception 'err.auth'; end if;
  if p_backup ? 'budget_reallocations'
    and jsonb_typeof(p_backup->'budget_reallocations') is distinct from 'array' then
    raise exception 'err.backupFormat';
  end if;

  perform set_config('nexora.restore_financial_backup', 'on', true);
  v_total := public.restore_financial_backup_base(p_backup);

  for v_item in
    select key, value from jsonb_each(p_backup)
    where key = any(array[
      'categories', 'vaults', 'transactions', 'budgets',
      'allocation_rules', 'allocation_slots', 'recurring_transactions',
      'budget_borrows', 'vault_borrows', 'category_overrides',
      'budget_reallocations'
    ])
  loop
    v_rows := v_rows + jsonb_array_length(v_item.value);
    if jsonb_array_length(v_item.value) > 20000 or v_rows > 20000 then
      raise exception 'err.backupFormat';
    end if;
  end loop;

  if p_backup ? 'budget_reallocations' then
    for v_row in
      select * from jsonb_to_recordset(p_backup->'budget_reallocations') as x(
        id uuid, from_budget_id uuid, to_budget_id uuid, amount integer,
        created_at timestamptz, reversed_at timestamptz, reversed_by uuid
      )
    loop
      if v_row.id is null or v_row.from_budget_id is null
        or v_row.to_budget_id is null or v_row.from_budget_id = v_row.to_budget_id
        or v_row.amount is null or v_row.amount <= 0 then
        continue;
      end if;
      if not exists (
        select 1 from public.budgets b
        where b.id = v_row.from_budget_id and b.user_id = v_user_id
          and b.scope = 'category'
      ) or not exists (
        select 1 from public.budgets b
        where b.id = v_row.to_budget_id and b.user_id = v_user_id
          and b.scope = 'category'
      ) then
        continue;
      end if;
      if not exists (
        select 1
        from public.budgets b
        join public.categories c on c.id = b.scope_id
        where b.id in (v_row.from_budget_id, v_row.to_budget_id)
          and b.user_id = v_user_id
          and c.type = 'expense'
          and (c.user_id is null or c.user_id = v_user_id)
        group by b.user_id
        having count(*) = 2
      ) then
        continue;
      end if;
      if not exists (
        select 1
        from public.budgets source
        join public.budgets destination
          on destination.id = v_row.to_budget_id
        where source.id = v_row.from_budget_id
          and source.user_id = v_user_id
          and destination.user_id = v_user_id
          and source.starts_on = destination.starts_on
          and source.ends_on = destination.ends_on
      ) then
        continue;
      end if;
      insert into public.budget_reallocations(
        id, user_id, from_budget_id, to_budget_id, amount,
        created_at, reversed_at, reversed_by
      )
      values (
        v_row.id, v_user_id, v_row.from_budget_id, v_row.to_budget_id,
        v_row.amount, coalesce(v_row.created_at, now()),
        v_row.reversed_at,
        case when v_row.reversed_at is null then null else v_user_id end
      )
      on conflict (id) do nothing;
      get diagnostics v_inserted = row_count;
      v_total := v_total + v_inserted;
    end loop;
  end if;
  return v_total;
end;
$$;

revoke all on function public.restore_financial_backup(jsonb)
  from public, anon;
grant execute on function public.restore_financial_backup(jsonb)
  to authenticated;

notify pgrst, 'reload schema';

-- ------------------------------------------------------------
-- Verifikasi
-- ------------------------------------------------------------
select
  to_regclass('public.budget_reallocations') is not null as table_exists,
  (select count(*) from pg_policies
    where schemaname = 'public'
      and tablename = 'budget_reallocations'
      and policyname like 'budget reallocations %') as policy_count,
  exists (
    select 1 from pg_trigger
    where tgname = 'transactions_budget_guard'
      and not tgisinternal
  ) as transaction_guard_exists,
  exists (
    select 1 from pg_trigger
    where tgname = 'budget_borrows_budget_guard'
      and not tgisinternal
  ) as borrow_guard_exists,
  exists (
    select 1 from pg_trigger
    where tgname = 'budgets_reallocation_identity_guard'
      and not tgisinternal
  ) as budget_identity_guard_exists,
  pg_get_functiondef(
    'public.reallocate_budget_remainder(uuid,uuid,integer)'::regprocedure
  ) like '%for update%' as reallocation_uses_row_locks,
  pg_get_functiondef(
    'public.restore_financial_backup(jsonb)'::regprocedure
  ) like '%budget_reallocations%' as restore_supports_reallocations,
  (select count(*) from public.budget_reallocations) as existing_rows;
