import { describe, expect, it } from "vitest";
import { getOnboardingSteps } from "./onboarding-checklist";

describe("getOnboardingSteps", () => {
  it("starts with all steps incomplete", () => {
    expect(getOnboardingSteps([], [], [], "2026-10-08").map((step) => step.complete))
      .toEqual([false, false, false]);
  });

  it("automatically completes steps from the user's data", () => {
    const steps = getOnboardingSteps(
      [{ type: "transfer" }, { type: "income" }],
      [{ id: "vault-1" }],
      [
        { starts_on: "2026-10-09", ends_on: "2026-11-08" },
        { starts_on: "2026-10-01", ends_on: "2026-10-31" },
      ],
      "2026-10-08"
    );

    expect(steps.map((step) => step.complete)).toEqual([true, true, true]);
    expect(steps.map((step) => step.href)).toEqual(["/transactions", "/vaults", "/budgets"]);
  });

  it("does not complete transaction step for transfers alone or budget step for inactive periods", () => {
    const steps = getOnboardingSteps(
      [{ type: "transfer" }],
      [],
      [
        { starts_on: "2026-10-09", ends_on: "2026-11-08" },
        { starts_on: "2026-09-01", ends_on: "2026-09-30" },
      ],
      "2026-10-08"
    );

    expect(steps.map((step) => step.complete)).toEqual([false, false, false]);
  });
});
