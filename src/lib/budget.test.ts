import { describe, expect, it } from "vitest";
import {
  activePeriodRange,
  aggregateBorrows,
  aggregateReallocations,
  budgetDisplayStatus,
  budgetEffectiveLimit,
  budgetLeftover,
  budgetsOverlappingPeriod,
  budgetRatio,
  budgetSpend,
  budgetState,
  budgetStatus,
  budgetTransactions,
  defaultBudgetPeriod,
  eligibleBorrowLenders,
  findExceededBudget,
  findPreviousPeriodBudget,
  isValidPeriod,
  nextPeriod,
  paydayLabel,
  periodRange,
  planBorrowShrink,
  requiredBorrowTotal,
  unlimitedCategorySpends,
  type BudgetPeriod,
  type BudgetStatus,
} from "@/src/lib/budget";
import type { Transaction } from "@/src/lib/types";

// Periode mengikuti gaji: 10 Mar..9 Apr.
const PERIOD = { starts_on: "2026-03-10", ends_on: "2026-04-09" };

type TxSlice = Pick<Transaction, "type" | "amount" | "category_id" | "vault_id" | "date"> &
  Partial<Pick<Transaction, "transfer_direction" | "group_id">> & {
    id?: number;
  };

function tx(over: Partial<TxSlice> = {}): TxSlice {
  return {
    type: "expense",
    amount: 0,
    category_id: null,
    vault_id: null,
    date: "2026-03-15",
    ...over,
  };
}

describe("budgetSpend", () => {
  it("menghitung pengeluaran kategori di dalam periode", () => {
    const rows = [
      tx({ amount: 100_000, category_id: "cat-food" }),
      tx({ amount: 50_000, category_id: "cat-food" }),
      tx({ amount: 999_000, category_id: "cat-other" }),
    ];
    expect(budgetSpend(rows, { scope: "category", scope_id: "cat-food", ...PERIOD })).toBe(150_000);
  });

  it("menghitung pengeluaran vault di dalam periode", () => {
    const rows = [
      tx({ amount: 100_000, vault_id: "vault-a" }),
      tx({ amount: 70_000, vault_id: "vault-a" }),
      tx({ amount: 999_000, vault_id: "vault-b" }),
    ];
    expect(budgetSpend(rows, { scope: "vault", scope_id: "vault-a", ...PERIOD })).toBe(170_000);
  });

  it("tidak salah menghitung uuid vault sebagai uuid kategori", () => {
    // Regresi: implementasi lama selalu mencocokkan category_id, sehingga
    // anggaran scope vault selalu tercatat 0 terpakai.
    const sameId = "11111111-1111-1111-1111-111111111111";
    const rows = [tx({ amount: 250_000, category_id: null, vault_id: sameId })];
    expect(budgetSpend(rows, { scope: "vault", scope_id: sameId, ...PERIOD })).toBe(250_000);
    expect(budgetSpend(rows, { scope: "category", scope_id: sameId, ...PERIOD })).toBe(0);
  });

  it("mengabaikan tanggal sebelum dan sesudah batas periode", () => {
    const rows = [
      tx({ amount: 100_000, category_id: "cat-food", date: "2026-03-09" }),
      tx({ amount: 100_000, category_id: "cat-food", date: "2026-04-10" }),
      tx({ amount: 10_000, category_id: "cat-food", date: "2026-03-10" }),
      tx({ amount: 20_000, category_id: "cat-food", date: "2026-04-09" }),
    ];
    expect(budgetSpend(rows, { scope: "category", scope_id: "cat-food", ...PERIOD })).toBe(30_000);
  });

  it("menghitung ulang untuk periode yang berbeda pada transaksi yang sama", () => {
    // Justifikasi model rentang: pengeluaran 5 April masuk periode 10 Mar..9 Apr,
    // bukan periode 10 Apr..9 Mei, walau keduanya berdekatan.
    const rows = [tx({ amount: 75_000, category_id: "cat-food", date: "2026-04-05" })];
    expect(budgetSpend(rows, { scope: "category", scope_id: "cat-food", ...PERIOD })).toBe(75_000);
    expect(
      budgetSpend(rows, {
        scope: "category",
        scope_id: "cat-food",
        starts_on: "2026-04-10",
        ends_on: "2026-05-09",
      })
    ).toBe(0);
  });

  it("mengabaikan income dan transfer tanpa arah keluar", () => {
    const rows = [
      tx({ type: "income", amount: 500_000, category_id: "cat-food", vault_id: "vault-a" }),
      tx({
        type: "transfer",
        amount: 300_000,
        category_id: "cat-food",
        vault_id: "vault-a",
        transfer_direction: "in",
      }),
      tx({ amount: 20_000, category_id: "cat-food", vault_id: "vault-a" }),
    ];
    expect(budgetSpend(rows, { scope: "category", scope_id: "cat-food", ...PERIOD })).toBe(20_000);
    expect(budgetSpend(rows, { scope: "vault", scope_id: "vault-a", ...PERIOD })).toBe(20_000);
  });

  it("menghitung transfer keluar berkategori sekali saja pada anggaran kategori", () => {
    const rows = [
      tx({
        type: "transfer",
        amount: 300_000,
        category_id: "cat-food",
        vault_id: "vault-a",
        transfer_direction: "out",
        group_id: "transfer-1",
      }),
      tx({
        type: "transfer",
        amount: 300_000,
        category_id: "cat-food",
        vault_id: "vault-b",
        transfer_direction: "in",
        group_id: "transfer-1",
      }),
    ];
    expect(budgetSpend(rows, { scope: "category", scope_id: "cat-food", ...PERIOD })).toBe(300_000);
    expect(budgetSpend(rows, { scope: "vault", scope_id: "vault-a", ...PERIOD })).toBe(0);
    expect(budgetSpend(rows, { scope: "vault", scope_id: "vault-b", ...PERIOD })).toBe(0);
  });

  it("nol saat tidak ada transaksi atau tidak ada yang cocok", () => {
    expect(budgetSpend([], { scope: "category", scope_id: "cat-food", ...PERIOD })).toBe(0);
    expect(
      budgetSpend([tx({ amount: 10, category_id: "x" })], { scope: "category", scope_id: "y", ...PERIOD })
    ).toBe(0);
  });
});

describe("budgetStatus", () => {
  const cases: Array<[BudgetStatus, number, number, number?]> = [
    ["ok", 0, 1_000_000],
    ["ok", 700_000, 1_000_000],
    ["warning", 800_000, 1_000_000],
    ["warning", 900_000, 1_000_000],
    ["full", 1_000_000, 1_000_000],
    ["exceeded", 1_000_001, 1_000_000],
  ];
  for (const [expected, spent, limit, threshold] of cases) {
    it(`${expected} saat terpakai ${spent} dari ${limit}`, () => {
      expect(budgetStatus(spent, limit, threshold)).toBe(expected);
    });
  }

  it("batas nol tidak menghasilkan status exceeded", () => {
    expect(budgetStatus(50_000, 0)).toBe("ok");
  });

  it("menghormati threshold khusus", () => {
    expect(budgetStatus(500_000, 1_000_000, 0.5)).toBe("warning");
    expect(budgetStatus(400_000, 1_000_000, 0.5)).toBe("ok");
  });
});

describe("budgetRatio", () => {
  it("mengembalikan rasio terpakai terhadap batas", () => {
    expect(budgetRatio(250_000, 1_000_000)).toBeCloseTo(0.25);
  });

  it("nol saat batas tidak valid", () => {
    expect(budgetRatio(10, 0)).toBe(0);
  });
});

describe("budgetEffectiveLimit", () => {
  it("batas asli saat sisa belum ditutup", () => {
    expect(budgetEffectiveLimit({ limit_amount: 500_000 }, 200_000)).toBe(500_000);
    expect(
      budgetEffectiveLimit({ limit_amount: 500_000, leftover_discarded: false }, 200_000)
    ).toBe(500_000);
  });

  it("turun ke angka terpakai saat sisa ditutup", () => {
    expect(
      budgetEffectiveLimit({ limit_amount: 500_000, leftover_discarded: true }, 200_000)
    ).toBe(200_000);
  });

  it("nol saat sisa ditutup sebelum ada yang terpakai", () => {
    expect(
      budgetEffectiveLimit({ limit_amount: 500_000, leftover_discarded: true }, 0)
    ).toBe(0);
  });

  it("tidak dinaikkan melewati batas asli walau pemakaian sudah kelewat", () => {
    expect(
      budgetEffectiveLimit({ limit_amount: 500_000, leftover_discarded: true }, 600_000)
    ).toBe(500_000);
  });
});

describe("budgetDisplayStatus", () => {
  const budget = { limit_amount: 1_000_000, alert_threshold: 0.8 };

  it("mengikuti budgetStatus selama sisa belum ditutup", () => {
    expect(budgetDisplayStatus(budget, 500_000)).toBe("ok");
    expect(budgetDisplayStatus(budget, 800_000)).toBe("warning");
    expect(budgetDisplayStatus(budget, 1_000_000)).toBe("full");
    expect(budgetDisplayStatus(budget, 1_000_001)).toBe("exceeded");
  });

  it("seketika penuh begitu sisa ditutup, berapa pun terpakainya", () => {
    const closed = { ...budget, leftover_discarded: true };
    expect(budgetDisplayStatus(closed, 200_000)).toBe("full");
    expect(budgetDisplayStatus(closed, 1_000_000)).toBe("full");
  });

  it("tetap penuh walau belum ada yang terpakai", () => {
    expect(budgetDisplayStatus({ ...budget, leftover_discarded: true }, 0)).toBe("full");
  });

  it("menghormati threshold khusus", () => {
    expect(budgetDisplayStatus({ limit_amount: 1_000_000, alert_threshold: 0.5 }, 500_000)).toBe(
      "warning"
    );
  });
});

describe("isValidPeriod", () => {
  it("menerima rentang dengan panjang satu hari", () => {
    expect(isValidPeriod({ startsOn: "2026-03-10", endsOn: "2026-03-10" })).toBe(true);
  });

  it("menerima rentang yang melintasi bulan dan tahun", () => {
    expect(isValidPeriod({ startsOn: "2026-12-20", endsOn: "2027-01-19" })).toBe(true);
  });

  it("menolak rentang terbalik", () => {
    expect(isValidPeriod({ startsOn: "2026-04-09", endsOn: "2026-03-10" })).toBe(false);
  });

  it("menolak tanggal yang tidak ada di kalender", () => {
    expect(isValidPeriod({ startsOn: "2026-02-31", endsOn: "2026-03-10" })).toBe(false);
  });

  it("menolak format rusak", () => {
    expect(isValidPeriod({ startsOn: "bukan-tanggal", endsOn: "2026-03-10" })).toBe(false);
    expect(isValidPeriod({ startsOn: "2026-03", endsOn: "2026-03-10" })).toBe(false);
  });
});

describe("nextPeriod", () => {
  it("mempertahankan tanggal akhir pada siklus payday", () => {
    expect(nextPeriod({ startsOn: "2026-03-10", endsOn: "2026-04-09" })).toEqual({
      startsOn: "2026-04-10",
      endsOn: "2026-05-09",
    });
  });

  it("tidak bergeser saat panjang bulan berbeda", () => {
    expect(nextPeriod({ startsOn: "2026-01-10", endsOn: "2026-02-09" })).toEqual({
      startsOn: "2026-02-10",
      endsOn: "2026-03-09",
    });
    expect(nextPeriod({ startsOn: "2026-02-10", endsOn: "2026-03-09" })).toEqual({
      startsOn: "2026-03-10",
      endsOn: "2026-04-09",
    });
  });

  it("mempertahankan rentang satu hari", () => {
    expect(nextPeriod({ startsOn: "2026-03-10", endsOn: "2026-03-10" })).toEqual({
      startsOn: "2026-03-11",
      endsOn: "2026-03-11",
    });
  });

  it("memakai hari terakhir bulan saat periode ditutup di akhir bulan", () => {
    // 1..31 Mar harus berlanjut 1..30 Apr, bukan terpotong jadi 1..30 Apr dari
    // hitungan panjang yang membuat bulan berikutnya bisa melebihi clamp.
    expect(nextPeriod({ startsOn: "2026-03-01", endsOn: "2026-03-31" })).toEqual({
      startsOn: "2026-04-01",
      endsOn: "2026-04-30",
    });
  });

  it("tidak memotong periode yang jatuh di bulan lebih pendek", () => {
    // 1 Jan..31 Jan -> 1 Feb, harus berakhir 28 Feb (tahun bukan kabisat).
    expect(nextPeriod({ startsOn: "2024-01-01", endsOn: "2024-01-31" })).toEqual({
      startsOn: "2024-02-01",
      endsOn: "2024-02-29",
    });
  });

  it("berganti tahun dengan benar", () => {
    expect(nextPeriod({ startsOn: "2026-12-10", endsOn: "2027-01-09" })).toEqual({
      startsOn: "2027-01-10",
      endsOn: "2027-02-09",
    });
  });

  it("null untuk periode tidak valid, bukan date yang diam-diam bergerak", () => {
    expect(nextPeriod({ startsOn: "2026-04-09", endsOn: "2026-03-10" })).toBeNull();
    expect(nextPeriod({ startsOn: "2026-02-31", endsOn: "2026-03-10" })).toBeNull();
    expect(nextPeriod({ startsOn: "salah", endsOn: "2026-03-10" })).toBeNull();
  });

  it("dua periode berturutan tidak pernah saling tumpang tindih", () => {
    const first = nextPeriod({ startsOn: "2026-03-10", endsOn: "2026-04-09" })!;
    expect(first.startsOn).toBe("2026-04-10");
    expect(first.endsOn).toBe("2026-05-09");
    // Periode ketiga masih mulai tepat setelah periode kedua berakhir.
    const second = nextPeriod(first)!;
    expect(second.startsOn).toBe("2026-05-10");
  });

  it("mempertahankan panjang periode pendek, bukan menghasilkan rentang terbalik", () => {
    // Regresi: pola "hari akhir yang sama" tidak muat untuk periode yang lebih
    // pendek dari sebulan dan tidak menutup di akhir bulan. 15..20 Jan dulu
    // dilanjutkan 21 Jan..20 Jan, yang ditolak CHECK `budgets_period_ordered`.
    expect(nextPeriod({ startsOn: "2026-01-15", endsOn: "2026-01-20" })).toEqual({
      startsOn: "2026-01-21",
      endsOn: "2026-01-26",
    });
    expect(nextPeriod({ startsOn: "2026-01-01", endsOn: "2026-01-15" })).toEqual({
      startsOn: "2026-01-16",
      endsOn: "2026-01-30",
    });
    expect(nextPeriod({ startsOn: "2026-05-01", endsOn: "2026-05-07" })).toEqual({
      startsOn: "2026-05-08",
      endsOn: "2026-05-14",
    });
  });

  it("hasilnya selalu periode valid yang mulai tepat setelah periode ini", () => {
    // Invarian yang diandalkan jalur carry-over: apa pun bentuk periodenya,
    // output tidak pernah terbalik dan tidak pernah menyisip hari kosong.
    const periods: BudgetPeriod[] = [
      { startsOn: "2026-01-15", endsOn: "2026-01-20" },
      { startsOn: "2026-01-01", endsOn: "2026-01-15" },
      { startsOn: "2026-05-01", endsOn: "2026-05-07" },
      { startsOn: "2026-01-16", endsOn: "2026-01-20" },
      { startsOn: "2026-01-20", endsOn: "2026-01-31" },
      { startsOn: "2026-01-01", endsOn: "2026-01-31" },
      { startsOn: "2024-01-01", endsOn: "2024-01-31" },
      { startsOn: "2026-03-10", endsOn: "2026-04-09" },
      { startsOn: "2026-12-10", endsOn: "2027-01-09" },
      { startsOn: "2026-01-31", endsOn: "2026-01-31" },
    ];

    for (const period of periods) {
      const next = nextPeriod(period)!;
      const label = `${period.startsOn}..${period.endsOn}`;
      expect(isValidPeriod(next), label).toBe(true);
      // Setiap periode dimulai tepat sehari setelah periode sebelumnya berakhir.
      const expectedStart = new Date(`${period.endsOn}T00:00:00Z`);
      expectedStart.setUTCDate(expectedStart.getUTCDate() + 1);
      expect(next.startsOn, label).toBe(expectedStart.toISOString().slice(0, 10));
    }
  });
});

describe("budgetLeftover", () => {
  it("sisa saat terpakai di bawah batas", () => {
    expect(budgetLeftover(1_000_000, 350_000)).toBe(650_000);
  });

  it("nol saat tepat habis dipakai", () => {
    expect(budgetLeftover(1_000_000, 1_000_000)).toBe(0);
  });

  it("nol saat over, tidak pernah negatif", () => {
    expect(budgetLeftover(1_000_000, 1_400_000)).toBe(0);
  });

  it("membulatkan sisa ke rupiah penuh", () => {
    expect(budgetLeftover(100_000, 33_333)).toBe(66_667);
  });
});

describe("defaultBudgetPeriod", () => {
  it("menghasilkan rentang satu bulan, bukan satu atau dua hari", () => {
    // Regresi: form pernah terisi `besok - besok` karena nextPeriod dipanggil
    // dengan rentang satu hari.
    const period = defaultBudgetPeriod("2026-03-10")!;
    expect(period.startsOn).toBe("2026-03-10");
    expect(period.endsOn).toBe("2026-04-09");
  });

  it("panjangnya tetap satu bulan di bulan terpendek", () => {
    // Februari 2024 punya 29 hari, jadi satu bulan penuh adalah 1 Feb..29 Feb.
    const period = defaultBudgetPeriod("2024-02-01")!;
    expect(period.startsOn).toBe("2024-02-01");
    expect(period.endsOn).toBe("2024-02-29");
  });

  it("tidak meluncur ke bulan berikutnya untuk tanggal 31", () => {
    // 31 Jan + satu bulan akan jadi 3 Mar kalau tidak dijepit.
    expect(defaultBudgetPeriod("2026-01-31")).toEqual({
      startsOn: "2026-01-31",
      endsOn: "2026-02-27",
    });
  });

  it("berganti tahun dengan benar", () => {
    expect(defaultBudgetPeriod("2026-12-15")).toEqual({
      startsOn: "2026-12-15",
      endsOn: "2027-01-14",
    });
  });

  it("hasilnya selalu periode valid", () => {
    for (const day of ["2026-01-31", "2026-03-01", "2024-02-29", "2026-08-31"]) {
      const period = defaultBudgetPeriod(day)!;
      expect(isValidPeriod(period)).toBe(true);
      expect(period.startsOn).toBe(day);
    }
  });

  it("null untuk tanggal rusak, bukan rentang bergerak diam-diam", () => {
    expect(defaultBudgetPeriod("bukan-tanggal")).toBeNull();
    expect(defaultBudgetPeriod("2026-02-31")).toBeNull();
  });
});

describe("paydayLabel", () => {
  it("mengambil bulan dari tanggal mulai, yaitu bulan gaji", () => {
    expect(paydayLabel({ startsOn: "2026-03-10", endsOn: "2026-04-09" }, "id")).toBe("Maret 2026");
    expect(paydayLabel({ startsOn: "2026-03-10", endsOn: "2026-04-09" }, "en")).toBe("March 2026");
  });

  it("bukan bulan saat periode berakhir", () => {
    const period = { startsOn: "2026-03-10", endsOn: "2026-04-09" };
    expect(paydayLabel(period, "id")).not.toContain("April");
  });

  it("lintas tahun tetap memakai tahun gaji", () => {
    expect(paydayLabel({ startsOn: "2026-12-10", endsOn: "2027-01-09" }, "id")).toBe("Desember 2026");
  });

  it("mengembalikan input apa adanya untuk tanggal rusak", () => {
    expect(paydayLabel({ startsOn: "salah", endsOn: "2026-04-09" }, "id")).toBe("salah");
  });
});

describe("periodRange", () => {
  it("menyingkat nama bulan", () => {
    expect(periodRange({ startsOn: "2026-03-10", endsOn: "2026-04-09" }, "id", 2026)).toBe(
      "10 Mar - 9 Apr"
    );
    expect(periodRange({ startsOn: "2026-03-10", endsOn: "2026-04-09" }, "en", 2026)).toBe(
      "10 Mar - 9 Apr"
    );
  });

  it("menampilkan tahun saat periode melintasi tahun", () => {
    expect(periodRange({ startsOn: "2026-12-10", endsOn: "2027-01-09" }, "id", 2026)).toBe(
      "10 Des 2026 - 9 Jan 2027"
    );
  });

  it("menampilkan tahun saat tahun berjalan berbeda", () => {
    expect(periodRange({ startsOn: "2025-03-10", endsOn: "2025-04-09" }, "id", 2026)).toBe(
      "10 Mar 2025 - 9 Apr"
    );
  });

  it("ringkas tanpa tahun saat periode sedang berjalan", () => {
    const text = periodRange({ startsOn: "2026-03-10", endsOn: "2026-04-09" }, "id", 2026);
    expect(text).not.toContain("2026");
  });

  it("tidak error untuk tanggal rusak", () => {
    expect(periodRange({ startsOn: "salah", endsOn: "2026-04-09" }, "id")).toBe(
      "salah - 2026-04-09"
    );
  });
});

describe("findExceededBudget", () => {
  const categoryBudget = {
    id: "budget-food",
    scope: "category" as const,
    scope_id: "cat-food",
    limit_amount: 500_000,
    ...PERIOD,
  };
  const vaultBudget = {
    id: "budget-vault",
    scope: "vault" as const,
    scope_id: "vault-a",
    limit_amount: 300_000,
    ...PERIOD,
  };
  const candidate = {
    amount: 150_000,
    date: "2026-03-20",
    category_id: "cat-food",
    vault_id: "vault-a",
  };

  it("null saat pemakaian masih di bawah batas", () => {
    const rows = [tx({ amount: 100_000, category_id: "cat-food", vault_id: "vault-a" })];
    expect(findExceededBudget(rows, [categoryBudget], candidate)).toBeNull();
  });

  it("nominal tepat sama dengan batas masih boleh", () => {
    const rows = [tx({ amount: 350_000, category_id: "cat-food", vault_id: "vault-a" })];
    expect(findExceededBudget(rows, [categoryBudget], candidate)).toBeNull();
  });

  it("mengembalikan sisa sebelum transaksi dan proyeksi setelahnya", () => {
    const rows = [tx({ amount: 400_000, category_id: "cat-food", vault_id: "vault-a" })];
    const conflict = findExceededBudget(rows, [categoryBudget], candidate);
    expect(conflict?.budget.scope).toBe("category");
    expect(conflict?.spent).toBe(400_000);
    expect(conflict?.remaining).toBe(100_000);
    expect(conflict?.projected).toBe(550_000);
  });

  it("memakai tanggal transaksi, bukan tanggal hari ini", () => {
    const rows = [tx({ amount: 450_000, category_id: "cat-food", date: "2026-04-01" })];
    expect(
      findExceededBudget(rows, [categoryBudget], { ...candidate, date: "2026-04-20" })
    ).toBeNull();
    expect(
      findExceededBudget(rows, [categoryBudget], { ...candidate, date: "2026-04-01" })
    ).not.toBeNull();
  });

  it("mengecualikan transaksi yang sedang diedit", () => {
    const rows = [
      tx({ id: 7, amount: 400_000, category_id: "cat-food", vault_id: "vault-a" }),
      tx({ id: 8, amount: 20_000, category_id: "cat-food", vault_id: "vault-a" }),
    ];
    expect(
      findExceededBudget(rows, [categoryBudget], candidate, 7)
    ).toBeNull();
    expect(findExceededBudget(rows, [categoryBudget], candidate)).not.toBeNull();
  });

  it("mengecualikan kedua leg transfer saat memeriksa edit", () => {
    const rows = [
      tx({
        id: 7,
        type: "transfer",
        amount: 200_000,
        category_id: "cat-food",
        vault_id: "vault-a",
        transfer_direction: "out",
        group_id: "transfer-1",
      }),
      tx({
        id: 8,
        type: "transfer",
        amount: 200_000,
        category_id: "cat-food",
        vault_id: "vault-b",
        transfer_direction: "in",
        group_id: "transfer-1",
      }),
      tx({ amount: 100_000, category_id: "cat-food", vault_id: "vault-a" }),
    ];
    const editedTransfer = { ...candidate, type: "transfer" as const, amount: 400_000 };
    expect(
      findExceededBudget(rows, [categoryBudget], editedTransfer, undefined, undefined, "transfer-1")
    ).toBeNull();
    expect(findExceededBudget(rows, [categoryBudget], editedTransfer)?.spent).toBe(300_000);
  });

  it("menolak transfer berkategori yang melampaui sisa anggaran", () => {
    const rows = [tx({ amount: 400_000, category_id: "cat-food" })];
    const transfer = { ...candidate, type: "transfer" as const, amount: 100_001 };
    const conflict = findExceededBudget(rows, [categoryBudget], transfer);
    expect(conflict?.remaining).toBe(100_000);
    expect(conflict?.projected).toBe(500_001);
  });

  it("memeriksa scope vault walaupun kategori tidak cocok", () => {
    const rows = [tx({ amount: 200_000, category_id: "cat-other", vault_id: "vault-a" })];
    const conflict = findExceededBudget(
      rows,
      [vaultBudget],
      { ...candidate, category_id: "cat-other" }
    );
    expect(conflict?.budget.scope).toBe("vault");
    expect(conflict?.remaining).toBe(100_000);
  });

  it("memilih pelanggaran dengan kelebihan terbesar", () => {
    const rows = [tx({ amount: 450_000, category_id: "cat-food", vault_id: "vault-a" })];
    const conflict = findExceededBudget(rows, [vaultBudget, categoryBudget], candidate);
    expect(conflict?.budget.id).toBe("budget-vault");
  });

  it("null untuk scope atau nominal yang tidak valid", () => {
    expect(
      findExceededBudget([], [categoryBudget], { ...candidate, category_id: "cat-other" })
    ).toBeNull();
    expect(findExceededBudget([], [categoryBudget], { ...candidate, amount: NaN })).toBeNull();
    expect(findExceededBudget([], [categoryBudget], { ...candidate, amount: 0 })).toBeNull();
  });

  it("anggaran sisa ditutup menolak pengeluaran yang masih muat di batas asli", () => {
    const rows = [tx({ amount: 200_000, category_id: "cat-food", vault_id: "vault-a" })];
    const closed = { ...categoryBudget, leftover_discarded: true };
    // Dengan sisa 300.000 masih terbuka, nominal ini sah.
    expect(findExceededBudget(rows, [categoryBudget], { ...candidate, amount: 300_000 })).toBeNull();
    const conflict = findExceededBudget(rows, [closed], { ...candidate, amount: 300_000 });
    expect(conflict?.spent).toBe(200_000);
    expect(conflict?.remaining).toBe(0);
    expect(conflict?.projected).toBe(500_000);
  });

  it("anggaran sisa ditutup yang belum terpakai menolak semua nominal", () => {
    const closed = { ...categoryBudget, leftover_discarded: true };
    const conflict = findExceededBudget([], [closed], candidate);
    expect(conflict?.spent).toBe(0);
    expect(conflict?.remaining).toBe(0);
    expect(conflict?.projected).toBe(150_000);
  });

  it("anggaran sisa dibuka kembali berlaku seperti biasa", () => {
    const rows = [tx({ amount: 200_000, category_id: "cat-food", vault_id: "vault-a" })];
    const reopened = { ...categoryBudget, leftover_discarded: false };
    expect(findExceededBudget(rows, [reopened], { ...candidate, amount: 300_000 })).toBeNull();
  });
});

describe("budgetState", () => {
  it("upcoming saat hari ini sebelum mulai", () => {
    expect(budgetState(PERIOD, "2026-03-09")).toBe("upcoming");
  });

  it("active pada hari pertama dan hari terakhir", () => {
    expect(budgetState(PERIOD, "2026-03-10")).toBe("active");
    expect(budgetState(PERIOD, "2026-04-09")).toBe("active");
  });

  it("ended setelah periode lewat", () => {
    expect(budgetState(PERIOD, "2026-04-10")).toBe("ended");
  });
});

describe("aggregateBorrows", () => {
  it("menjumlah pinjaman keluar pada pemberi dan masuk pada peminjam", () => {
    const totals = aggregateBorrows([
      { from_budget_id: "budget-a", to_budget_id: "budget-b", amount: 60_000 },
    ]);
    expect(totals.get("budget-a")).toEqual({ borrowedIn: 0, borrowedOut: 60_000 });
    expect(totals.get("budget-b")).toEqual({ borrowedIn: 60_000, borrowedOut: 0 });
  });

  it("menumpuk beberapa pinjaman pada baris yang sama", () => {
    const totals = aggregateBorrows([
      { from_budget_id: "budget-a", to_budget_id: "budget-b", amount: 60_000 },
      { from_budget_id: "budget-c", to_budget_id: "budget-b", amount: 40_000 },
      { from_budget_id: "budget-a", to_budget_id: "budget-c", amount: 10_000 },
    ]);
    expect(totals.get("budget-a")).toEqual({ borrowedIn: 0, borrowedOut: 70_000 });
    expect(totals.get("budget-b")).toEqual({ borrowedIn: 100_000, borrowedOut: 0 });
    expect(totals.get("budget-c")).toEqual({ borrowedIn: 10_000, borrowedOut: 40_000 });
  });

  it("kosong saat belum ada pinjaman", () => {
    expect(aggregateBorrows([]).size).toBe(0);
  });
});

describe("budgetEffectiveLimit dengan pinjaman", () => {
  it("menaikkan batas peminjam sebesar yang dipinjam", () => {
    expect(
      budgetEffectiveLimit({ limit_amount: 500_000 }, 400_000, {
        borrowedIn: 150_000,
        borrowedOut: 0,
      })
    ).toBe(650_000);
  });

  it("menurunkan batas pemberi sebesar yang dipinjamkan", () => {
    expect(
      budgetEffectiveLimit({ limit_amount: 500_000 }, 100_000, {
        borrowedIn: 0,
        borrowedOut: 350_000,
      })
    ).toBe(150_000);
  });

  it("tidak pernah turun di bawah nol walau pinjaman melebihi batas", () => {
    expect(
      budgetEffectiveLimit({ limit_amount: 100_000 }, 0, {
        borrowedIn: 0,
        borrowedOut: 250_000,
      })
    ).toBe(0);
  });

  it("sisa ditutup tetap mengunci pada angka terpakai walau ada pinjaman masuk", () => {
    expect(
      budgetEffectiveLimit(
        { limit_amount: 500_000, leftover_discarded: true },
        300_000,
        { borrowedIn: 200_000, borrowedOut: 0 }
      )
    ).toBe(300_000);
  });
});

describe("alokasi ulang sisa anggaran", () => {
  const source = {
    id: "budget-source",
    scope: "category" as const,
    scope_id: "cat-source",
    limit_amount: 500_000,
    ...PERIOD,
  };
  const destination = {
    id: "budget-destination",
    scope: "category" as const,
    scope_id: "cat-destination",
    limit_amount: 300_000,
    ...PERIOD,
  };

  it("mengurangi batas sumber dan menambah batas tujuan, tetapi tidak diwariskan ke baris periode baru", () => {
    const totals = aggregateReallocations([
      {
        from_budget_id: source.id,
        to_budget_id: destination.id,
        amount: 200_000,
        reversed_at: null,
      },
      {
        from_budget_id: source.id,
        to_budget_id: destination.id,
        amount: 50_000,
        reversed_at: "2026-03-20T00:00:00Z",
      },
    ]);

    expect(budgetEffectiveLimit(source, 100_000, undefined, totals.get(source.id))).toBe(300_000);
    expect(
      budgetEffectiveLimit(destination, 100_000, undefined, totals.get(destination.id))
    ).toBe(500_000);
    expect(
      budgetEffectiveLimit(
        destination,
        0,
        undefined,
        totals.get("budget-destination-next-period")
      )
    ).toBe(300_000);
  });

  it("menolak pemakaian sumber setelah sisa dialihkan dan mengizinkan pemakaian tujuan", () => {
    const totals = aggregateReallocations([
      {
        from_budget_id: source.id,
        to_budget_id: destination.id,
        amount: 200_000,
        reversed_at: null,
      },
    ]);
    const history = [
      tx({ amount: 300_000, category_id: source.scope_id }),
      tx({ amount: 250_000, category_id: destination.scope_id }),
    ];

    expect(
      findExceededBudget(
        history,
        [source],
        {
          amount: 1,
          date: "2026-03-20",
          category_id: source.scope_id,
          vault_id: null,
        },
        undefined,
        undefined,
        undefined,
        totals
      )?.remaining
    ).toBe(0);
    expect(
      findExceededBudget(
        history,
        [destination],
        {
          amount: 150_000,
          date: "2026-03-20",
          category_id: destination.scope_id,
          vault_id: null,
        },
        undefined,
        undefined,
        undefined,
        totals
      )
    ).toBeNull();
  });
});

describe("budgetDisplayStatus dengan pinjaman", () => {
  const budget = { limit_amount: 500_000, alert_threshold: 0.8 };

  it("pemberi yang sudah meminjamkan sebagian sisanya ikut diperhitungkan", () => {
    expect(budgetDisplayStatus(budget, 400_000)).toBe("warning");
    expect(
      budgetDisplayStatus(budget, 400_000, { borrowedIn: 0, borrowedOut: 100_000 })
    ).toBe("full");
  });

  it("peminjam kembali aman setelah pinjaman menambah batasnya", () => {
    expect(budgetDisplayStatus(budget, 500_000)).toBe("full");
    expect(
      budgetDisplayStatus(budget, 500_000, { borrowedIn: 150_000, borrowedOut: 0 })
    ).toBe("ok");
  });
});

describe("findExceededBudget dengan pinjaman", () => {
  const categoryBudget = {
    id: "budget-food",
    scope: "category" as const,
    scope_id: "cat-food",
    limit_amount: 500_000,
    ...PERIOD,
  };
  const candidate = {
    amount: 150_000,
    date: "2026-03-20",
    category_id: "cat-food",
    vault_id: "vault-a",
  };

  it("ruang pinjaman masuk membuat nominal yang tadinya ditolak jadi muat", () => {
    const rows = [tx({ amount: 400_000, category_id: "cat-food", vault_id: "vault-a" })];
    // Tanpa pinjaman: 400k + 150k melewati batas 500k.
    expect(findExceededBudget(rows, [categoryBudget], candidate)).not.toBeNull();
    const borrows = aggregateBorrows([
      { from_budget_id: "budget-other", to_budget_id: "budget-food", amount: 100_000 },
    ]);
    expect(
      findExceededBudget(rows, [categoryBudget], candidate, undefined, borrows)
    ).toBeNull();
  });

  it("pemberi yang sudah meminjamkan sebagian sisanya menolak lebih awal", () => {
    const rows = [tx({ amount: 100_000, category_id: "cat-food", vault_id: "vault-a" })];
    // Tanpa pinjaman: 100k + 150k masih muat di 500k.
    expect(findExceededBudget(rows, [categoryBudget], candidate)).toBeNull();
    const borrows = aggregateBorrows([
      { from_budget_id: "budget-food", to_budget_id: "budget-other", amount: 350_000 },
    ]);
    const conflict = findExceededBudget(
      rows,
      [categoryBudget],
      candidate,
      undefined,
      borrows
    );
    expect(conflict?.effectiveLimit).toBe(150_000);
    expect(conflict?.remaining).toBe(50_000);
    expect(conflict?.projected).toBe(250_000);
  });
});

describe("eligibleBorrowLenders", () => {
  const borrower = {
    id: "budget-food",
    scope: "category" as const,
    scope_id: "cat-food",
    limit_amount: 500_000,
    ...PERIOD,
  };
  const lender = {
    id: "budget-transport",
    scope: "category" as const,
    scope_id: "cat-transport",
    limit_amount: 400_000,
    ...PERIOD,
  };
  const vaultLender = {
    id: "budget-vault",
    scope: "vault" as const,
    scope_id: "vault-a",
    limit_amount: 300_000,
    ...PERIOD,
  };

  it("menawarkan sesama kategori yang sisa efektifnya masih positif", () => {
    const rows = [tx({ amount: 350_000, category_id: "cat-transport", vault_id: "vault-a" })];
    const candidates = eligibleBorrowLenders(
      borrower,
      [borrower, lender, vaultLender],
      rows,
      [],
      "2026-03-20"
    );
    expect(candidates).toHaveLength(1);
    expect(candidates[0].budget.id).toBe("budget-transport");
    expect(candidates[0].remaining).toBe(50_000);
  });

  it("mengeluarkan diri sendiri dan periodenya tidak mencakup", () => {
    const outside = {
      ...lender,
      id: "budget-later",
      scope_id: "cat-later",
      starts_on: "2026-04-10",
      ends_on: "2026-05-09",
    };
    const candidates = eligibleBorrowLenders(
      borrower,
      [borrower, outside],
      [],
      [],
      "2026-03-20"
    );
    expect(candidates).toHaveLength(0);
  });

  it("menawarkan lintas scope: kategori boleh dipinjam dari vault", () => {
    const candidates = eligibleBorrowLenders(
      borrower,
      [vaultLender],
      [],
      [],
      "2026-03-20"
    );
    expect(candidates).toHaveLength(1);
    expect(candidates[0].budget.id).toBe("budget-vault");
    expect(candidates[0].remaining).toBe(300_000);
  });

  it("sisa yang sudah ditutup tidak ditawarkan", () => {
    const closed = { ...lender, leftover_discarded: true };
    expect(
      eligibleBorrowLenders(borrower, [closed], [], [], "2026-03-20")
    ).toHaveLength(0);
    expect(
      eligibleBorrowLenders(
        { ...borrower, leftover_discarded: true },
        [lender],
        [],
        [],
        "2026-03-20"
      )
    ).toHaveLength(0);
  });

  it("kapasitas pemberi menyusut oleh pinjaman yang sedang berjalan", () => {
    const borrows = [
      { from_budget_id: "budget-transport", to_budget_id: "budget-food", amount: 150_000 },
    ];
    const candidates = eligibleBorrowLenders(
      borrower,
      [borrower, lender],
      [],
      borrows,
      "2026-03-20"
    );
    expect(candidates).toHaveLength(1);
    expect(candidates[0].remaining).toBe(250_000);
  });

  it("pemberi yang sudah habis sisanya tidak lagi ditawarkan", () => {
    const borrows = [
      { from_budget_id: "budget-transport", to_budget_id: "budget-food", amount: 400_000 },
    ];
    expect(
      eligibleBorrowLenders(borrower, [lender], [], borrows, "2026-03-20")
    ).toHaveLength(0);
  });
});

describe("requiredBorrowTotal", () => {
  const budget = { limit_amount: 100_000 };

  it("nol saat edit mengecilkan supaya kembali muat tanpa pinjaman berlebih", () => {
    expect(
      requiredBorrowTotal(budget, 90_000, { borrowedIn: 20_000, borrowedOut: 0 }, 20_000)
    ).toBe(0);
  });

  it("menyisakan pinjaman sebesar kelebihan yang masih tersisa", () => {
    expect(
      requiredBorrowTotal(budget, 115_000, { borrowedIn: 20_000, borrowedOut: 0 }, 20_000)
    ).toBe(15_000);
  });

  it("memperhitungkan pinjaman keluar dari anggaran peminjam sendiri", () => {
    expect(
      requiredBorrowTotal(budget, 60_000, { borrowedIn: 10_000, borrowedOut: 50_000 }, 10_000)
    ).toBe(10_000);
  });

  it("sisa ditutup: kebutuhan tetap tidak melebihi baris yang terkait", () => {
    expect(
      requiredBorrowTotal(
        { ...budget, leftover_discarded: true },
        80_000,
        { borrowedIn: 20_000, borrowedOut: 0 },
        20_000
      )
    ).toBe(20_000);
  });

  it("nol saat spent masih di bawah batas efektif tanpa baris terkait", () => {
    expect(requiredBorrowTotal(budget, 60_000, undefined, 0)).toBe(0);
  });

  it("tidak pernah negatif walau batas efektif melampaui spent", () => {
    expect(
      requiredBorrowTotal(budget, 10_000, { borrowedIn: 50_000, borrowedOut: 0 }, 50_000)
    ).toBe(0);
  });
});

describe("planBorrowShrink", () => {
  function row(id: string, toBudgetId: string, amount: number) {
    return { id, from_budget_id: "budget-transport", to_budget_id: toBudgetId, amount };
  }

  it("tanpa kelebihan tidak merencanakan apa pun", () => {
    const rows = [row("b1", "budget-food", 10_000)];
    expect(planBorrowShrink(rows, new Map([["budget-food", 10_000]]))).toEqual({
      deleteIds: [],
      updates: [],
    });
    expect(planBorrowShrink(rows, new Map([["budget-food", 20_000]]))).toEqual({
      deleteIds: [],
      updates: [],
    });
  });

  it("menghapus baris terkecil lebih dulu sampai hasilnya pas", () => {
    const rows = [row("b1", "budget-food", 10_000), row("b2", "budget-food", 90_000)];
    expect(planBorrowShrink(rows, new Map([["budget-food", 50_000]]))).toEqual({
      deleteIds: ["b1"],
      updates: [{ id: "b2", amount: 50_000 }],
    });
  });

  it("kebutuhan nol menghapus seluruh baris anggaran itu", () => {
    const rows = [row("b1", "budget-food", 10_000), row("b2", "budget-food", 90_000)];
    expect(planBorrowShrink(rows, new Map([["budget-food", 0]]))).toEqual({
      deleteIds: ["b1", "b2"],
      updates: [],
    });
  });

  it("memotong sebagian baris penyerap saat kelebihan lebih kecil dari satu baris", () => {
    const rows = [row("b1", "budget-food", 30_000)];
    expect(planBorrowShrink(rows, new Map([["budget-food", 10_000]]))).toEqual({
      deleteIds: [],
      updates: [{ id: "b1", amount: 10_000 }],
    });
  });

  it("menangani dua anggaran peminjam secara terpisah", () => {
    const rows = [
      row("b1", "budget-food", 10_000),
      row("b2", "budget-food", 20_000),
      row("b3", "budget-vault", 40_000),
    ];
    const needs = new Map([
      ["budget-food", 15_000],
      ["budget-vault", 0],
    ]);
    expect(planBorrowShrink(rows, needs)).toEqual({
      deleteIds: ["b1", "b3"],
      updates: [{ id: "b2", amount: 15_000 }],
    });
  });

  it("kebutuhan yang tidak ada diperlakukan sebagai nol", () => {
    const rows = [row("b1", "budget-food", 10_000)];
    expect(planBorrowShrink(rows, new Map())).toEqual({
      deleteIds: ["b1"],
      updates: [],
    });
  });
});

describe("activePeriodRange", () => {
  it("null saat tidak ada anggaran", () => {
    expect(activePeriodRange([], "2026-03-15")).toBeNull();
  });

  it("null saat semua anggaran bukan aktif", () => {
    const budgets = [
      { starts_on: "2026-03-01", ends_on: "2026-03-09" },
      { starts_on: "2026-04-01", ends_on: "2026-04-30" },
    ];
    expect(activePeriodRange(budgets, "2026-03-15")).toBeNull();
  });

  it("mengambil rentang satu anggaran aktif", () => {
    const budgets = [
      { starts_on: "2026-03-10", ends_on: "2026-04-09" },
      { starts_on: "2026-04-10", ends_on: "2026-05-09" },
    ];
    expect(activePeriodRange(budgets, "2026-03-15")).toEqual({
      startsOn: "2026-03-10",
      endsOn: "2026-04-09",
    });
  });

  it("memperluas cakupan saat beberapa anggaran aktif dengan rentang berbeda", () => {
    // Siklus gaji tidak seragam: satu kategori 10..9, satu lagi 1..31.
    const budgets = [
      { starts_on: "2026-03-10", ends_on: "2026-04-09" },
      { starts_on: "2026-03-01", ends_on: "2026-03-31" },
      { starts_on: "2026-05-01", ends_on: "2026-05-31" },
    ];
    expect(activePeriodRange(budgets, "2026-03-15")).toEqual({
      startsOn: "2026-03-01",
      endsOn: "2026-04-09",
    });
  });
});

describe("unlimitedCategorySpends", () => {
  const PERIOD_RANGE: BudgetPeriod = { startsOn: "2026-03-10", endsOn: "2026-04-09" };

  it("menghitung kategori tanpa anggaran aktif", () => {
    const rows = [
      tx({ amount: 120_000, category_id: "cat-skincare" }),
      tx({ amount: 30_000, category_id: "cat-skincare" }),
    ];
    expect(
      unlimitedCategorySpends(rows, ["cat-skincare"], [], PERIOD_RANGE)
    ).toEqual([{ categoryId: "cat-skincare", spent: 150_000 }]);
  });

  it("mengeluarkan kategori yang punya anggaran aktif", () => {
    const rows = [tx({ amount: 90_000, category_id: "cat-food" })];
    expect(
      unlimitedCategorySpends(
        rows,
        ["cat-food"],
        [{ scope: "category", scope_id: "cat-food" }],
        PERIOD_RANGE
      )
    ).toEqual([]);
  });

  it("anggaran scope vault tidak mengecualikan kategori", () => {
    const rows = [tx({ amount: 90_000, category_id: "cat-food" })];
    expect(
      unlimitedCategorySpends(
        rows,
        ["cat-food"],
        [{ scope: "vault", scope_id: "vault-a" }],
        PERIOD_RANGE
      )
    ).toEqual([{ categoryId: "cat-food", spent: 90_000 }]);
  });

  it("menggugurkan kategori yang tidak bertransaksi pada periode", () => {
    const rows = [
      tx({ amount: 50_000, category_id: "cat-old", date: "2026-03-09" }),
      tx({ amount: 40_000, category_id: "cat-future", date: "2026-04-10" }),
    ];
    expect(
      unlimitedCategorySpends(rows, ["cat-old", "cat-future"], [], PERIOD_RANGE)
    ).toEqual([]);
  });

  it("menghitung transfer ber-kategori lewat leg keluar saja", () => {
    const rows = [
      tx({ type: "transfer", amount: 70_000, category_id: "cat-move", transfer_direction: "out" }),
      tx({ type: "transfer", amount: 70_000, category_id: "cat-move", transfer_direction: "in" }),
    ];
    expect(
      unlimitedCategorySpends(rows, ["cat-move"], [], PERIOD_RANGE)
    ).toEqual([{ categoryId: "cat-move", spent: 70_000 }]);
  });

  it("mengabaikan kategori yang tidak ada di daftar terlihat", () => {
    const rows = [tx({ amount: 60_000, category_id: "cat-hidden" })];
    expect(unlimitedCategorySpends(rows, [], [], PERIOD_RANGE)).toEqual([]);
  });

  it("mengurutkan pemakaian menurun", () => {
    const rows = [
      tx({ amount: 10_000, category_id: "cat-small" }),
      tx({ amount: 500_000, category_id: "cat-big" }),
      tx({ amount: 100_000, category_id: "cat-mid" }),
    ];
    expect(
      unlimitedCategorySpends(rows, ["cat-small", "cat-big", "cat-mid"], [], PERIOD_RANGE).map(
        (row) => row.categoryId
      )
    ).toEqual(["cat-big", "cat-mid", "cat-small"]);
  });
});

describe("budgetTransactions", () => {
  const budget = { scope: "category" as const, scope_id: "cat-food", ...PERIOD };

  it("parity dengan budgetSpend: jumlahnya sama dengan yang dijumlah", () => {
    const rows = [
      tx({ amount: 100_000, category_id: "cat-food" }),
      tx({ amount: 50_000, category_id: "cat-food" }),
      tx({ amount: 999_000, category_id: "cat-other" }),
      tx({ type: "income", amount: 700_000, category_id: "cat-food" }),
      tx({ type: "transfer", amount: 40_000, category_id: "cat-food", transfer_direction: "out" }),
      tx({ type: "transfer", amount: 40_000, category_id: "cat-food", transfer_direction: "in" }),
      tx({ amount: 30_000, category_id: "cat-food", date: "2026-03-09" }),
    ];
    const selected = budgetTransactions(rows, budget);
    expect(selected.reduce((sum, row) => sum + row.amount, 0)).toBe(budgetSpend(rows, budget));
    // 2 expense + 1 leg keluar; income, leg masuk, dan tanggal di luar gugur.
    expect(selected).toHaveLength(3);
  });

  it("mempertahankan urutan baris seperti input", () => {
    const rows = [
      tx({ amount: 30_000, category_id: "cat-food", date: "2026-03-20" }),
      tx({ amount: 10_000, category_id: "cat-food", date: "2026-03-12" }),
      tx({ amount: 20_000, category_id: "cat-food", date: "2026-03-15" }),
    ];
    expect(budgetTransactions(rows, budget).map((row) => row.amount)).toEqual([
      30_000, 10_000, 20_000,
    ]);
  });

  it("scope vault hanya memilih expense vault yang sama", () => {
    const vaultBudget = { scope: "vault" as const, scope_id: "vault-a", ...PERIOD };
    const rows = [
      tx({ amount: 25_000, vault_id: "vault-a" }),
      tx({ amount: 99_000, vault_id: "vault-b" }),
      tx({ type: "transfer", amount: 60_000, vault_id: "vault-a", transfer_direction: "out" }),
    ];
    expect(budgetTransactions(rows, vaultBudget).map((row) => row.amount)).toEqual([25_000]);
  });

  it("baris terpilih membawa id aslinya untuk daftar transaksi", () => {
    const rows = [tx({ id: 42, amount: 15_000, category_id: "cat-food" })];
    expect(budgetTransactions(rows, budget).map((row) => row.id)).toEqual([42]);
  });
});

describe("findPreviousPeriodBudget", () => {
  const current = {
    id: "b-current",
    scope: "category" as const,
    scope_id: "cat-food",
    starts_on: "2026-03-10",
    ends_on: "2026-04-09",
  };

  it("null saat belum ada periode sebelumnya", () => {
    expect(findPreviousPeriodBudget([current], current)).toBeNull();
  });

  it("memilih periode berbagi scope yang berakhir tepat sebelum mulai", () => {
    const previous = {
      id: "b-prev",
      scope: "category" as const,
      scope_id: "cat-food",
      starts_on: "2026-02-10",
      ends_on: "2026-03-09",
    };
    expect(findPreviousPeriodBudget([previous, current], current)).toBe(previous);
  });

  it("mengabaikan scope lain dan periode yang masih tumpang tindih", () => {
    const otherScope = {
      id: "b-vault",
      scope: "vault" as const,
      scope_id: "vault-a",
      starts_on: "2026-02-10",
      ends_on: "2026-03-09",
    };
    const otherCategory = {
      id: "b-other",
      scope: "category" as const,
      scope_id: "cat-fun",
      starts_on: "2026-02-10",
      ends_on: "2026-03-09",
    };
    const overlapping = {
      id: "b-overlap",
      scope: "category" as const,
      scope_id: "cat-food",
      starts_on: "2026-03-01",
      ends_on: "2026-04-30",
    };
    expect(
      findPreviousPeriodBudget([otherScope, otherCategory, overlapping, current], current)
    ).toBeNull();
  });

  it("memilih kandidat terdekat saat ada beberapa periode sebelumnya", () => {
    const older = {
      id: "b-older",
      scope: "category" as const,
      scope_id: "cat-food",
      starts_on: "2026-01-10",
      ends_on: "2026-02-09",
    };
    const nearer = {
      id: "b-nearer",
      scope: "category" as const,
      scope_id: "cat-food",
      starts_on: "2026-02-10",
      ends_on: "2026-03-09",
    };
    expect(findPreviousPeriodBudget([older, nearer, current], current)).toBe(nearer);
  });
});

describe("budgetsOverlappingPeriod", () => {
  const PERIOD_RANGE: BudgetPeriod = { startsOn: "2026-03-10", endsOn: "2026-04-09" };

  it("mempertahankan anggaran kategori yang tumpang tindih periode", () => {
    const inside = {
      scope: "category" as const,
      starts_on: "2026-03-01",
      ends_on: "2026-03-31",
    };
    // Anggaran panjang (mis. tahunan) yang membentang melintasi periode.
    const spanning = {
      scope: "category" as const,
      starts_on: "2025-01-01",
      ends_on: "2026-12-31",
    };
    // Tepi bersinggungan: ends_on == startsOn dan starts_on == endsOn tetap
    // dihitung tumpang tindih (batas inklusif).
    const touchingStart = {
      scope: "category" as const,
      starts_on: "2026-01-01",
      ends_on: "2026-03-10",
    };
    const touchingEnd = {
      scope: "category" as const,
      starts_on: "2026-04-09",
      ends_on: "2026-06-30",
    };
    expect(
      budgetsOverlappingPeriod([inside, spanning, touchingStart, touchingEnd], PERIOD_RANGE)
    ).toEqual([inside, spanning, touchingStart, touchingEnd]);
  });

  it("membuang anggaran yang berada sepenuhnya di luar periode", () => {
    const before = {
      scope: "category" as const,
      starts_on: "2026-01-01",
      ends_on: "2026-03-09",
    };
    const after = {
      scope: "category" as const,
      starts_on: "2026-04-10",
      ends_on: "2026-06-30",
    };
    expect(budgetsOverlappingPeriod([before, after], PERIOD_RANGE)).toEqual([]);
  });

  it("membuang anggaran scope vault walau tanggalnya tumpang tindih", () => {
    const vault = {
      scope: "vault" as const,
      starts_on: "2026-03-01",
      ends_on: "2026-03-31",
    };
    expect(budgetsOverlappingPeriod([vault], PERIOD_RANGE)).toEqual([]);
  });
});
