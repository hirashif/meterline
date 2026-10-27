import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { injectUnbilledCharge } from "../../src/chaos.js";
import { reconcileAccount, reconcileAll } from "../../src/reconcile.js";
import { buildStatement } from "../../src/statement.js";
import { monthOf } from "../../src/billing.js";
import { keysFor, setup } from "../helpers.js";

let ctx: Awaited<ReturnType<typeof setup>>;
beforeAll(async () => {
  ctx = await setup();
});
afterAll(async () => ctx.teardown());

describe("statement", () => {
  it("shows units per tier, free events, charges and top-ups for the month", async () => {
    const acct = await ctx.billing.createAccount({ startingBalanceCents: 100_000 });
    for (const k of keysFor("s", 300)) {
      await ctx.billing.recordUsage(acct.accountId, { idempotencyKey: k, product: "eligibility" });
    }
    await ctx.billing.recordUsage(acct.accountId, { idempotencyKey: "free", product: "eligibility", resultCode: "AAA42" });

    const st = await buildStatement(ctx.billing, acct.accountId, monthOf(new Date()));
    expect(st.products[0]).toMatchObject({ product: "eligibility", billableUnits: 300, nonBillableEvents: 1, chargedCents: 8_250 });
    expect(st.products[0].tiers.map((t) => [t.units, t.centsPerUnit])).toEqual([
      [250, 30],
      [50, 15],
    ]);
    expect(st.topUpTotalCents).toBe(100_000);
  });
});

describe("reconciliation", () => {
  it("finds nothing wrong after concurrent usage, a recharge, a declined card, suspension and recovery", async () => {
    const acct = await ctx.billing.createAccount({ startingBalanceCents: 1_100 });
    await Promise.all(
      keysFor("r", 40).map((k) => ctx.billing.recordUsage(acct.accountId, { idempotencyKey: k, product: "eligibility" })),
    );
    await ctx.billing.setPaymentMethod(acct.accountId, "pm_card_chargeDeclined");
    for (let i = 0; i < 200; i++) {
      const r = await ctx.billing.recordUsage(acct.accountId, { idempotencyKey: `d-${i}`, product: "eligibility" }).catch((e) => e);
      if (r.status === 402 || r.status === "suspended") break;
    }
    expect((await ctx.billing.getAccount(acct.accountId)).status).toBe("suspended");
    await ctx.billing.setPaymentMethod(acct.accountId, "pm_card_visa");
    expect((await ctx.billing.getAccount(acct.accountId)).status).toBe("active");
    expect(await reconcileAccount(ctx.billing, ctx.payments, acct.accountId)).toEqual([]);
  });

  it("names the account and checks broken by an unbilled charge", async () => {
    const acct = await ctx.billing.createAccount();
    await ctx.billing.recordUsage(acct.accountId, { idempotencyKey: "ok", product: "eligibility" });
    await injectUnbilledCharge(ctx.db, ctx.table, acct.accountId);

    const mismatches = await reconcileAccount(ctx.billing, ctx.payments, acct.accountId);
    const checks = mismatches.map((m) => m.check).sort();
    expect(checks).toEqual(["balance", "tier_counter"]);
    const balance = mismatches.find((m) => m.check === "balance")!;
    expect(balance).toMatchObject({ accountId: acct.accountId, expected: 2_500 - 60, actual: 2_470 });
  });

  it("catches a processor charge that was never credited", async () => {
    const acct = await ctx.billing.createAccount();
    await ctx.payments.charge({
      accountId: acct.accountId,
      amountCents: 2_500,
      paymentMethod: "pm_card_visa",
      idempotencyKey: "orphan",
      reason: "recharge",
    });
    const mismatches = await reconcileAccount(ctx.billing, ctx.payments, acct.accountId);
    expect(mismatches).toHaveLength(1);
    expect(mismatches[0]).toMatchObject({ check: "payments", expected: 2_500, actual: 0 });
  });

  it("runs across every account", async () => {
    const report = await reconcileAll(ctx.billing, ctx.payments, ctx.db, ctx.table);
    expect(report.accountsChecked).toBeGreaterThanOrEqual(4);
  });
});
