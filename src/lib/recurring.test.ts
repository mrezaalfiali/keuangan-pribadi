import { describe, expect, it } from "vitest";
import { nextRecurringDate } from "./recurring";

describe("nextRecurringDate", () => {
  it("keeps overdue weekly occurrences available for individual review", () => {
    expect(nextRecurringDate("2026-09-01", {
      frequency: "weekly",
      intervalCount: 1,
      anchorDay: 1,
    })).toBe("2026-09-08");
  });

  it("keeps monthly schedules anchored to the original day after short months", () => {
    expect(nextRecurringDate("2026-01-31", {
      frequency: "monthly",
      intervalCount: 1,
      anchorDay: 31,
    })).toBe("2026-02-28");
  });

  it("respects multi-month intervals and year boundaries", () => {
    expect(nextRecurringDate("2026-11-30", {
      frequency: "monthly",
      intervalCount: 2,
      anchorDay: 30,
    })).toBe("2027-01-30");
  });

  it("rejects invalid dates and interval counts", () => {
    expect(() => nextRecurringDate("2026-02-30", {
      frequency: "monthly",
      intervalCount: 1,
      anchorDay: 30,
    })).toThrow("err.period");
    expect(() => nextRecurringDate("2026-01-01", {
      frequency: "weekly",
      intervalCount: 13,
      anchorDay: 1,
    })).toThrow("err.interval");
  });
});
