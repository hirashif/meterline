import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DECLINING_CARD, GOOD_CARD } from "../../src/payments.js";
import { dailyJob, reconcileAccount } from "../../src/reconcile.js";
import { keysFor, setup } from "../helpers.js";

// Crashes, races and recovery in the recharge path. The fake processor takes
// 150ms per charge here, so requests really overlap while a charge is in flight,
// and the clock can be moved past the 2-minute recharge lease.
let current = new Date("2026-10-15T12:00:00Z");
const advance = (ms: number) => (current = new Date(current.getTime() + ms));
let ctx: Awaited<ReturnType<typeof setup>>;
beforeAll(async () => {
  ctx = await setup(() => current, { delayMs: 150 });
});
afterAll(async () => ctx.teardown());

const use = (accountId: string, key: string) =>
  ctx.billing.recordUsage(accountId, { idempotencyKey: key, product: "eligibility" });

describe("only one recharge at a time", () => {
  it("a burst across the trigger never has two recharges in flight, and charges once", async () => {
    const acct = await ctx.billing.createAccount({ startingBalanceCents: 1_100 });
    ctx.payments.maxInFlight = 0;
    await Promise.all(keysFor("burst", 20).map((k) => use(acct.accountId, k)));
    expect(ctx.payments.maxInFlight).toBe(1);
    expect(ctx.payments.chargesFor(acct.accountId, "recharge")).toHaveLength(1);
    const after = await ctx.billing.getAccount(acct.accountId);
    expect(after.balanceCents).toBe(1_100 - 20 * 30 + 2_500);
    expect(after.pendingAmountCents).toBeUndefined();
  });
});

describe("crash after the card is charged", () => {
  it("the next request finishes the recharge with the same key and credits it once", async () => {
    const acct = await ctx.billing.createAccount({ startingBalanceCents: 1_020 });
    ctx.payments.crashAfterNextCharge = true;
    // 1,020 - 30 = 990: below the trigger. The card is charged, then the process "dies".
    await expect(use(acct.accountId, "u1")).rejects.toThrow(/simulated crash/);
    const stuck = await ctx.billing.getAccount(acct.accountId);
    expect(stuck.balanceCents).toBe(990);
    expect(stuck.pendingAmountCents).toBe(2_500);

    // Inside the lease, nobody else may touch it.
    await use(acct.accountId, "u2");
    expect((await ctx.billing.getAccount(acct.accountId)).balanceCents).toBe(960);

    // After the lease expires, the next request replays the same charge.
    advance(3 * 60 * 1000);
    const res = await use(acct.accountId, "u3");
    expect(res.recharge).toMatchObject({ status: "succeeded", amountCents: 2_500 });
    expect(res.balanceCents).toBe(930 + 2_500);
    expect(ctx.payments.chargesFor(acct.accountId, "recharge")).toHaveLength(1);
    expect(await reconcileAccount(ctx.billing, ctx.payments, acct.accountId)).toEqual([]);
  });

  it("an account that ran dry while the recharge was stuck comes back on its own", async () => {
    // The reviewer's case: $0.60 balance, $0.50 trigger.
    const acct = await ctx.billing.createAccount({
      startingBalanceCents: 60,
      rechargeTriggerCents: 50,
      rechargeAmountCents: 2_500,
    });
    ctx.payments.crashAfterNextCharge = true;
    await expect(use(acct.accountId, "a")).rejects.toThrow(/simulated crash/); // 30 left, charge stuck
    const drained = await use(acct.accountId, "b"); // lease held: skipped, balance hits 0
    expect(drained.status).toBe("suspended");
    await expect(use(acct.accountId, "c")).rejects.toMatchObject({ status: 402 });

    advance(3 * 60 * 1000);
    const back = await use(acct.accountId, "d");
    expect(back.status).toBe("active");
    expect(back.balanceCents).toBe(2_500 - 30);
    expect(ctx.payments.chargesFor(acct.accountId, "recharge")).toHaveLength(1);
    expect(await reconcileAccount(ctx.billing, ctx.payments, acct.accountId)).toEqual([]);
  });

  it("the daily job finishes a stuck recharge on an idle account", async () => {
    const acct = await ctx.billing.createAccount({ startingBalanceCents: 1_020 });
    ctx.payments.crashAfterNextCharge = true;
    await expect(use(acct.accountId, "x")).rejects.toThrow(/simulated crash/);
    expect((await reconcileAccount(ctx.billing, ctx.payments, acct.accountId))[0]).toMatchObject({ check: "payments" });

    advance(3 * 60 * 1000);
    const report = await dailyJob(ctx.billing, ctx.payments, ctx.db, ctx.table, current);
    expect(report.recoveredRecharges).toBeGreaterThanOrEqual(1);
    expect(report.mismatches.filter((m) => m.accountId === acct.accountId)).toEqual([]);
    expect((await ctx.billing.getAccount(acct.accountId)).balanceCents).toBe(990 + 2_500);
  });
});

describe("card changes while a recharge is in flight", () => {
  it("a decline that lands after the card was replaced does not block the new card", async () => {
    const acct = await ctx.billing.createAccount({ startingBalanceCents: 1_020 });
    await ctx.billing.setPaymentMethod(acct.accountId, DECLINING_CARD);

    // Start the declining recharge, and swap the card while it is still in flight.
    const inFlight = use(acct.accountId, "u1");
    await new Promise((r) => setTimeout(r, 40));
    await ctx.billing.setPaymentMethod(acct.accountId, GOOD_CARD);
    const res = await inFlight;

    const account = await ctx.billing.getAccount(acct.accountId);
    expect(account.rechargeFailed).toBe(false);
    // The request that saw the decline goes straight on to recharge the new card.
    expect(res.recharge).toMatchObject({ status: "succeeded" });
    expect(account.balanceCents).toBe(990 + 2_500);
    const good = ctx.payments.chargesFor(acct.accountId, "recharge").filter((c) => c.status === "succeeded");
    expect(good).toHaveLength(1);
  });

  it("after a crash during a declined charge, the new card is still tried", async () => {
    const acct = await ctx.billing.createAccount({ startingBalanceCents: 1_020 });
    await ctx.billing.setPaymentMethod(acct.accountId, DECLINING_CARD);
    ctx.payments.crashAfterNextCharge = true;
    await expect(use(acct.accountId, "u1")).rejects.toThrow(/simulated crash/); // decline never recorded

    await ctx.billing.setPaymentMethod(acct.accountId, GOOD_CARD);
    advance(3 * 60 * 1000);
    const { account, recharge } = await ctx.billing.setPaymentMethod(acct.accountId, GOOD_CARD);
    expect(recharge).toMatchObject({ status: "succeeded" });
    expect(account.rechargeFailed).toBe(false);
    expect(account.balanceCents).toBe(990 + 2_500);
    expect(await reconcileAccount(ctx.billing, ctx.payments, acct.accountId)).toEqual([]);
  });
});

describe("input that could have cost money", () => {
  it("testMode must be a real boolean, so a string can't make usage free", async () => {
    const acct = await ctx.billing.createAccount();
    await expect(
      ctx.billing.recordUsage(acct.accountId, { idempotencyKey: "t", product: "eligibility", testMode: "false" as any }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("amounts are capped before any card is charged", async () => {
    const acct = await ctx.billing.createAccount();
    const before = ctx.payments.chargesFor(acct.accountId).length;
    await expect(ctx.billing.topUp(acct.accountId, 1e20, "big")).rejects.toMatchObject({ status: 400 });
    await expect(ctx.billing.createAccount({ startingBalanceCents: 1e20 })).rejects.toMatchObject({ status: 400 });
    expect(ctx.payments.chargesFor(acct.accountId)).toHaveLength(before);
  });
});
