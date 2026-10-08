import { describe, expect, it } from "vitest";
import {
  availableSources,
  computeSourceBalances,
  sourceSlug,
  summarizeSources,
  type SourceCategory,
  type SourceTransaction,
} from "@/src/lib/sources";

const gaji: SourceCategory = {
  id: "src-gaji",
  slug: "gaji",
  name_key: "cat.gaji",
  icon: "briefcase",
  color: "emerald",
};
const magang: SourceCategory = {
  id: "src-magang",
  slug: "magang",
  name_key: "Magang",
  icon: "laptop",
  color: "cyan",
};
const hibah: SourceCategory = {
  id: "src-hibah",
  slug: "hibah",
  name_key: "Hibah",
};

const SOURCES = [gaji, magang, hibah];

function tx(over: Partial<SourceTransaction> = {}): SourceTransaction {
  return { type: "income", amount: 0, category_id: null, funding_source_id: null, ...over };
}

describe("computeSourceBalances", () => {
  it("menambah pemasukan ke sumbernya dan mengurangi pengeluaran yang didanainya", () => {
    const balances = computeSourceBalances(
      [
        tx({ type: "income", amount: 3_000_000, category_id: gaji.id }),
        tx({ type: "expense", amount: 500_000, funding_source_id: gaji.id }),
        tx({ type: "income", amount: 1_000_000, category_id: magang.id }),
        tx({ type: "expense", amount: 250_000, funding_source_id: magang.id }),
      ],
      SOURCES
    );
    expect(balances.get(gaji.id)).toBe(2_500_000);
    expect(balances.get(magang.id)).toBe(750_000);
  });

  it("memberi sumber yang belum pernah dipakai saldo nol", () => {
    const balances = computeSourceBalances([], SOURCES);
    expect(balances.get(hibah.id)).toBe(0);
    expect(balances.size).toBe(3);
  });

  it("mengabaikan expense lama tanpa sumber agar saldo sumber tidak berubah", () => {
    const balances = computeSourceBalances(
      [
        tx({ type: "income", amount: 2_000_000, category_id: gaji.id }),
        tx({ type: "expense", amount: 999_999 }),
      ],
      SOURCES
    );
    expect(balances.get(gaji.id)).toBe(2_000_000);
  });

  it("mengabaikan income tanpa kategori, expense tanpa sumber dana, dan transfer", () => {
    const balances = computeSourceBalances(
      [
        tx({ type: "income", amount: 500_000 }),
        tx({ type: "expense", amount: 500_000 }),
        tx({ type: "transfer", amount: 500_000 }),
      ],
      SOURCES
    );
    expect([...balances.values()]).toEqual([0, 0, 0]);
  });

  it("mengabaikan jumlah yang bukan angka", () => {
    const balances = computeSourceBalances(
      [
        tx({ type: "income", amount: NaN, category_id: gaji.id }),
        tx({ type: "income", amount: 100_000, category_id: gaji.id }),
      ],
      SOURCES
    );
    expect(balances.get(gaji.id)).toBe(100_000);
  });

  it("mencatat sumber yang muncul di transaksi tapi tidak di daftar", () => {
    const balances = computeSourceBalances(
      [tx({ type: "income", amount: 700_000, category_id: "src-baru" })],
      SOURCES
    );
    expect(balances.get("src-baru")).toBe(700_000);
  });

  it("menghasilkan saldo negatif ketika pengeluaran melebihi pemasukan", () => {
    const balances = computeSourceBalances(
      [
        tx({ type: "income", amount: 100_000, category_id: hibah.id }),
        tx({ type: "expense", amount: 250_000, funding_source_id: hibah.id }),
      ],
      SOURCES
    );
    expect(balances.get(hibah.id)).toBe(-150_000);
  });
});

describe("summarizeSources", () => {
  it("memecah pemasukan, pengeluaran, dan saldo per sumber", () => {
    const rows = summarizeSources(
      [
        tx({ type: "income", amount: 3_000_000, category_id: gaji.id }),
        tx({ type: "income", amount: 500_000, category_id: gaji.id }),
        tx({ type: "expense", amount: 1_000_000, funding_source_id: gaji.id }),
      ],
      SOURCES
    );
    expect(rows).toHaveLength(3);
    expect(rows[0]).toEqual({ source: gaji, income: 3_500_000, expense: 1_000_000, balance: 2_500_000 });
    expect(rows[1]).toEqual({ source: magang, income: 0, expense: 0, balance: 0 });
  });
});

describe("availableSources", () => {
  it("menyaring sumber bersaldo nol dan negatif", () => {
    const rows = summarizeSources(
      [
        tx({ type: "income", amount: 1_200_000, category_id: gaji.id }),
        tx({ type: "income", amount: 500_000, category_id: magang.id }),
        tx({ type: "income", amount: 100_000, category_id: hibah.id }),
        tx({ type: "expense", amount: 200_000, funding_source_id: hibah.id }),
      ],
      SOURCES
    );
    const available = availableSources(rows);
    expect(available.map((r) => r.source.id)).toEqual([gaji.id, magang.id]);
  });

  it("kosong saat tidak ada pemasukan sama sekali", () => {
    expect(availableSources(summarizeSources([], SOURCES))).toEqual([]);
  });
});

describe("sourceSlug", () => {
  it("menurunkan huruf dan mengganti spasi dengan tanda hubung", () => {
    expect(sourceSlug("Gaji Bulanan")).toBe("gaji-bulanan");
  });

  it("menghapus aksen", () => {
    expect(sourceSlug("Magang ")).toBe("magang");
    expect(sourceSlug("Ré")).toBe("re");
  });

  it("menghapus karakter yang tidak bisa jadi slug", () => {
    expect(sourceSlug("Bonus 2024!")).toBe("bonus-2024");
  });

  it("string kosong atau tanpa huruf dan angka menjadi string kosong", () => {
    expect(sourceSlug("   ")).toBe("");
    expect(sourceSlug("---")).toBe("");
  });

  it("potong slug yang terlalu panjang", () => {
    expect(sourceSlug("a".repeat(80))).toHaveLength(48);
  });

  it("dua nama berbeda kapitalisasi menghasilkan slug sama", () => {
    expect(sourceSlug("Gaji")).toBe(sourceSlug(" gaji "));
  });
});