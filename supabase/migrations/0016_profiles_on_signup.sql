-- ============================================================
-- 0016_profiles_on_signup.sql
--
-- Membuat baris public.profiles secara otomatis saat user auth dibuat.
--
-- Sebelumnya profil hanya dibuat di sisi aplikasi (`signUpAction`) dan hanya
-- ketika `signUp` mengembalikan session. Kalau konfirmasi email aktif, tidak
-- ada session, sehingga baris profil tidak pernah dibuat; `saveDisplayName`
-- lalu gagal dengan PGRST116 (0 baris) sampai `getProfile` sempat self-heal.
-- Trigger ini menjadikannya tanggung jawab database, bukan alur UI.
-- ============================================================

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, display_name)
  values (
    new.id,
    coalesce(
      nullif(new.raw_user_meta_data ->> 'display_name', ''),
      split_part(new.email, '@', 1)
    )
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Backfill: user yang sudah ada tetapi belum punya baris profil.
insert into public.profiles (id, display_name)
select
  u.id,
  coalesce(
    nullif(u.raw_user_meta_data ->> 'display_name', ''),
    split_part(u.email, '@', 1)
  )
from auth.users u
left join public.profiles p on p.id = u.id
where p.id is null
on conflict (id) do nothing;

notify pgrst, 'reload schema';
