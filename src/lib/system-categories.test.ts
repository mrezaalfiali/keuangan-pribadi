import { describe, expect, it } from "vitest";
import { missingDefaultCategories } from "@/src/lib/system-categories";

describe("missingDefaultCategories", () => {
  it("returns the complete built-in catalog when no categories exist", () => {
    const missing = missingDefaultCategories([]);

    expect(missing).toHaveLength(27);
    expect(missing.filter((category) => category.type === "expense")).toHaveLength(22);
    expect(missing.filter((category) => category.type === "income")).toHaveLength(5);
    expect(missing.map((category) => category.slug)).toEqual(
      expect.arrayContaining([
        "self-reward",
        "keluarga",
        "anak",
        "rumah-tangga",
        "perawatan-diri",
        "komunikasi",
        "kendaraan",
        "hewan-peliharaan",
        "hadiah",
        "donasi",
        "langganan",
        "olahraga",
        "liburan",
        "pajak",
      ])
    );
  });

  it("keeps existing built-in and user categories without duplicating them", () => {
    const missing = missingDefaultCategories([
      { type: "expense", slug: "makanan" },
      { type: "income", slug: "gaji" },
      { type: "expense", slug: "rumah" },
    ]);

    expect(missing).toHaveLength(25);
    expect(missing.some((category) => category.slug === "makanan")).toBe(false);
    expect(missing.some((category) => category.slug === "rumah")).toBe(false);
    expect(missing.some((category) => category.slug === "transportasi")).toBe(true);
  });
});
