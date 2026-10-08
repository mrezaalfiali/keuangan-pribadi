import type { TxType } from "./types";

export type TransferDirection = "out" | "in" | null;

export function vaultBalanceDelta(
  type: TxType,
  amount: number,
  transferDirection: TransferDirection | undefined = null
): number {
  if (type === "expense" || (type === "transfer" && transferDirection === "out")) {
    return -amount;
  }
  return amount;
}
