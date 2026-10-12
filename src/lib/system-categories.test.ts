import { describe, expect, it } from "vitest";
import { dedupeCategories, missingDefaultCategories } from "@/src/lib/system-categories";
import type { Category } from "@/src/lib/types";

type DedupeRow = Pick<Category, "id" | "user_id" | "type" | "slug" | "is_system">;

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

  it("prefers the user-specific copy over the shared system copy when slug matches", () => {
    const categories: Category[] = [
      {
        id: "system-hiburan",
        user_id: null,
        type: "expense",
        slug: "hiburan",
        name_key: "cat.hiburan",
        icon: "clapperboard",
        color: "pink",
        is_system: true,
      },
      {
        id: "user-hiburan",
        user_id: "user-123",
        type: "expense",
        slug: "hiburan",
        name_key: "Hiburan",
        icon: "clapperboard",
        color: "pink",
        is_system: false,
      },
    ];

    const deduped = dedupeCategories(categories);
    expect(deduped).toHaveLength(1);
    expect(deduped[0].id).toBe("user-hiburan");
  });

  it("merges a generated-suffix slug with the plain slug it was derived from", () => {
    const categories: DedupeRow[] = [
      {
        id: "user-hiburan",
        user_id: "user-123",
        type: "expense",
        slug: "hiburan",
        is_system: false,
      },
      {
        id: "user-hiburan-suffixed",
        user_id: "user-123",
        type: "expense",
        slug: "hiburan-d22c0e0e",
        is_system: false,
      },
    ];

    const deduped = dedupeCategories(categories);
    expect(deduped).toHaveLength(1);
    expect(deduped[0].id).toBe("user-hiburan");
  });

  it("prefers the translated system copy over a suffixed user copy", () => {
    const categories: DedupeRow[] = [
      {
        id: "user-hiburan-suffixed",
        user_id: "user-123",
        type: "expense",
        slug: "hiburan-d22c0e0e",
        is_system: false,
      },
      {
        id: "system-hiburan",
        user_id: null,
        type: "expense",
        slug: "hiburan",
        is_system: true,
      },
    ];

    const deduped = dedupeCategories(categories);
    expect(deduped).toHaveLength(1);
    expect(deduped[0].id).toBe("system-hiburan");
  });

  it("keeps slugs whose trailing segment is not a generated suffix", () => {
    const categories: DedupeRow[] = [
      { id: "lainnya-ex", user_id: null, type: "expense", slug: "lainnya-ex", is_system: true },
      { id: "lainnya-in", user_id: null, type: "income", slug: "lainnya-in", is_system: true },
      { id: "rumah-tangga", user_id: null, type: "expense", slug: "rumah-tangga", is_system: true },
      { id: "rumah", user_id: "user-123", type: "expense", slug: "rumah", is_system: false },
    ];

    const deduped = dedupeCategories(categories);
    expect(deduped.map((category) => category.id).sort()).toEqual([
      "lainnya-ex",
      "lainnya-in",
      "rumah",
      "rumah-tangga",
    ]);
  });
});
