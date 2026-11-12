import { describe, expect, it } from "vitest";
import {
  computeVaultShortfall,
  eligibleVaultLenders,
  pickRepaySource,
  vaultBalance,
  vaultShortfall,
} from "@/src/lib/vault-borrow";
import type { PairTransaction } from "@/src/lib/sources";

const DARAT = "vault-darat";
const TABUNGAN = "vault-tabungan";
const AMBIL = "vault-ambil";
const GAJI = "src-gaji";
const MAGANG = "src-magang";

function vault(id: string, over: { is_locked?: boolean } = {}) {
  return {
    id,
    slug: id,
    name: id,
    name_key: null,
    is_locked: over.is_locked ?? false,
  };
}

function income(amount: number, sourceId: string, vaultId: string): PairTransaction {
  return { type: "income", amount, category_id: sourceId, vault_id: vaultId };
}

function expense(amount: number, sourceId: string, vaultId: string): PairTransaction {
  return { type: "expense", amount, category_id: null, funding_source_id: sourceId, vault_id: vaultId };
}

function transferOut(amount: number, sourceId: string, vaultId: string): PairTransaction {
  return { type: "transfer", amount, funding_source_id: sourceId, vault_id: vaultId, transfer_direction: "out" };
}

function transferIn(amount: number, sourceId: string, vaultId: string): PairTransaction {
  return { type: "transfer", amount, funding_source_id: sourceId, vault_id: vaultId, transfer_direction: "in" };
}

describe("vaultBalance", () => {
  it("menjumlah income dan transfer masuk, mengurangi expense dan transfer keluar", () => {
    const rows = [
      income(1_000_000, GAJI, DARAT),
      expense(300_000, GAJI, DARAT),
      transferIn(200_000, GAJI, DARAT),
      transferOut(100_000, GAJI, DARAT),
    ];
    expect(vaultBalance(DARAT, rows)).toBe(800_000);
  });

  it("hanya menghitung baris milik vault yang ditanya", () => {
    const rows = [income(500_000, GAJI, TABUNGAN)];
    expect(vaultBalance(DARAT, rows)).toBe(0);
    expect(vaultBalance(TABUNGAN, rows)).toBe(500_000);
  });
});

describe("vaultShortfall", () => {
  it("dibatasi saldo vault bila kolamnya lebih besar", () => {
    expect(vaultShortfall({ amount: 500_000, balance: 300_000, pool: 900_000 })).toBe(200_000);
  });

  it("dibatasi kolam sumber bila saldonya lebih besar", () => {
    expect(vaultShortfall({ amount: 500_000, balance: 900_000, pool: 400_000 })).toBe(100_000);
  });

  it("nol ketika keduanya mencukupi", () => {
    expect(vaultShortfall({ amount: 500_000, balance: 500_000, pool: 500_000 })).toBe(0);
    expect(vaultShortfall({ amount: 500_000, balance: 1_000_000, pool: 1_000_000 })).toBe(0);
  });

  it("menghitung kekurangan terhadap batas gabungan, bukan jumlah keduanya", () => {
    // saldo 400 + kolam 400 bukan 800: uang yang benar-benar tersedia
    // hanya yang masuk di kedua sisi sekaligus.
    expect(vaultShortfall({ amount: 700_000, balance: 400_000, pool: 400_000 })).toBe(300_000);
  });
});

describe("computeVaultShortfall", () => {
  const rows = [
    income(600_000, GAJI, DARAT),
    income(400_000, MAGANG, DARAT),
    expense(200_000, GAJI, DARAT),
  ];

  it("menggabungkan saldo vault dan kolam sumber dari ledger", () => {
    // saldo 800, kolam gaji 400 -> expense 500 kurang 100.
    expect(
      computeVaultShortfall(rows, { vaultId: DARAT, sourceId: GAJI, amount: 500_000 })
    ).toBe(100_000);
  });

  it("tanpa sumber dana dianggap nol -- penolakannya bukan soal dana", () => {
    expect(computeVaultShortfall(rows, { vaultId: DARAT, sourceId: null, amount: 500_000 })).toBe(0);
  });

  it("nol ketika tidak ada kekurangan", () => {
    expect(
      computeVaultShortfall(rows, { vaultId: DARAT, sourceId: GAJI, amount: 300_000 })
    ).toBe(0);
  });
});

describe("eligibleVaultLenders", () => {
  const ledger = [
    income(1_000_000, GAJI, TABUNGAN),
    income(500_000, GAJI, AMBIL),
    income(700_000, MAGANG, AMBIL),
    // Uang magang di "ambil" bukan milik sumber gaji: kolam gaji di sana nol.
    transferOut(200_000, GAJI, TABUNGAN),
    transferIn(200_000, GAJI, DARAT),
  ];
  const vaults = [vault(DARAT), vault(TABUNGAN), vault(AMBIL), vault("vault-kunci", { is_locked: true })];

  it("mengeluarkan vault peminjam, vault terkunci, dan vault tanpa kapasitas", () => {
    const locked = income(300_000, GAJI, "vault-kunci");
    const candidates = eligibleVaultLenders({
      borrowerVaultId: DARAT,
      sourceId: GAJI,
      vaults: [...vaults, vault("vault-kosong")],
      transactions: [...ledger, locked],
    });
    expect(candidates.map((row) => row.vault.id)).toEqual([TABUNGAN, AMBIL]);
  });

  it("kapasitasnya min(saldo, kolam sumber) di vault itu", () => {
    const candidates = eligibleVaultLenders({
      borrowerVaultId: DARAT,
      sourceId: GAJI,
      vaults,
      transactions: ledger,
    });
    const tabungan = candidates.find((row) => row.vault.id === TABUNGAN);
    const ambil = candidates.find((row) => row.vault.id === AMBIL);
    // Tabungan: saldo 800, kolam gaji 800.
    expect(tabungan?.capacity).toBe(800_000);
    // Ambil: saldo 1.200 tapi kolam gaji hanya 500.
    expect(ambil?.capacity).toBe(500_000);
  });

  it("tanpa sumber dana tidak menawarkan siapa pun", () => {
    expect(
      eligibleVaultLenders({ borrowerVaultId: DARAT, sourceId: null, vaults, transactions: ledger })
    ).toEqual([]);
  });

  it("mempertahankan urutan vault yang diberikan", () => {
    const candidates = eligibleVaultLenders({
      borrowerVaultId: DARAT,
      sourceId: GAJI,
      vaults: [vault(AMBIL), vault(TABUNGAN)],
      transactions: ledger,
    });
    expect(candidates.map((row) => row.vault.id)).toEqual([AMBIL, TABUNGAN]);
  });
});

describe("pickRepaySource", () => {
  const ledger = [
    // Pinjaman 500 masuk ke Darat dari sumber gaji, lalu 300 sudah dibelanjakan:
    // kolam gaji di Darat tinggal 200, saldo Darat 600 (sisanya dari magang).
    income(500_000, GAJI, DARAT),
    income(400_000, MAGANG, DARAT),
    expense(300_000, GAJI, DARAT),
  ];

  it("memakai sumber asli ketika kolamnya sanggup menutup", () => {
    expect(
      pickRepaySource({
        borrowerVaultId: DARAT,
        storedSourceId: GAJI,
        validSourceIds: [GAJI, MAGANG],
        transactions: ledger,
        amount: 150_000,
      })
    ).toBe(GAJI);
  });

  it("beralih ke sumber lain yang sanggup ketika sumber asli kurang", () => {
    expect(
      pickRepaySource({
        borrowerVaultId: DARAT,
        storedSourceId: GAJI,
        validSourceIds: [GAJI, MAGANG],
        transactions: ledger,
        amount: 350_000,
      })
    ).toBe(MAGANG);
  });

  it("kalau tak ada yang sanggup, kolam terbesar dipakai agar negatifnya minimal", () => {
    // gaji 200, magang 400, nominal 500: magang lebih besar meski tetap kurang.
    expect(
      pickRepaySource({
        borrowerVaultId: DARAT,
        storedSourceId: GAJI,
        validSourceIds: [GAJI, MAGANG],
        transactions: ledger,
        amount: 500_000,
      })
    ).toBe(MAGANG);
  });

  it("sumber asli menang saat kolamnya seri dengan lainnya", () => {
    const tie = [income(300_000, GAJI, DARAT), income(300_000, MAGANG, DARAT)];
    expect(
      pickRepaySource({
        borrowerVaultId: DARAT,
        storedSourceId: GAJI,
        validSourceIds: [MAGANG, GAJI],
        transactions: tie,
        amount: 200_000,
      })
    ).toBe(GAJI);
  });

  it("mengabaikan sumber asli yang sudah dihapus dan memakai yang sah", () => {
    // Sumber asli sudah tidak ada di katalog: pilihan jatuh ke sumber sah
    // berkolam terbesar, bukan ke id lama yang sudah tidak valid.
    expect(
      pickRepaySource({
        borrowerVaultId: DARAT,
        storedSourceId: "src-hapus",
        validSourceIds: [GAJI, MAGANG],
        transactions: ledger,
        amount: 150_000,
      })
    ).toBe(MAGANG);
  });

  it("null kalau tidak ada sumber pemasukan yang sah", () => {
    expect(
      pickRepaySource({
        borrowerVaultId: DARAT,
        storedSourceId: GAJI,
        validSourceIds: [],
        transactions: ledger,
        amount: 100_000,
      })
    ).toBeNull();
  });
});
