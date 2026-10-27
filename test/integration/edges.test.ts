import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DECLINING_CARD } from "../../src/payments.js";
import { reconcileAccount } from "../../src/reconcile.js";
import { buildStatement } from "../../src/statement.js";
import { keysFor, setup } from "../helpers.js";

// A clock the tests can move.
let current = new Date("2026-10-31T23:59:00Z");
let ctx: Awaited<ReturnType<typeof setup>>;
beforeAll(async () => {
  ctx = await setup(() => current);
});
afterAll(async () => ctx.teardown());

describe("edges", () => {
  it("tiers reset at the start of each calendar month (UTC)", async () => {
    current = new Date("2026-10-31T23:59:00Z");
    const acct = await ctx.billing.createAccount({ startingBalanceCents: 100_000 });
    for (const k of keysFor("oct", 260)) {
      await ctx.billing.recordUsage(acct.accountId, { idempotencyKey: k, product: "eligibility" });
    }
    const lastOct = await ctx.billing.recordUsage(acct.accountId, { idempotencyKey: "oct-last", product: "eligibility" });
    expect(lastOct).toMatchObject({ unitPosition: 261, chargedCents: 15 });

    current = new Date("2026-11-01T00:00:30Z");
    const firstNov = await ctx.billing.recordUsage(acct.accountId, { idempotencyKey: "nov-1", product: "eligibility" });
    expect(firstNov).toMatchObject({ unitPosition: 1, chargedCents: 30 });

    const oct = await buildStatement(ctx.billing, acct.accountId, "2026-10");
    const nov = await buildStatement(ctx.billing, acct.accountId, "2026-11");
    expect(oct.products[0].billableUnits).toBe(261);
    expect(nov.products[0].billableUnits).toBe(1);
    expect(await reconcileAccount(ctx.billing, ctx.payments, acct.accountId)).toEqual([]);
  });

  it("each product has its own tiers and its own counter", async () => {
    current = new Date("2026-10-15T12:00:00Z");
    const acct = await ctx.billing.createAccount({ startingBalanceCents: 100_000 });
    for (const k of keysFor("e", 251)) {
      await ctx.billing.recordUsage(acct.accountId, { idempotencyKey: k, product: "eligibility" });
    }
    const claim = await ctx.billing.recordUsage(acct.accountId, { idempotencyKey: "c1", product: "claims" });
    expect(claim).toMatchObject({ unitPosition: 1, chargedCents: 30 });
    const st = await buildStatement(ctx.billing, acct.accountId, "2026-10");
    expect(st.totalChargedCents).toBe(250 * 30 + 15 + 30);
  });

  it("a declined first payment creates no account", async () => {
    await expect(ctx.billing.createAccount({ paymentMethod: DECLINING_CARD })).rejects.toMatchObject({ status: 402 });
  });

  it("rejects bad input", async () => {
    const acct = await ctx.billing.createAccount();
    await expect(
      ctx.billing.recordUsage(acct.accountId, { idempotencyKey: "", product: "eligibility" }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      ctx.billing.recordUsage(acct.accountId, { idempotencyKey: "x", product: "dental" as any }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(ctx.billing.createAccount({ startingBalanceCents: -5 })).rejects.toMatchObject({ status: 400 });
    await expect(ctx.billing.topUp(acct.accountId, 10.5, "k")).rejects.toMatchObject({ status: 400 });
  });
});
