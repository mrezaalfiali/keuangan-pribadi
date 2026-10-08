-- ============================================================
-- 0006 — Transaction split groups
--
-- Adds group_id to link rows created by income allocation splits.
-- ============================================================

do $$
begin
  if to_regclass('public.transactions') is null then
    raise warning 'skipping group_id — public.transactions does not exist';
    return;
  end if;

  alter table public.transactions add column if not exists group_id uuid;

  create index if not exists idx_transactions_group_user
    on public.transactions (user_id, group_id)
    where group_id is not null;
end;
$$;

do $$
begin
  if to_regclass('public.transactions') is null then
    raise warning 'skipping group_id grants — public.transactions does not exist';
    return;
  end if;

  execute 'grant select (group_id), insert (group_id), update (group_id) '
       || 'on public.transactions to authenticated';
end;
$$;

notify pgrst, 'reload schema';