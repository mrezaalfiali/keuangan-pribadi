import type { AllocationSlot } from "./types";

export interface DistResult {
  slot: AllocationSlot;
  amount: number;
}

/**
 * Distribute an income amount across allocation slots:
 *  - percent / amount slots consume from the total first
 *  - remainder slot(s) absorb whatever is left
 * The sum of all slots always equals `total` (no drift).
 */
export function distributeAllocation(
  total: number,
  slots: AllocationSlot[]
): DistResult[] {
  const percentSlots = slots.filter((s) => s.method === "percent");
  const amountSlots = slots.filter((s) => s.method === "amount");
  const remainderSlots = slots.filter((s) => s.method === "remainder");

  const results: DistResult[] = [];
  let used = 0;

  for (const slot of percentSlots) {
    const amount = Math.min(
      Math.max(0, total - used),
      Math.round((total * slot.value) / 100)
    );
    results.push({ slot, amount });
    used += amount;
  }
  for (const slot of amountSlots) {
    const amount = Math.min(Math.max(0, slot.value), Math.max(0, total - used));
    results.push({ slot, amount });
    used += amount;
  }
  for (const slot of remainderSlots) {
    const amount = Math.max(0, total - used);
    results.push({ slot, amount });
    used += amount;
  }

  return results;
}

export function sumPercent(
  slots: Array<Pick<AllocationSlot, "method" | "value">>
): number {
  return slots
    .filter((s) => s.method === "percent")
    .reduce((acc, s) => acc + s.value, 0);
}

/**
 * Kode error validasi alokasi, TANPA prefix namespace.
 *
 * Satu-satunya tempat key ini dirender adalah form builder di halaman Alokasi,
 * yang sudah berada di dalam `useTranslations("allocation")`. Kalau key-nya
 * diprefix, pemanggil harus mengatasinya secara manual dan hasilnya
 * `allocation.allocation.slotVault` yang tidak bisa diresolve.
 *
 * Union type dipilih supaya salah ketik di sini menjadi error compile, bukan
 * MISSING_MESSAGE di console. Test `src/messages.test.ts` mengikat union ini ke
 * key yang benar-benar ada di kedua locale.
 */
export type AllocationError =
  | "noSlots"
  | "needRemainder"
  | "tooMuchPercent"
  | "badPercent"
  | "badAmount"
  | "slotVaultRequired"
  | "duplicateVault";

/**
 * Validasi aturan alokasi sebelum disimpan.
 *
 * Aturan wajib punya tepat satu slot `remainder`: slot itulah tujuan sisa
 * pembagian, sehingga tidak ada uang yang hilang ketika total percent + amount
 * belum mencapai 100%.
 *
 * Total percent dibatasi 100, bukan 100 secara ketat, karena ketika percent
 * sudah 100 slot remainder bernilai 0 — konfigurasi itu wajar (semua uang
 * diarahkan, tidak ada sisa) dan tidak perlu ditolak.
 *
 * Vault tidak boleh muncul dua kali: dua slot ke vault yang sama membuat saldo
 * terhitung dua kali dan membuat pratinjau tidak bisa dibaca.
 */
export function validateSlots(
  slots: Array<Pick<AllocationSlot, "vault_id" | "method" | "value">>
): { ok: true } | { ok: false; error: AllocationError } {
  if (slots.length === 0) return { ok: false, error: "noSlots" };

  const remainderCount = slots.filter((slot) => slot.method === "remainder").length;
  if (remainderCount !== 1) return { ok: false, error: "needRemainder" };

  const percent = sumPercent(slots);
  if (percent > 100) return { ok: false, error: "tooMuchPercent" };

  for (const slot of slots) {
    if (!slot.vault_id) return { ok: false, error: "slotVaultRequired" };
    if (slot.method === "percent" && (slot.value < 0 || slot.value > 100)) {
      return { ok: false, error: "badPercent" };
    }
    if (slot.method === "amount" && slot.value < 0) {
      return { ok: false, error: "badAmount" };
    }
  }

  const vaultIds = slots.map((slot) => slot.vault_id);
  if (new Set(vaultIds).size !== vaultIds.length) return { ok: false, error: "duplicateVault" };

  return { ok: true };
}

/**
 * Pratinjau pembagian untuk satu nominal income. Memakai `distributeAllocation`
 * yang sama dengan jalur eksekusi, jadi angka di layar sama dengan yang akan
 * benar-benar terjadi — termasuk untuk slot `amount` dan `remainder`, yang
 * dulu salah karena selalu dikali persen.
 */
export function previewAllocation(
  total: number,
  slots: Array<Pick<AllocationSlot, "vault_id" | "method" | "value" | "priority">>
): DistResult[] {
  const safeTotal = Number.isFinite(total) && total > 0 ? Math.trunc(total) : 0;
  return distributeAllocation(
    safeTotal,
    slots as AllocationSlot[]
  );
}