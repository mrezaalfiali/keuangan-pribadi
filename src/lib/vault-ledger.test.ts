import { describe, expect, it } from "vitest";
import { expenseVaultError, vaultBalanceDelta } from "./vault-ledger";

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
