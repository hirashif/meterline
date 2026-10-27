// Graduated monthly pricing.
//
// Each unit is priced by its position in the month. With the eligibility tiers,
// units 1-250 cost 30 cents each, units 251-3,500 cost 15 cents, and so on.
// So 300 checks in one month cost 250 x 30 + 50 x 15 = 8,250 cents ($82.50).
//
// All money is integer cents. No floats anywhere.

export type Tier = {
  // Last unit (inclusive) priced at this tier. null means "and everything after".
  upTo: number | null;
  centsPerUnit: number;
};

export type Product = "eligibility" | "claims";

// Modeled on public usage-based clearinghouse pricing. Stored as config so a
// price change never touches the billing logic.
export const PRICING: Record<Product, Tier[]> = {
  eligibility: [
    { upTo: 250, centsPerUnit: 30 },
    { upTo: 3_500, centsPerUnit: 15 },
    { upTo: 10_000, centsPerUnit: 10 },
    { upTo: null, centsPerUnit: 8 },
  ],
  claims: [
    { upTo: 500, centsPerUnit: 30 },
    { upTo: 2_500, centsPerUnit: 20 },
    { upTo: 10_000, centsPerUnit: 12 },
    { upTo: null, centsPerUnit: 10 },
  ],
};

export function isProduct(value: unknown): value is Product {
  return typeof value === "string" && value in PRICING;
}

// Price of the nth billable unit of the month (n starts at 1).
export function unitPriceCents(tiers: Tier[], n: number): number {
  if (!Number.isInteger(n) || n < 1) {
    throw new Error(`unit position must be a positive integer, got ${n}`);
  }
  for (const tier of tiers) {
    if (tier.upTo === null || n <= tier.upTo) {
      return tier.centsPerUnit;
    }
  }
  throw new Error("pricing has no open-ended last tier");
}

export type TierLine = {
  fromUnit: number;
  toUnit: number;
  units: number;
  centsPerUnit: number;
  subtotalCents: number;
};

// How many units of a month's total landed in each tier. Used by the monthly
// statement and by reconciliation to recompute what the month should cost.
export function tierBreakdown(tiers: Tier[], totalUnits: number): TierLine[] {
  const lines: TierLine[] = [];
  let start = 1;
  for (const tier of tiers) {
    if (start > totalUnits) break;
    const end = tier.upTo === null ? totalUnits : Math.min(tier.upTo, totalUnits);
    if (end >= start) {
      const units = end - start + 1;
      lines.push({
        fromUnit: start,
        toUnit: end,
        units,
        centsPerUnit: tier.centsPerUnit,
        subtotalCents: units * tier.centsPerUnit,
      });
    }
    start = end + 1;
  }
  return lines;
}

export function monthTotalCents(tiers: Tier[], totalUnits: number): number {
  return tierBreakdown(tiers, totalUnits).reduce((sum, line) => sum + line.subtotalCents, 0);
}

// Events that are recorded but never charged and never count toward tiers:
// test mode, a few payer result codes that mean "nothing was really checked",
// and any request that failed (HTTP 4xx or 5xx).
export const NON_BILLABLE_RESULT_CODES = new Set(["AAA42", "AAA79", "AAA80"]);

export type UsageOutcome = {
  testMode?: boolean;
  resultCode?: string;
  httpStatus?: number;
};

export function isBillable(outcome: UsageOutcome): boolean {
  if (outcome.testMode) return false;
  if (outcome.resultCode && NON_BILLABLE_RESULT_CODES.has(outcome.resultCode)) return false;
  if (outcome.httpStatus !== undefined && outcome.httpStatus >= 400) return false;
  return true;
}
