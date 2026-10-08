import { describe, expect, it } from "vitest";
import { vaultBalanceDelta } from "./vault-ledger";

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
