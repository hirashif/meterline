import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { monthTotalCents, PRICING } from "../../src/pricing.js";
import { keysFor, setup } from "../helpers.js";

let ctx: Awaited<ReturnType<typeof setup>>;
beforeAll(async () => {
  ctx = await setup();
});
afterAll(async () => ctx.teardown());

describe("metering", () => {
  it("charges the first unit of the month at the tier-1 price", async () => {
    const acct = await ctx.billing.createAccount();
    expect(acct.balanceCents).toBe(2_500);

    const res = await ctx.billing.recordUsage(acct.accountId, { idempotencyKey: "a", product: "eligibility" });
    expect(res).toMatchObject({ duplicate: false, billable: true, unitPosition: 1, chargedCents: 30 });
    expect(res.balanceCents).toBe(2_470);
  });

  it("charges a retried event once and reports the original charge", async () => {
    const acct = await ctx.billing.createAccount();
    const first = await ctx.billing.recordUsage(acct.accountId, { idempotencyKey: "retry-me", product: "eligibility" });
    const again = await ctx.billing.recordUsage(acct.accountId, { idempotencyKey: "retry-me", product: "eligibility" });
    expect(again.duplicate).toBe(true);
    expect(again.chargedCents).toBe(first.chargedCents);
    expect(again.balanceCents).toBe(first.balanceCents);
  });

  it("rejects a reused key with a different body (409)", async () => {
    const acct = await ctx.billing.createAccount();
    await ctx.billing.recordUsage(acct.accountId, { idempotencyKey: "k", product: "eligibility" });
    await expect(
      ctx.billing.recordUsage(acct.accountId, { idempotencyKey: "k", product: "claims" }),
    ).rejects.toMatchObject({ status: 409 });
  });

  it("records non-billable events for free without using up tier-1 units", async () => {
    const acct = await ctx.billing.createAccount();
    for (const outcome of [{ testMode: true }, { resultCode: "AAA42" }, { httpStatus: 500 }]) {
      const res = await ctx.billing.recordUsage(acct.accountId, {
        idempotencyKey: `free-${JSON.stringify(outcome)}`,
        product: "eligibility",
        ...outcome,
      });
      expect(res).toMatchObject({ billable: false, chargedCents: 0, balanceCents: 2_500 });
    }
    const paid = await ctx.billing.recordUsage(acct.accountId, { idempotencyKey: "paid", product: "eligibility" });
    expect(paid.unitPosition).toBe(1);
  });

  it("50 concurrent events each get their own tier position, and the total matches the price table", async () => {
    const acct = await ctx.billing.createAccount({ startingBalanceCents: 100_000 });
    const results = await Promise.all(
      keysFor("burst", 50).map((idempotencyKey) =>
        ctx.billing.recordUsage(acct.accountId, { idempotencyKey, product: "eligibility" }),
      ),
    );
    const positions = results.map((r) => r.unitPosition).sort((a, b) => a! - b!);
    expect(positions).toEqual(Array.from({ length: 50 }, (_, i) => i + 1));

    const charged = results.reduce((sum, r) => sum + r.chargedCents, 0);
    expect(charged).toBe(monthTotalCents(PRICING.eligibility, 50));
    const after = await ctx.billing.getAccount(acct.accountId);
    expect(after.balanceCents).toBe(100_000 - charged);
  });

  it("crossing into tier 2 under concurrency prices units 251+ at 15 cents", async () => {
    const acct = await ctx.billing.createAccount({ startingBalanceCents: 100_000 });
    const keys = keysFor("cross", 300);
    // 240 sequentially, then the last 60 at once so the race happens across the tier boundary.
    for (const k of keys.slice(0, 240)) {
      await ctx.billing.recordUsage(acct.accountId, { idempotencyKey: k, product: "eligibility" });
    }
    await Promise.all(
      keys.slice(240).map((k) => ctx.billing.recordUsage(acct.accountId, { idempotencyKey: k, product: "eligibility" })),
    );
    const after = await ctx.billing.getAccount(acct.accountId);
    expect(100_000 - after.balanceCents).toBe(8_250); // $82.50
  });

  it("20 concurrent copies of the same event are charged once", async () => {
    const acct = await ctx.billing.createAccount();
    const results = await Promise.all(
      Array.from({ length: 20 }, () =>
        ctx.billing.recordUsage(acct.accountId, { idempotencyKey: "same", product: "eligibility" }),
      ),
    );
    expect(results.filter((r) => !r.duplicate)).toHaveLength(1);
    const after = await ctx.billing.getAccount(acct.accountId);
    expect(after.balanceCents).toBe(2_470);
  });
});
