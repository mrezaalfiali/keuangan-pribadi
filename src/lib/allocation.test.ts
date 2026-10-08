import { describe, expect, it } from "vitest";
import { distributeAllocation, previewAllocation, sumPercent, validateSlots } from "@/src/lib/allocation";
import type { AllocationSlot } from "@/src/lib/types";

type Slot = Pick<AllocationSlot, "vault_id" | "method" | "value">;

function slot(vault_id: string, method: AllocationSlot["method"], value = 0): Slot {
  return { vault_id, method, value };
}

const emergency = slot("vault-emergency", "percent", 60);
const bills = slot("vault-bills", "percent", 30);
const leftover = slot("vault-leftover", "remainder", 0);

describe("distributeAllocation", () => {
  it("membagi sesuai percent dan memberi sisa ke slot remainder", () => {
    const result = distributeAllocation(1_000_000, [
      { ...emergency, id: "a", rule_id: "r", priority: 0 },
      { ...bills, id: "b", rule_id: "r", priority: 1 },
      { ...leftover, id: "c", rule_id: "r", priority: 2 },
    ] as AllocationSlot[]);
    expect(result.map((r) => r.amount)).toEqual([600_000, 300_000, 100_000]);
  });

  it("jumlah hasil selalu sama dengan total", () => {
    const slots = [
      { ...emergency, id: "a", rule_id: "r", priority: 0 },
      { ...bills, id: "b", rule_id: "r", priority: 1 },
      { ...leftover, id: "c", rule_id: "r", priority: 2 },
    ] as AllocationSlot[];
    for (const total of [0, 1, 999, 1_234_567, 75_000_000]) {
      const sum = distributeAllocation(total, slots).reduce((acc, r) => acc + r.amount, 0);
      expect(sum).toBe(total);
    }
  });

  it("slot amount dipotong nominal, bukan dikali persen", () => {
    const result = distributeAllocation(5_000_000, [
      { ...slot("vault-fixed", "amount", 1_000_000), id: "a", rule_id: "r", priority: 0 },
      { ...leftover, id: "b", rule_id: "r", priority: 1 },
    ] as AllocationSlot[]);
    expect(result.map((r) => r.amount)).toEqual([1_000_000, 4_000_000]);
  });

  it("tidak mengalokasikan lebih dari total karena pembulatan persentase", () => {
    const result = distributeAllocation(2, [
      { ...slot("vault-a", "percent", 33.33), id: "a", rule_id: "r", priority: 0 },
      { ...slot("vault-b", "percent", 33.33), id: "b", rule_id: "r", priority: 1 },
      { ...slot("vault-c", "percent", 33.33), id: "c", rule_id: "r", priority: 2 },
      { ...leftover, id: "d", rule_id: "r", priority: 3 },
    ] as AllocationSlot[]);
    expect(result.map((r) => r.amount)).toEqual([1, 1, 0, 0]);
    expect(result.reduce((sum, item) => sum + item.amount, 0)).toBe(2);
  });

  it("slot amount tidak melebihi sisa yang ada", () => {
    const result = distributeAllocation(500_000, [
      { ...slot("vault-fixed", "amount", 9_000_000), id: "a", rule_id: "r", priority: 0 },
      { ...leftover, id: "b", rule_id: "r", priority: 1 },
    ] as AllocationSlot[]);
    expect(result.map((r) => r.amount)).toEqual([500_000, 0]);
  });

  it("remainder bernilai 0 ketika percent sudah 100", () => {
    const result = distributeAllocation(1_000_000, [
      { ...emergency, id: "a", rule_id: "r", priority: 0 },
      { ...slot("vault-bills", "percent", 40), id: "b", rule_id: "r", priority: 1 },
      { ...leftover, id: "c", rule_id: "r", priority: 2 },
    ] as AllocationSlot[]);
    expect(result.map((r) => r.amount)).toEqual([600_000, 400_000, 0]);
  });
});

describe("sumPercent", () => {
  it("menjumlahkan slot percent saja", () => {
    expect(sumPercent([emergency, bills, leftover] as AllocationSlot[])).toBe(90);
  });
});

describe("validateSlots", () => {
  it("menerima aturan dengan tepat satu slot remainder", () => {
    expect(validateSlots([emergency, bills, leftover])).toEqual({ ok: true });
  });

  it("menerima percent 100 dengan remainder bernilai 0", () => {
    expect(validateSlots([emergency, slot("v2", "percent", 40), leftover])).toEqual({ ok: true });
  });

  it("menolak aturan tanpa slot", () => {
    expect(validateSlots([])).toEqual({ ok: false, error: "noSlots" });
  });

  it("menolak aturan tanpa slot remainder", () => {
    expect(validateSlots([emergency, bills])).toEqual({
      ok: false,
      error: "needRemainder",
    });
  });

  it("menolak dua slot remainder", () => {
    expect(validateSlots([leftover, slot("v2", "remainder", 0)])).toEqual({
      ok: false,
      error: "needRemainder",
    });
  });

  it("menolak total percent di atas 100", () => {
    expect(validateSlots([emergency, slot("v2", "percent", 50), leftover])).toEqual({
      ok: false,
      error: "tooMuchPercent",
    });
  });

  it("menolak percent negatif", () => {
    expect(validateSlots([slot("v1", "percent", -1), leftover])).toEqual({
      ok: false,
      error: "badPercent",
    });
  });

  it("persen 101 lebih dulu kena aturan total di atas 100", () => {
    // Satu slot 101% saja: total percent dicek sebelum rentang per slot, dan
    // pesan yang lebih informatif untuk kasus ini adalah totalnya.
    expect(validateSlots([slot("v1", "percent", 101), leftover])).toEqual({
      ok: false,
      error: "tooMuchPercent",
    });
  });

  it("menolak amount negatif", () => {
    expect(validateSlots([slot("v1", "amount", -500), leftover])).toEqual({
      ok: false,
      error: "badAmount",
    });
  });

  it("menolak slot tanpa vault", () => {
    expect(validateSlots([slot("", "percent", 50), leftover])).toEqual({
      ok: false,
      error: "slotVaultRequired",
    });
  });

  it("menolak dua slot ke vault yang sama", () => {
    expect(validateSlots([emergency, slot("vault-emergency", "percent", 20), leftover])).toEqual({
      ok: false,
      error: "duplicateVault",
    });
  });
});

describe("previewAllocation", () => {
  it("menghasilkan angka yang sama dengan distributeAllocation", () => {
    const slots = [
      { ...emergency, priority: 0 },
      { ...slot("vault-fixed", "amount", 500_000), priority: 1 },
      { ...leftover, priority: 2 },
    ];
    const preview = previewAllocation(3_000_000, slots);
    const actual = distributeAllocation(
      3_000_000,
      slots.map((s, i) => ({ ...s, id: String(i), rule_id: "r" })) as AllocationSlot[]
    );
    expect(preview.map((r) => r.amount)).toEqual(actual.map((r) => r.amount));
  });

  it("slot amount bukan lagi dikali persen", () => {
    // Regresi: pratinjau lama selalu memakai monthIncome * value / 100.
    const preview = previewAllocation(3_000_000, [
      { vault_id: "vault-fixed", method: "amount", value: 500_000, priority: 0 },
      { vault_id: "vault-leftover", method: "remainder", value: 0, priority: 1 },
    ]);
    expect(preview.map((r) => r.amount)).toEqual([500_000, 2_500_000]);
  });

  it("total tidak valid menjadi 0, bukan NaN atau negatif", () => {
    expect(previewAllocation(-5, [{ vault_id: "v", method: "remainder", value: 0, priority: 0 }]).map((r) => r.amount)).toEqual([0]);
    expect(previewAllocation(Number.NaN, [{ vault_id: "v", method: "remainder", value: 0, priority: 0 }]).map((r) => r.amount)).toEqual([0]);
  });
});