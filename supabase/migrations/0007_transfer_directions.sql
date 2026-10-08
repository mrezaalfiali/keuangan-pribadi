-- ============================================================
-- 0007 — Vault transfer directions
--
-- Marks paired transfer rows as outgoing or incoming so derived vault
-- balances can subtract the source and add the destination.
-- Existing transfer rows remain NULL because their direction cannot be
-- inferred safely from the historical ledger.
-- ============================================================

do $$
begin
  if to_regclass('public.transactions') is null then
    raise warning 'skipping transfer directions — public.transactions does not exist';
    return;
  end if;

  alter table public.transactions
    add column if not exists transfer_direction text;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.transactions'::regclass
      and conname = 'transactions_transfer_direction_check'
  ) then
    alter table public.transactions
      add constraint transactions_transfer_direction_check
      check (
        transfer_direction is null
        or (type = 'transfer' and transfer_direction in ('out', 'in'))
      ) not valid;
  end if;

  execute 'grant select (transfer_direction), insert (transfer_direction), update (transfer_direction) '
       || 'on public.transactions to authenticated';
end;
$$;

notify pgrst, 'reload schema';
