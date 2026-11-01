-- ============================================================
-- 0027_edit_income_locked_vault.sql
--
-- Menutup sisa lubang aturan kunci vault pada jalur edit: pemasukan.
--
-- Invarian kunci: saldo vault terkunci hanya boleh BERTAMBAH (deposit),
-- tidak pernah berkurang. Expense/transfer baru, edit expense, expense
-- berulang, dan transfer manual sudah memeriksa kunci; edit pemasukan
-- tidak pernah melakukannya, sehingga uang bisa keluar dari vault
-- terkunci hanya dengan merubah vault atau menurunkan nominal sebuah
-- pemasukan lewat form edit.
--
-- Aturan baru di cabang income (setelah guard vault wajib dari 0025):
--   * vault lama terkunci + p_vault_id berbeda  -> ditolak
--     (uang keluar dari vault terkunci);
--   * vault lama terkunci + p_amount lebih kecil -> ditolak
--     (penarikan sebagian lewat pengurangan nominal);
--   * vault lama terkunci + nominal naik / hanya catatan-tanggal-kategori
--     -> diizinkan (tidak mengurangi saldo);
--   * deposit KE vault terkunci dari vault lain  -> diizinkan
--     (konsisten dengan form tambah transaksi).
--
-- Idempoten: `create or replace`. Tidak ada perubahan skema/data;
-- revoke/grant disalin dari 0025. Definisi disalin dari
-- 0025_income_vault_enforcement.sql.
-- ============================================================

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
    -- Pemasukan selalu harus menunjuk vault: baris dengan vault_id null
    -- menghitung kas namun tidak masuk saldo mana pun, sehingga total
    -- vault tidak pernah bisa disamakan dengan total uang.
    if p_vault_id is null then
      raise exception 'transactions.vaultRequired';
    end if;

    -- Kunci vault: uang yang sudah berada di vault terkunci tidak boleh
    -- keluar lewat edit. Berpindah vault = keluar seluruhnya; menurunkan
    -- nominal = penarikan sebagian. Keduanya ditolak selama vault lama
    -- masih terkunci, berapa pun nominal barunya.
    if v_transaction.vault_id is not null and exists (
      select 1 from public.vaults v
      where v.id = v_transaction.vault_id and v.user_id = auth.uid() and v.is_locked
    ) and (
      p_vault_id is distinct from v_transaction.vault_id
      or p_amount < v_transaction.amount
    ) then
      raise exception 'transactions.lockedError';
    end if;

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
-- Verifikasi:
--   1. guard vault wajib (0025) masih ada;
--   2. guard kunci (0027) ada: pindah vault / turun nominal dari vault
--      terkunci harus memuat ekspresi is distinct from ini.
-- ------------------------------------------------------------
select p.oid::regprocedure as function,
       (pg_get_functiondef(p.oid) like '%p_vault_id is null%raise exception ''transactions.vaultRequired''%') as income_vault_guard,
       (pg_get_functiondef(p.oid) like '%is distinct from v_transaction.vault_id%raise exception ''transactions.lockedError''%') as income_locked_guard
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname = 'edit_financial_transaction';
