import { ScanCommand, type DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import type { Billing } from "./billing.js";
import type { PaymentProvider } from "./payments.js";
import { PRICING, type Product, monthTotalCents } from "./pricing.js";

// Reconciliation does not trust the write path. It recomputes every account
// from the raw rows and from the payment processor, and lists anything that
// disagrees with what is stored:
//
//   balance        top-ups minus usage charges must equal the stored balance
//   tier_counter   billable events per product per month must equal the counter
//   tier_pricing   what was charged for a month must equal the price table
//                  applied to that month's unit count
//   payments       every top-up must match a succeeded processor charge
//                  (same id, same amount), and every succeeded charge must
//                  have been credited

export type Mismatch = {
  accountId: string;
  check: "balance" | "tier_counter" | "tier_pricing" | "payments";
  detail: string;
  expected: number | string;
  actual: number | string;
};

export type ReconcileReport = {
  ranAt: string;
  accountsChecked: number;
  mismatches: Mismatch[];
};

export async function listAccountIds(db: DynamoDBDocumentClient, table: string): Promise<string[]> {
  const ids: string[] = [];
  let startKey: Record<string, any> | undefined;
  do {
    const res = await db.send(
      new ScanCommand({
        TableName: table,
        FilterExpression: "sk = :meta",
        ExpressionAttributeValues: { ":meta": "META" },
        ProjectionExpression: "accountId",
        ConsistentRead: true,
        ExclusiveStartKey: startKey,
      }),
    );
    ids.push(...(res.Items ?? []).map((i) => i.accountId as string));
    startKey = res.LastEvaluatedKey;
  } while (startKey);
  return ids;
}

export async function reconcileAccount(
  billing: Billing,
  payments: PaymentProvider,
  accountId: string,
): Promise<Mismatch[]> {
  const mismatches: Mismatch[] = [];
  const account = await billing.getAccount(accountId);
  const events = await billing.queryAll(accountId, "EVENT#");
  const topUps = await billing.queryAll(accountId, "TOPUP#");
  const counters = await billing.queryAll(accountId, "COUNT#");

  // 1. balance
  const paidIn = topUps.reduce((sum, t) => sum + t.amountCents, 0);
  const charged = events.reduce((sum, e) => sum + (e.chargedCents ?? 0), 0);
  if (paidIn - charged !== account.balanceCents) {
    mismatches.push({
      accountId,
      check: "balance",
      detail: `top-ups ${paidIn} minus usage charges ${charged}`,
      expected: paidIn - charged,
      actual: account.balanceCents,
    });
  }

  // 2 and 3. per product per month: unit counter and tier pricing
  const groups = new Map<string, { product: Product; month: string; units: number; charged: number }>();
  for (const e of events) {
    if (!e.billable) continue;
    const key = `${e.product}#${e.month}`;
    const g = groups.get(key) ?? { product: e.product, month: e.month, units: 0, charged: 0 };
    g.units += 1;
    g.charged += e.chargedCents ?? 0;
    groups.set(key, g);
  }
  const stored = new Map(counters.map((c) => [`${c.product}#${c.month}`, c.units as number]));
  for (const key of new Set([...groups.keys(), ...stored.keys()])) {
    const units = groups.get(key)?.units ?? 0;
    const counter = stored.get(key) ?? 0;
    if (units !== counter) {
      mismatches.push({
        accountId,
        check: "tier_counter",
        detail: `billable events for ${key.replace("#", " in ")}`,
        expected: units,
        actual: counter,
      });
    }
  }
  for (const [key, g] of groups) {
    const expected = monthTotalCents(PRICING[g.product], g.units);
    if (expected !== g.charged) {
      mismatches.push({
        accountId,
        check: "tier_pricing",
        detail: `charges for ${g.units} ${g.product} units in ${g.month}`,
        expected,
        actual: g.charged,
      });
    }
  }

  // 4. payments: database top-ups vs processor charges, both directions
  const succeeded = (await payments.listCharges(accountId)).filter((c) => c.status === "succeeded");
  const chargeById = new Map(succeeded.map((c) => [c.id, c]));
  const topUpById = new Map(topUps.map((t) => [t.paymentId as string, t]));
  for (const t of topUps) {
    const c = chargeById.get(t.paymentId);
    if (!c) {
      mismatches.push({ accountId, check: "payments", detail: `top-up ${t.paymentId} has no succeeded charge`, expected: "a succeeded charge", actual: "none" });
    } else if (c.amountCents !== t.amountCents) {
      mismatches.push({ accountId, check: "payments", detail: `amount for ${t.paymentId}`, expected: c.amountCents, actual: t.amountCents });
    }
  }
  for (const c of succeeded) {
    if (!topUpById.has(c.id)) {
      mismatches.push({ accountId, check: "payments", detail: `charge ${c.id} was never credited`, expected: c.amountCents, actual: 0 });
    }
  }

  return mismatches;
}

// The daily job: first finish any recharge a crashed process left half-done,
// then reconcile every account. Reconciliation reads each account's rows one
// after another, not as a single snapshot, so a recharge that is in flight
// while it runs can show up as a mismatch; run it when traffic is quiet, and
// treat a mismatch that disappears on the next run as timing, not a bug.
export async function dailyJob(
  billing: Billing,
  payments: PaymentProvider,
  db: DynamoDBDocumentClient,
  table: string,
  now: Date = new Date(),
): Promise<ReconcileReport & { recoveredRecharges: number }> {
  let recoveredRecharges = 0;
  for (const id of await listAccountIds(db, table)) {
    const account = await billing.getAccount(id);
    if (account.pendingAmountCents !== undefined && (account.leaseUntil ?? 0) < now.getTime()) {
      const outcome = await billing.settle(id);
      if (outcome && outcome.status !== "skipped") recoveredRecharges++;
    }
  }
  const report = await reconcileAll(billing, payments, db, table, now);
  return { ...report, recoveredRecharges };
}

export async function reconcileAll(
  billing: Billing,
  payments: PaymentProvider,
  db: DynamoDBDocumentClient,
  table: string,
  now: Date = new Date(),
): Promise<ReconcileReport> {
  const ids = await listAccountIds(db, table);
  const mismatches: Mismatch[] = [];
  for (const id of ids) mismatches.push(...(await reconcileAccount(billing, payments, id)));
  return { ranAt: now.toISOString(), accountsChecked: ids.length, mismatches };
}
