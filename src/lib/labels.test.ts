import { describe, expect, it } from "vitest";
import { humanizeSlug, isDuplicateName, resolveLabel } from "@/src/lib/labels";

/** Fake `useTranslations("cat")`; mirrors the real `cat` namespace. */
const CAT: Record<string, string> = {
  gaji: "Gaji",
  hiburan: "Hiburan",
  makanan: "Makanan",
  expenseLain: "Pengeluaran Lain",
};
const translate = (key: string) => {
  const value = CAT[key];
  if (value === undefined) throw new Error(`Missing translation: cat.${key}`);
  return value;
};

describe("humanizeSlug", () => {
  it("menghapus sufiks base36 hasil generator slug", () => {
    expect(humanizeSlug("hiburan-d22co")).toBe("Hiburan");
    expect(humanizeSlug("tabungan-mursi6mw")).toBe("Tabungan");
  });

  it("menghapus sufiks id hex dari migrasi legacy", () => {
    expect(humanizeSlug("makanan-a1b2c3d4")).toBe("Makanan");
  });

  it("mempertahankan sufiks yang memang bagian nama", () => {
    expect(humanizeSlug("lainnya-ex")).toBe("Lainnya Ex");
    expect(humanizeSlug("lainnya-in")).toBe("Lainnya In");
    expect(humanizeSlug("tagihan-listrik")).toBe("Tagihan Listrik");
  });

  it("mengubah slug polos menjadi Title Case", () => {
    expect(humanizeSlug("hiburan")).toBe("Hiburan");
    expect(humanizeSlug("lainnya")).toBe("Lainnya");
  });

  it("tidak merusak slug yang tidak punya sufiks numerik", () => {
    expect(humanizeSlug("kopi")).toBe("Kopi");
    expect(humanizeSlug("")).toBe("");
  });
});

describe("resolveLabel", () => {
  it("menerjemahkan kategori sistem lewat name_key cat.*", () => {
    expect(resolveLabel({ slug: "hiburan", name_key: "cat.hiburan" }, translate)).toBe(
      "Hiburan"
    );
    expect(resolveLabel({ slug: "lainnya", name_key: "cat.expenseLain" }, translate)).toBe(
      "Pengeluaran Lain"
    );
  });

  it("menampilkan name_key literal apa adanya untuk kategori buatan user", () => {
    expect(resolveLabel({ slug: "gaji-kontraktor", name_key: "Gaji Kontraktor" }, translate)).toBe(
      "Gaji Kontraktor"
    );
  });

  it("memakai name untuk vault sebelum menyentuh slug", () => {
    expect(resolveLabel({ slug: "dana-darurat-mursi6mw", name: "Dana Darurat" }, translate)).toBe(
      "Dana Darurat"
    );
  });

  it("membersihkan suffix acak saat tidak ada nama yang tersimpan", () => {
    expect(resolveLabel({ slug: "hiburan-d22co", name_key: null }, translate)).toBe("Hiburan");
  });

  it("tidak melempar untuk slug yang tidak punya pasangan nama", () => {
    expect(resolveLabel({ slug: "hiburan-d22co" }, translate)).toBe("Hiburan");
  });

  it("mengembalikan null untuk target yang tidak ada", () => {
    expect(resolveLabel(null, translate)).toBeNull();
    expect(resolveLabel(undefined, translate)).toBeNull();
  });

  it("mengabaikan name_key kosong yang hanya berisi whitespace", () => {
    expect(resolveLabel({ slug: "hiburan-d22co", name_key: "   " }, translate)).toBe("Hiburan");
  });
});

describe("isDuplicateName", () => {
  it("menandai vault kembar yang slug lamanya bersufiks", () => {
    // Regresi: `slug` baris ini adalah `dana-darurat-mursi6mw`, jadi cek
    // slug-vs-slug polos akan bilang tidak ada duplikat dan user melihat
    // "Dana Darurat" dua kali.
    const existing = ["Dana Darurat"];
    expect(isDuplicateName(existing, "Dana Darurat")).toBe(true);
  });

  it("mengabaikan perbedaan huruf besar-kecil dan spasi", () => {
    expect(isDuplicateName(["Dana Darurat"], "dana darurat")).toBe(true);
    expect(isDuplicateName(["dana   darurat"], "DANA-DARURAT")).toBe(true);
    expect(isDuplicateName([" Dana Darurat "], "Dana Darurat")).toBe(true);
  });

  it("mengabaikan tanda baca dan aksen", () => {
    expect(isDuplicateName(["Dana Darurat!"], "dana darurat")).toBe(true);
    expect(isDuplicateName(["Café"], "Cafe")).toBe(true);
  });

  it("menerima nama yang benar-benar berbeda", () => {
    expect(isDuplicateName(["Dana Darurat"], "Tabungan")).toBe(false);
    expect(isDuplicateName(["Dana Darurat"], "Dana Darurat 2")).toBe(false);
    expect(isDuplicateName([], "Dana Darurat")).toBe(false);
  });

  it("mengabaikan baris tanpa nama dan kandidat kosong", () => {
    expect(isDuplicateName([null, undefined, ""], "Dana Darurat")).toBe(false);
    expect(isDuplicateName(["Dana Darurat"], "   ")).toBe(false);
  });
});