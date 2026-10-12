import { describe, expect, it } from "vitest";
import { missingDefaultCategories } from "@/src/lib/system-categories";

describe("missingDefaultCategories", () => {
  it("returns the complete built-in catalog when no categories exist", () => {
    const missing = missingDefaultCategories([]);

    expect(missing).toHaveLength(13);
    expect(missing.filter((category) => category.type === "expense")).toHaveLength(8);
    expect(missing.filter((category) => category.type === "income")).toHaveLength(5);
  });

  it("keeps existing built-in and user categories without duplicating them", () => {
    const missing = missingDefaultCategories([
      { type: "expense", slug: "makanan" },
      { type: "income", slug: "gaji" },
      { type: "expense", slug: "rumah" },
    ]);

    expect(missing).toHaveLength(11);
    expect(missing.some((category) => category.slug === "makanan")).toBe(false);
    expect(missing.some((category) => category.slug === "rumah")).toBe(false);
    expect(missing.some((category) => category.slug === "transportasi")).toBe(true);
  });
});
