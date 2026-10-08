/**
 * Label display untuk `categories` dan `vaults`.
 *
 * Dua halaman punya resolver sendiri yang memberi hasil berbeda untuk baris
 * yang sama: Transaksi jatuh ke `slug` mentah, sementara Alokasi/Budget
 * memakai `name`. `slug` bukan nama -- ia identifier, dan generator-nya
 * menempelkan sufiks unik (`-<base36 timestamp>` dari createVault,
 * `-<8 hex id>` dari migrasi legacy) supaya dua baris berbeda nama tidak
 * menimpa. `hiburan-d22co` adalah `slug` yang bocor ke UI, bukan nama
 * kategorinya.
 *
 * Aturan di sini satu sumber kebenaran untuk semua halaman:
 *   1. `name_key` berawalan `cat.` -> kunci translasi (kategori sistem).
 *   2. `name_key` lain             -> literal (kategori buatan user, mis. "Gaji").
 *   3. `name`                      -> literal (vault selalu menyimpan nama).
 *   4. fallback                    -> slug yang dibersihkan & dikapitalisasi.
 */

export interface LabelTarget {
  slug: string;
  name_key?: string | null;
  name?: string | null;
}

/**
 * Sufiks uniqueness hanya dibuang kalau benar-benar terlihat seperti token
 * hasil generator: >= 5 karakter dan mengandung angka. Ambang 5 itu yang
 * membuat `lainnya-ex` / `lainnya-in` tetap utuh, sementara
 * `hiburan-d22co` -> `hiburan`.
 */
function stripGeneratedSuffix(slug: string): string {
  const base = slug.slice(0, slug.lastIndexOf("-") + 1);
  const suffix = slug.slice(base.length);
  // Tanpa tanda hubung, atau sufiks yang bukan token generator (terlalu pendek
  // atau tanpa angka), slug dipakai utuh.
  if (!base || suffix.length < 5 || !/\d/.test(suffix)) return slug;
  return base.replace(/-+$/, "");
}

/** `hiburan-d22co` -> `Hiburan`, `makanan` -> `Makanan`, `lainnya-ex` -> `Lainnya Ex`. */
export function humanizeSlug(slug: string): string {
  const cleaned = stripGeneratedSuffix(slug.trim());
  return cleaned
    .split("-")
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

/**
 * Label untuk `categories` maupun `vaults`.
 *
 * `translate` hanya dipanggil untuk kunci berawalan `cat.`, jadi pemanggil
 * cukup mengoper `useTranslations("cat")` tanpa risiko kunci yang salah.
 */
export function resolveLabel(
  target: LabelTarget | null | undefined,
  translate: (key: string) => string
): string | null {
  if (!target) return null;

  const key = target.name_key?.trim();
  if (key) {
    if (key.startsWith("cat.")) return translate(key.slice(4));
    return key;
  }

  const name = target.name?.trim();
  if (name) return name;

  return humanizeSlug(target.slug) || target.slug;
}

/**
 * Apakah nama baru bertabrakan dengan nama yang sudah ada.
 *
 * `slug` tidak bisa dipakai untuk ini: generator lamanya menempelkan sufiks
 * unik supaya dua nama boleh berdampingan, jadi baris lama menyimpan slug
 * bersufiks (`dana-darurat-mursi6mw`) yang tidak akan pernah sama dengan slug
 * polos dari form. Membandingkan `slug` akan loloskan vault kembar yang
 * tampilannya identik di daftar. Yang dilihat user adalah namanya, jadi
 * perbandingan dilakukan pada `name` yang dinormalisasi.
 */
export function isDuplicateName(
  existingNames: readonly (string | null | undefined)[],
  candidate: string
): boolean {
  const target = normalizeNameKey(candidate);
  if (!target) return false;
  return existingNames.some((name) => name != null && normalizeNameKey(name) === target);
}

/**
 * Kunci pembanding nama: sama dengan `sourceSlug`, ditulis ulang agar modul ini
 * tidak bergantung pada `sources.ts` yang menarik dependensi lain.
 */
function normalizeNameKey(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}