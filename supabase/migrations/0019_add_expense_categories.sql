-- Add common built-in expense categories for all accounts.
-- Existing user categories are left untouched.
insert into public.categories (user_id, type, slug, name_key, icon, color, is_system) values
  (null, 'expense', 'self-reward',      'cat.selfReward',     'sparkles',        'pink',    true),
  (null, 'expense', 'keluarga',         'cat.family',         'heart-handshake', 'rose',    true),
  (null, 'expense', 'anak',             'cat.children',       'baby',            'cyan',    true),
  (null, 'expense', 'rumah-tangga',     'cat.household',      'house',           'amber',   true),
  (null, 'expense', 'perawatan-diri',   'cat.personalCare',   'flower-2',        'violet',  true),
  (null, 'expense', 'komunikasi',       'cat.communication',  'wifi',            'blue',    true),
  (null, 'expense', 'kendaraan',        'cat.vehicle',        'wrench',          'sky',     true),
  (null, 'expense', 'hewan-peliharaan', 'cat.pets',           'paw-print',       'orange',  true),
  (null, 'expense', 'hadiah',           'cat.gifts',          'gift',            'pink',    true),
  (null, 'expense', 'donasi',           'cat.donations',      'hand-heart',      'emerald', true),
  (null, 'expense', 'langganan',        'cat.subscriptions',  'repeat',          'violet',  true),
  (null, 'expense', 'olahraga',         'cat.fitness',        'dumbbell',        'red',     true),
  (null, 'expense', 'liburan',          'cat.travel',         'plane',           'cyan',    true),
  (null, 'expense', 'pajak',            'cat.tax',            'landmark',        'slate',   true)
on conflict do nothing;

notify pgrst, 'reload schema';
