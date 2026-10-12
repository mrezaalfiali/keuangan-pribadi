import type { SupabaseClient } from "@supabase/supabase-js";
import type { Category, CategoryType } from "@/src/lib/types";
import { stripGeneratedSuffix } from "@/src/lib/labels";

type CategorySeed = {
  type: CategoryType;
  slug: string;
  name_key: string;
  icon: string;
  color: string;
  is_system: true;
};

const DEFAULT_CATEGORIES: CategorySeed[] = [
  {
    type: "income",
    slug: "gaji",
    name_key: "cat.gaji",
    icon: "briefcase",
    color: "emerald",
    is_system: true,
  },
  {
    type: "income",
    slug: "freelance",
    name_key: "cat.freelance",
    icon: "laptop",
    color: "cyan",
    is_system: true,
  },
  {
    type: "income",
    slug: "investasi",
    name_key: "cat.investasi",
    icon: "trending-up",
    color: "violet",
    is_system: true,
  },
  {
    type: "income",
    slug: "bisnis",
    name_key: "cat.bisnis",
    icon: "store",
    color: "sky",
    is_system: true,
  },
  {
    type: "income",
    slug: "lainnya-in",
    name_key: "cat.incomeLain",
    icon: "coffee",
    color: "slate",
    is_system: true,
  },
  {
    type: "expense",
    slug: "makanan",
    name_key: "cat.makanan",
    icon: "utensils",
    color: "amber",
    is_system: true,
  },
  {
    type: "expense",
    slug: "transportasi",
    name_key: "cat.transportasi",
    icon: "car",
    color: "sky",
    is_system: true,
  },
  {
    type: "expense",
    slug: "belanja",
    name_key: "cat.belanja",
    icon: "shopping-bag",
    color: "rose",
    is_system: true,
  },
  {
    type: "expense",
    slug: "tagihan",
    name_key: "cat.tagihan",
    icon: "receipt",
    color: "violet",
    is_system: true,
  },
  {
    type: "expense",
    slug: "hiburan",
    name_key: "cat.hiburan",
    icon: "clapperboard",
    color: "pink",
    is_system: true,
  },
  {
    type: "expense",
    slug: "kesehatan",
    name_key: "cat.kesehatan",
    icon: "heart-pulse",
    color: "red",
    is_system: true,
  },
  {
    type: "expense",
    slug: "pendidikan",
    name_key: "cat.pendidikan",
    icon: "graduation-cap",
    color: "blue",
    is_system: true,
  },
  {
    type: "expense",
    slug: "lainnya-ex",
    name_key: "cat.expenseLain",
    icon: "circle-ellipsis",
    color: "slate",
    is_system: true,
  },
  {
    type: "expense",
    slug: "self-reward",
    name_key: "cat.selfReward",
    icon: "sparkles",
    color: "pink",
    is_system: true,
  },
  {
    type: "expense",
    slug: "keluarga",
    name_key: "cat.family",
    icon: "heart-handshake",
    color: "rose",
    is_system: true,
  },
  {
    type: "expense",
    slug: "anak",
    name_key: "cat.children",
    icon: "baby",
    color: "cyan",
    is_system: true,
  },
  {
    type: "expense",
    slug: "rumah-tangga",
    name_key: "cat.household",
    icon: "house",
    color: "amber",
    is_system: true,
  },
  {
    type: "expense",
    slug: "perawatan-diri",
    name_key: "cat.personalCare",
    icon: "flower-2",
    color: "violet",
    is_system: true,
  },
  {
    type: "expense",
    slug: "komunikasi",
    name_key: "cat.communication",
    icon: "wifi",
    color: "blue",
    is_system: true,
  },
  {
    type: "expense",
    slug: "kendaraan",
    name_key: "cat.vehicle",
    icon: "wrench",
    color: "sky",
    is_system: true,
  },
  {
    type: "expense",
    slug: "hewan-peliharaan",
    name_key: "cat.pets",
    icon: "paw-print",
    color: "orange",
    is_system: true,
  },
  {
    type: "expense",
    slug: "hadiah",
    name_key: "cat.gifts",
    icon: "gift",
    color: "pink",
    is_system: true,
  },
  {
    type: "expense",
    slug: "donasi",
    name_key: "cat.donations",
    icon: "hand-heart",
    color: "emerald",
    is_system: true,
  },
  {
    type: "expense",
    slug: "langganan",
    name_key: "cat.subscriptions",
    icon: "repeat",
    color: "violet",
    is_system: true,
  },
  {
    type: "expense",
    slug: "olahraga",
    name_key: "cat.fitness",
    icon: "dumbbell",
    color: "red",
    is_system: true,
  },
  {
    type: "expense",
    slug: "liburan",
    name_key: "cat.travel",
    icon: "plane",
    color: "cyan",
    is_system: true,
  },
  {
    type: "expense",
    slug: "pajak",
    name_key: "cat.tax",
    icon: "landmark",
    color: "slate",
    is_system: true,
  },
];

export function missingDefaultCategories(
  existing: readonly Pick<Category, "type" | "slug">[]
): CategorySeed[] {
  const existingKeys = new Set(existing.map(({ type, slug }) => `${type}:${slug}`));
  return DEFAULT_CATEGORIES.filter(({ type, slug }) => !existingKeys.has(`${type}:${slug}`));
}

/**
 * Skor kelayakan satu baris menjadi representasi tunggal untuk sebuah label.
 * Lebih rendah = menang, dibaca sebagai bit: `hasSuffix` (bit 2), `isShared`
 * (bit 1), `isSystem` (bit 0).
 *
 * Slug bersufiks generator (`hiburan-d22c0e0e`) selalu kalah dari slug polos
 * yang ia warisi, karena hanya slug polos yang membawa `name_key` translasi.
 * Baris katalog sistem (`user_id` NULL) kalah dari salinan milik pengguna.
 */
function dedupeRank(category: Pick<Category, "user_id" | "slug" | "is_system">): number {
  const slug = category.slug.trim();
  const hasSuffix = stripGeneratedSuffix(slug) === slug ? 0 : 1;
  const isShared = category.user_id === null ? 1 : 0;
  const isSystem = category.is_system ? 1 : 0;
  return (hasSuffix << 2) | (isShared << 1) | isSystem;
}

export function dedupeCategories<T extends Pick<Category, "id" | "user_id" | "type" | "slug" | "is_system">>(
  categories: readonly T[]
): T[] {
  const chosen = new Map<string, { category: T; rank: number }>();

  for (const category of categories) {
    const slug = category.slug.trim();
    const key = `${category.type}:${stripGeneratedSuffix(slug)}`;
    const rank = dedupeRank(category);
    const current = chosen.get(key);
    if (!current || rank < current.rank) chosen.set(key, { category, rank });
  }

  return Array.from(chosen.values(), (entry) => entry.category);
}

export async function ensureDefaultCategories(
  supabase: SupabaseClient,
  userId: string
): Promise<Category[]> {
  const filter = `user_id.is.null,user_id.eq.${userId}`;
  const { data: existing, error: readError } = await supabase
    .from("categories")
    .select("slug,type")
    .or(filter);
  if (readError) throw readError;

  const missing = missingDefaultCategories(existing ?? []);
  if (missing.length > 0) {
    const { error: insertError } = await supabase.from("categories").insert(
      missing.map((category) => ({ ...category, user_id: userId }))
    );
    if (insertError) {
      if (insertError.code !== "23505") throw insertError;

      const { data: concurrentRows, error: concurrentReadError } = await supabase
        .from("categories")
        .select("slug,type")
        .or(filter);
      if (concurrentReadError) throw concurrentReadError;
      if (missingDefaultCategories(concurrentRows ?? []).length > 0) throw insertError;
    }
  }

  const { data, error } = await supabase
    .from("categories")
    .select("*")
    .or(filter)
    .order("is_system", { ascending: false });
  if (error) throw error;
  return dedupeCategories((data as Category[]) ?? []);
}
