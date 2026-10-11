import { describe, expect, it } from "vitest";
import { parseAmount } from "@/src/lib/money";

describe("parseAmount", () => {
  it("membaca angka polos", () => {
    expect(parseAmount("9000000")).toBe(9000000);
    expect(parseAmount("0")).toBe(0);
  });

  it("membuang pemisah ribuan titik maupun koma", () => {
    expect(parseAmount("9.000.000")).toBe(9000000);
    expect(parseAmount("9,000,000")).toBe(9000000);
    expect(parseAmount("Rp 9.000.000")).toBe(9000000);
  });

  it("mengembalikan 0 untuk input kosong atau tidak valid", () => {
    expect(parseAmount("")).toBe(0);
    expect(parseAmount("abc")).toBe(0);
    expect(parseAmount("-")).toBe(0);
  });

  it("mempertahankan tanda negatif", () => {
    expect(parseAmount("-1.500")).toBe(-1500);
  });
});
