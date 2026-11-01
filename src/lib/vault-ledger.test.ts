import { describe, expect, it } from "vitest";
import {
  deleteReducesLockedVaultError,
  expenseVaultError,
  incomeLockedVaultError,
  vaultBalanceDelta,
} from "./vault-ledger";

describe("vaultBalanceDelta", () => {
  it("subtracts expenses and outgoing transfers", () => {
    expect(vaultBalanceDelta("expense", 250)).toBe(-250);
    expect(vaultBalanceDelta("transfer", 250, "out")).toBe(-250);
  });

  it("adds income and incoming transfers", () => {
    expect(vaultBalanceDelta("income", 250)).toBe(250);
    expect(vaultBalanceDelta("transfer", 250, "in")).toBe(250);
  });

  it("keeps a paired transfer neutral across both vaults", () => {
    expect(
      vaultBalanceDelta("transfer", 250, "out") +
        vaultBalanceDelta("transfer", 250, "in")
    ).toBe(0);
  });

  it("preserves the existing treatment of legacy transfers without direction", () => {
    expect(vaultBalanceDelta("transfer", 250)).toBe(250);
  });
});

describe("expenseVaultError", () => {
  it("menolak pengeluaran tanpa vault", () => {
    expect(expenseVaultError(null, 100_000)).toBe("transactions.expenseVaultRequired");
  });

  it("menolak pengeluaran dari vault terkunci", () => {
    expect(expenseVaultError({ is_locked: true, balance: 500_000 }, 100_000)).toBe(
      "transactions.lockedError"
    );
  });

  it("menolak pengeluaran yang melebihi saldo vault", () => {
    expect(expenseVaultError({ is_locked: false, balance: 50_000 }, 100_000)).toBe(
      "transactions.insufficient"
    );
  });

  it("mengizinkan pengeluaran yang pas dengan saldo", () => {
    expect(expenseVaultError({ is_locked: false, balance: 100_000 }, 100_000)).toBeNull();
  });

  it("mengizinkan pengeluaran dari vault tidak terkunci yang saldonya cukup", () => {
    expect(expenseVaultError({ is_locked: false, balance: 500_000 }, 100_000)).toBeNull();
  });
});

describe("incomeLockedVaultError", () => {
  it("mengizinkan semua perubahan saat vault lama tidak terkunci", () => {
    expect(
      incomeLockedVaultError({ oldVaultId: "a", oldVaultLocked: false, newVaultId: "b", oldAmount: 100, newAmount: 50 })
    ).toBeNull();
  });

  it("mengizinkan perubahan tanpa penarikan di vault terkunci", () => {
    expect(
      incomeLockedVaultError({ oldVaultId: "a", oldVaultLocked: true, newVaultId: "a", oldAmount: 100, newAmount: 100 })
    ).toBeNull();
    expect(
      incomeLockedVaultError({ oldVaultId: "a", oldVaultLocked: true, newVaultId: "a", oldAmount: 100, newAmount: 150 })
    ).toBeNull();
  });

  it("menolak pindah vault dari vault terkunci, berapa pun nominal barunya", () => {
    expect(
      incomeLockedVaultError({ oldVaultId: "a", oldVaultLocked: true, newVaultId: "b", oldAmount: 100, newAmount: 100 })
    ).toBe("transactions.lockedError");
    expect(
      incomeLockedVaultError({ oldVaultId: "a", oldVaultLocked: true, newVaultId: "b", oldAmount: 100, newAmount: 200 })
    ).toBe("transactions.lockedError");
  });

  it("menolak mengosongkan vault dari vault terkunci", () => {
    expect(
      incomeLockedVaultError({ oldVaultId: "a", oldVaultLocked: true, newVaultId: null, oldAmount: 100, newAmount: 100 })
    ).toBe("transactions.lockedError");
    expect(
      incomeLockedVaultError({ oldVaultId: "a", oldVaultLocked: true, newVaultId: "", oldAmount: 100, newAmount: 100 })
    ).toBe("transactions.lockedError");
  });

  it("menolak penurunan nominal di vault terkunci", () => {
    expect(
      incomeLockedVaultError({ oldVaultId: "a", oldVaultLocked: true, newVaultId: "a", oldAmount: 100, newAmount: 99 })
    ).toBe("transactions.lockedError");
  });

  it("vault lama kosong berarti tidak ada yang dijaga", () => {
    expect(
      incomeLockedVaultError({ oldVaultId: null, oldVaultLocked: false, newVaultId: "a", oldAmount: 100, newAmount: 100 })
    ).toBeNull();
    expect(
      incomeLockedVaultError({ oldVaultId: "", oldVaultLocked: false, newVaultId: null, oldAmount: 100, newAmount: 100 })
    ).toBeNull();
  });
});

describe("deleteReducesLockedVaultError", () => {
  it("menolak hapus income di vault terkunci", () => {
    expect(
      deleteReducesLockedVaultError([{ type: "income", vault_id: "a", transfer_direction: null }], ["a"])
    ).toBe("transactions.lockedError");
  });

  it("menolak hapus transfer masuk dan transfer lawas tanpa arah di vault terkunci", () => {
    expect(
      deleteReducesLockedVaultError([{ type: "transfer", vault_id: "a", transfer_direction: "in" }], ["a"])
    ).toBe("transactions.lockedError");
    expect(
      deleteReducesLockedVaultError([{ type: "transfer", vault_id: "a", transfer_direction: null }], ["a"])
    ).toBe("transactions.lockedError");
  });

  it("mengizinkan hapus expense dan transfer keluar di vault terkunci", () => {
    expect(
      deleteReducesLockedVaultError([{ type: "expense", vault_id: "a", transfer_direction: null }], ["a"])
    ).toBeNull();
    expect(
      deleteReducesLockedVaultError([{ type: "transfer", vault_id: "a", transfer_direction: "out" }], ["a"])
    ).toBeNull();
  });

  it("mengizinkan hapus baris di vault yang tidak termasuk terkunci", () => {
    expect(
      deleteReducesLockedVaultError([{ type: "income", vault_id: "b", transfer_direction: null }], ["a"])
    ).toBeNull();
    expect(
      deleteReducesLockedVaultError([{ type: "income", vault_id: "b", transfer_direction: null }], [])
    ).toBeNull();
  });

  it("satu baris income di vault terkunci menolak seluruh group", () => {
    expect(
      deleteReducesLockedVaultError(
        [
          { type: "income", vault_id: "b", transfer_direction: null },
          { type: "income", vault_id: "a", transfer_direction: null },
        ],
        ["a"]
      )
    ).toBe("transactions.lockedError");
  });

  it("baris tanpa vault tidak pernah ditolak", () => {
    expect(
      deleteReducesLockedVaultError([{ type: "income", vault_id: null, transfer_direction: null }], ["a"])
    ).toBeNull();
  });
});
