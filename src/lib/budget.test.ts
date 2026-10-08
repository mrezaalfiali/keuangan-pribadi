import { describe, expect, it } from "vitest";
import {
  budgetLeftover,
  budgetRatio,
  budgetSpend,
  budgetState,
  budgetStatus,
  defaultBudgetPeriod,
  isValidPeriod,
  nextPeriod,
  paydayLabel,
  periodRange,
  type BudgetPeriod,
  type BudgetStatus,
} from "@/src/lib/budget";
import type { Transaction } from "@/src/lib/types";

// Periode mengikuti gaji: 10 Mar..9 Apr.
const PERIOD = { starts_on: "2026-03-10", ends_on: "2026-04-09" };

type TxSlice = Pick<Transaction, "type" | "amount" | "category_id" | "vault_id" | "date">;

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

  it("mengabaikan income dan transfer", () => {
    const rows = [
      tx({ type: "income", amount: 500_000, category_id: "cat-food", vault_id: "vault-a" }),
      tx({ type: "transfer", amount: 300_000, category_id: null, vault_id: "vault-a" }),
      tx({ amount: 20_000, category_id: "cat-food", vault_id: "vault-a" }),
    ];
    expect(budgetSpend(rows, { scope: "category", scope_id: "cat-food", ...PERIOD })).toBe(20_000);
    expect(budgetSpend(rows, { scope: "vault", scope_id: "vault-a", ...PERIOD })).toBe(20_000);
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
