-- ============================================================
-- 0033_edit_transfer.sql
--
-- Membuka jalur edit untuk transfer antar vault, sekaligus memperkenalkan
-- kategori opsional pada transfer (alasan pemindahan dana, mis. investasi).
--
-- Selama ini `edit_financial_transaction` menolak semua baris dengan
-- group_id terisi (0010:57-59), sehingga transfer -- yang selalu tersusun
-- atas dua baris (out + dalam satu group) -- tidak pernah bisa diedit.
--
-- Cabang transfer yang baru divalidasi berurutan:
--   1. pasangan wajib tepat dua baris: satu 'out' satu 'in', vault berbeda
--      (pasangan legacy tanpa transfer_direction dari sebelum 0007 ditolak
--      karena arahnya tidak bisa diinferensi);
--   2. transfer yang menjadi agunan pinjaman vault (transfer_out_id) atau
--      bagian pembayaran pinjaman (repayment_group_ids) ditolak -- pola
--      guard yang sama dengan penghapusan transaksi;
--   3. kategori opsional harus bertipe 'expense' (katalog income/expense
--      tidak punya tipe 'transfer'); sumber dana wajib bertipe 'income';
--   4. vault asal/tujuan TIDAK bisa diubah lewat edit: p_vault_id harus
--      kosong atau menunjuk vault asal yang sama;
--   5. aturan lama dipertahankan: pool (sumber x vault asal) dan saldo
--      vault asal cukup untuk nominal baru, serta invarian kunci vault
--      (saldo vault terkunci hanya boleh naik: nominal naik dari vault
--      asal terkunci ditolak, nominal turun ke vault tujuan terkunci
--      ditolak);
--   6. kedua baris group diupdate bersamaan agar selalu seimbang.
--
-- Pemasukan/expense dengan group_id (split alokasi) tetap ditolak; body
-- cabang income/expense tidak berubah dari 0027.
--
-- Idempoten: `create or replace`, signature sama dengan 0027 (tidak perlu
-- drop -- PostgREST tetap memakai fungsi yang sama). Tidak ada perubahan
-- skema/data. Definisi dasar disalin dari 0027_edit_income_locked_vault.sql.
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
  v_out public.transactions%rowtype;
  v_in public.transactions%rowtype;
  v_leg public.transactions%rowtype;
  v_leg_count integer := 0;
  v_source_locked boolean;
  v_dest_locked boolean;
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

  if v_transaction.type = 'transfer' then
    if v_transaction.group_id is null then
      raise exception 'err.editUnsupported';
    end if;

    -- Kunci seluruh baris group berurutan id supaya dua editor yang saling
    -- menangani leg berbeda tidak saling menunggu (deadlock).
    for v_leg in
      select * from public.transactions t
      where t.group_id = v_transaction.group_id and t.user_id = auth.uid()
      order by t.id
      for update
    loop
      v_leg_count := v_leg_count + 1;
      if v_leg.type <> 'transfer' then raise exception 'err.editUnsupported'; end if;
      if v_leg.transfer_direction = 'out' then
        if v_out.id is not null then raise exception 'err.editUnsupported'; end if;
        v_out := v_leg;
      elsif v_leg.transfer_direction = 'in' then
        if v_in.id is not null then raise exception 'err.editUnsupported'; end if;
        v_in := v_leg;
      else
        -- Arah kosong = pasangan legacy yang tidak bisa diinferensi.
        raise exception 'err.editUnsupported';
      end if;
    end loop;
    if v_leg_count <> 2
      or v_out.vault_id is null or v_in.vault_id is null
      or v_out.vault_id = v_in.vault_id then
      raise exception 'err.editUnsupported';
    end if;

    -- Transfer yang terikat catatan pinjaman vault tidak boleh diubah:
    -- mengubah nominal akan mendesinkronkan outstanding yang dikembalikan
    -- saat penghapusan, dan mengubah vault/sumber akan membatalkan jaminan.
    if exists (
      select 1 from public.vault_borrows b
      where b.user_id = auth.uid()
        and (b.transfer_out_id in (v_out.id, v_in.id)
             or v_transaction.group_id = any(b.repayment_group_ids))
    ) then
      raise exception 'transactions.transferLinkedBlocked';
    end if;

    -- Kategori transfer opsional, tetapi harus dari daftar pengeluaran.
    if p_category_id is not null and not exists (
      select 1 from public.categories c
      where c.id = p_category_id and c.type = 'expense'
        and (c.user_id is null or c.user_id = auth.uid())
    ) then
      raise exception 'err.category';
    end if;

    -- Sumber dana wajib dan bertipe pemasukan (pola cabang expense).
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

    -- Vault tidak berubah lewat edit transfer: p_vault_id harus kosong
    -- (form menonaktifkan field-nya) atau menunjuk vault asal yang sama.
    if p_vault_id is not null and p_vault_id is distinct from v_out.vault_id then
      raise exception 'err.vault';
    end if;

    -- Pool rule: hanya uang yang benar-benar dipegang sumber ini di vault
    -- asal yang boleh membiayai nominal baru. Add-back debit baris lama
    -- hanya saat sumber tidak berubah (vault tidak pernah berubah).
    v_pair_balance := public.transaction_source_vault_balance(p_funding_source_id, v_out.vault_id);
    if v_out.funding_source_id = p_funding_source_id then
      v_pair_balance := v_pair_balance + v_out.amount;
    end if;
    if v_pair_balance < p_amount then raise exception 'transactions.sourceNotInVault'; end if;

    -- Saldo vault asal cukup untuk nominal baru; kedua baris group
    -- dikecualikan sendiri supaya pasangan lama tidak ikut menghitung.
    select coalesce(sum(
      case
        when t.type = 'expense' then -t.amount
        when t.type = 'transfer' and t.transfer_direction = 'out' then -t.amount
        else t.amount
      end
    ), 0)
    into v_vault_balance
    from public.transactions t
    where t.user_id = auth.uid() and t.vault_id = v_out.vault_id
      and t.id <> v_out.id and t.id <> v_in.id;
    if v_vault_balance < p_amount then
      raise exception 'transactions.insufficient';
    end if;

    -- Invarian kunci: saldo vault terkunci hanya boleh naik.
    select coalesce(bool_or(v.is_locked), false) into v_source_locked
    from public.vaults v
    where v.id = v_out.vault_id and v.user_id = auth.uid();
    select coalesce(bool_or(v.is_locked), false) into v_dest_locked
    from public.vaults v
    where v.id = v_in.vault_id and v.user_id = auth.uid();
    if (v_source_locked and p_amount > v_out.amount)
      or (v_dest_locked and p_amount < v_in.amount) then
      raise exception 'transactions.lockedError';
    end if;

    update public.transactions
    set amount = p_amount,
        date = p_date,
        category_id = p_category_id,
        funding_source_id = p_funding_source_id,
        note = nullif(left(trim(coalesce(p_note, '')), 200), '')
    where group_id = v_transaction.group_id
      and user_id = auth.uid()
      and type = 'transfer';
    return;
  end if;

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
--   1. cabang transfer ada dan memuat guard tautan pinjaman;
--   2. vault transfer tidak bisa berubah (p_vault_id disamakan dengan
--      vault asal);
--   3. guard income dari 0025/0027 tidak hilang saat body disalin ulang.
-- ------------------------------------------------------------
select p.oid::regprocedure as function,
       (pg_get_functiondef(p.oid) like '%if v_transaction.type = ''transfer'' then%') as transfer_branch,
       (pg_get_functiondef(p.oid) like '%transactions.transferLinkedBlocked%') as transfer_link_guard,
       (pg_get_functiondef(p.oid) like '%p_vault_id is distinct from v_out.vault_id%') as transfer_vault_guard,
       (pg_get_functiondef(p.oid) like '%p_vault_id is null%raise exception ''transactions.vaultRequired''%') as income_vault_guard,
       (pg_get_functiondef(p.oid) like '%is distinct from v_transaction.vault_id%raise exception ''transactions.lockedError''%') as income_locked_guard
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname = 'edit_financial_transaction';
