import { describe, expect, it } from "vitest";
import {
  PRICING,
  isBillable,
  monthTotalCents,
  tierBreakdown,
  unitPriceCents,
} from "../../src/pricing.js";

const elig = PRICING.eligibility;

describe("unitPriceCents", () => {
  it("prices each unit by its position in the month", () => {
    expect(unitPriceCents(elig, 1)).toBe(30);
    expect(unitPriceCents(elig, 250)).toBe(30);
    expect(unitPriceCents(elig, 251)).toBe(15);
    expect(unitPriceCents(elig, 3_500)).toBe(15);
    expect(unitPriceCents(elig, 3_501)).toBe(10);
    expect(unitPriceCents(elig, 10_001)).toBe(8);
    expect(unitPriceCents(elig, 1_000_000)).toBe(8);
  });

  it("rejects positions below 1", () => {
    expect(() => unitPriceCents(elig, 0)).toThrow();
    expect(() => unitPriceCents(elig, 1.5)).toThrow();
  });
});

describe("monthly totals", () => {
  it("300 eligibility checks cost $82.50", () => {
    expect(monthTotalCents(elig, 300)).toBe(250 * 30 + 50 * 15);
    expect(monthTotalCents(elig, 300)).toBe(8_250);
  });

  it("10,000 eligibility checks cost $1,212.50", () => {
    expect(monthTotalCents(elig, 10_000)).toBe(121_250);
  });

  it("zero units cost nothing", () => {
    expect(monthTotalCents(elig, 0)).toBe(0);
    expect(tierBreakdown(elig, 0)).toEqual([]);
  });

  it("summing unit prices one by one matches the breakdown", () => {
    for (const product of ["eligibility", "claims"] as const) {
      const tiers = PRICING[product];
      let running = 0;
      for (let n = 1; n <= 12_000; n++) running += unitPriceCents(tiers, n);
      expect(running).toBe(monthTotalCents(tiers, 12_000));
    }
  });

  it("breaks a month into tier lines for the statement", () => {
    expect(tierBreakdown(elig, 300)).toEqual([
      { fromUnit: 1, toUnit: 250, units: 250, centsPerUnit: 30, subtotalCents: 7_500 },
      { fromUnit: 251, toUnit: 300, units: 50, centsPerUnit: 15, subtotalCents: 750 },
    ]);
  });
});

describe("isBillable", () => {
  it("charges a normal successful event", () => {
    expect(isBillable({})).toBe(true);
    expect(isBillable({ httpStatus: 200, resultCode: "AAA00" })).toBe(true);
  });

  it("does not charge test mode, AAA42/79/80, or failed requests", () => {
    expect(isBillable({ testMode: true })).toBe(false);
    expect(isBillable({ resultCode: "AAA42" })).toBe(false);
    expect(isBillable({ resultCode: "AAA79" })).toBe(false);
    expect(isBillable({ resultCode: "AAA80" })).toBe(false);
    expect(isBillable({ httpStatus: 400 })).toBe(false);
    expect(isBillable({ httpStatus: 503 })).toBe(false);
  });
});
