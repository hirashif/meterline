import type { Billing } from "./billing.js";
import { PRICING, type Product, type TierLine, tierBreakdown } from "./pricing.js";

export type ProductStatement = {
  product: Product;
  billableUnits: number;
  nonBillableEvents: number;
  tiers: TierLine[];
  chargedCents: number;
};

export type Statement = {
  accountId: string;
  month: string;
  products: ProductStatement[];
  totalChargedCents: number;
  topUps: { paymentId: string; kind: string; amountCents: number; createdAt: string }[];
  topUpTotalCents: number;
};

// One month for one account: units in each tier, the price of each tier,
// free events, what was charged, and what was paid in.
export async function buildStatement(billing: Billing, accountId: string, month: string): Promise<Statement> {
  await billing.getAccount(accountId); // 404 if the account does not exist
  const events = (await billing.queryAll(accountId, "EVENT#")).filter((e) => e.month === month);
  const topUps = (await billing.queryAll(accountId, "TOPUP#")).filter((t) =>
    String(t.createdAt).startsWith(month),
  );

  const products: ProductStatement[] = [];
  for (const product of Object.keys(PRICING) as Product[]) {
    const mine = events.filter((e) => e.product === product);
    if (mine.length === 0) continue;
    const billable = mine.filter((e) => e.billable);
    products.push({
      product,
      billableUnits: billable.length,
      nonBillableEvents: mine.length - billable.length,
      tiers: tierBreakdown(PRICING[product], billable.length),
      chargedCents: billable.reduce((sum, e) => sum + e.chargedCents, 0),
    });
  }

  const topUpLines = topUps
    .map((t) => ({ paymentId: t.paymentId, kind: t.kind, amountCents: t.amountCents, createdAt: t.createdAt }))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));

  return {
    accountId,
    month,
    products,
    totalChargedCents: products.reduce((sum, p) => sum + p.chargedCents, 0),
    topUps: topUpLines,
    topUpTotalCents: topUpLines.reduce((sum, t) => sum + t.amountCents, 0),
  };
}
