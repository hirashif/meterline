import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { rechargeAmountFor } from "../../src/billing.js";
import { DECLINING_CARD, GOOD_CARD } from "../../src/payments.js";
import { keysFor, setup } from "../helpers.js";

let ctx: Awaited<ReturnType<typeof setup>>;
beforeAll(async () => {
  ctx = await setup();
});
afterAll(async () => ctx.teardown());

describe("rechargeAmountFor", () => {
  it("uses one recharge when that is enough, more when the balance is far below", () => {
    expect(rechargeAmountFor(990, 1_000, 2_500)).toBe(2_500);
    expect(rechargeAmountFor(-4_000, 1_000, 2_500)).toBe(5_000 + 2_500);
    // exactly reaching the trigger is not enough; it must end above it
    expect(rechargeAmountFor(-1_500, 1_000, 2_500)).toBe(5_000);
  });
});

describe("auto-recharge", () => {
  it("recharges once when usage crosses the trigger", async () => {
    // $10.50 balance, $10 trigger: the second 30-cent unit crosses it.
    const acct = await ctx.billing.createAccount({ startingBalanceCents: 1_050 });
    await ctx.billing.recordUsage(acct.accountId, { idempotencyKey: "u1", product: "eligibility" });
    const res = await ctx.billing.recordUsage(acct.accountId, { idempotencyKey: "u2", product: "eligibility" });
    expect(res.recharge).toMatchObject({ status: "succeeded", amountCents: 2_500 });
    expect(res.balanceCents).toBe(1_050 - 60 + 2_500);
    expect(ctx.payments.chargesFor(acct.accountId, "recharge")).toHaveLength(1);
  });

  it("a declined recharge is recorded once, usage continues, and the account suspends at $0", async () => {
    const acct = await ctx.billing.createAccount({
      startingBalanceCents: 1_050,
      rechargeTriggerCents: 1_000,
    });
    await ctx.billing.setPaymentMethod(acct.accountId, DECLINING_CARD);

    // 35 units x 30 cents = $10.50: walks the balance from $10.50 to $0.
    let last;
    for (const k of keysFor("drain", 35)) {
      last = await ctx.billing.recordUsage(acct.accountId, { idempotencyKey: k, product: "eligibility" });
    }
    expect(last!.balanceCents).toBe(0);
    expect(last!.status).toBe("suspended");
    // One declined attempt, not one per call.
    expect(ctx.payments.chargesFor(acct.accountId, "recharge")).toHaveLength(1);

    await expect(
      ctx.billing.recordUsage(acct.accountId, { idempotencyKey: "after-suspend", product: "eligibility" }),
    ).rejects.toMatchObject({ status: 402 });

    // New card: one immediate recharge, account comes back.
    const { account, recharge } = await ctx.billing.setPaymentMethod(acct.accountId, GOOD_CARD);
    expect(recharge).toMatchObject({ status: "succeeded" });
    expect(account.status).toBe("active");
    expect(account.balanceCents).toBe(2_500);
  });

  it("a declined manual top-up is refused, and a repeated top-up key charges once", async () => {
    const acct = await ctx.billing.createAccount();
    await ctx.billing.setPaymentMethod(acct.accountId, DECLINING_CARD);
    await expect(ctx.billing.topUp(acct.accountId, 1_000, "t1")).rejects.toMatchObject({ status: 402 });

    await ctx.billing.setPaymentMethod(acct.accountId, GOOD_CARD);
    await ctx.billing.topUp(acct.accountId, 1_000, "t2");
    await ctx.billing.topUp(acct.accountId, 1_000, "t2");
    expect(ctx.payments.chargesFor(acct.accountId, "manual").filter((c) => c.status === "succeeded")).toHaveLength(1);
    expect((await ctx.billing.getAccount(acct.accountId)).balanceCents).toBe(3_500);
  });

});
