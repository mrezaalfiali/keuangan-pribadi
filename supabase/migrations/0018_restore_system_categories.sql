-- Restore the shared built-in category catalog if its rows are missing.
-- User-created categories are left untouched.
insert into public.categories (user_id, type, slug, name_key, icon, color, is_system) values
  (null, 'income',  'gaji',        'cat.gaji',        'briefcase',       'emerald', true),
  (null, 'income',  'freelance',   'cat.freelance',   'laptop',          'cyan',    true),
  (null, 'income',  'investasi',   'cat.investasi',   'trending-up',     'violet',  true),
  (null, 'income',  'bisnis',      'cat.bisnis',      'store',           'sky',     true),
  (null, 'income',  'lainnya-in',  'cat.incomeLain',  'coffee',          'slate',   true),
  (null, 'expense', 'makanan',     'cat.makanan',     'utensils',        'amber',   true),
  (null, 'expense', 'transportasi','cat.transportasi','car',             'sky',     true),
  (null, 'expense', 'belanja',     'cat.belanja',     'shopping-bag',    'rose',    true),
  (null, 'expense', 'tagihan',     'cat.tagihan',     'receipt',         'violet',  true),
  (null, 'expense', 'hiburan',     'cat.hiburan',     'clapperboard',    'pink',    true),
  (null, 'expense', 'kesehatan',   'cat.kesehatan',   'heart-pulse',     'red',     true),
  (null, 'expense', 'pendidikan',  'cat.pendidikan',  'graduation-cap',  'blue',    true),
  (null, 'expense', 'lainnya-ex',  'cat.expenseLain', 'circle-ellipsis', 'slate',   true)
on conflict do nothing;

notify pgrst, 'reload schema';
