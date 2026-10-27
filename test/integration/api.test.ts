import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeApp } from "../../src/app.js";
import { setup } from "../helpers.js";

let ctx: Awaited<ReturnType<typeof setup>>;
let handle: ReturnType<typeof makeApp>;
beforeAll(async () => {
  ctx = await setup();
  handle = makeApp({ db: ctx.db, table: ctx.table, payments: ctx.payments, apiKey: "k", chaosEnabled: false });
});
afterAll(async () => ctx.teardown());

const req = (method: string, path: string, body?: unknown, key = "k") => ({
  method,
  path,
  query: new URLSearchParams(),
  headers: { "x-api-key": key },
  body,
});

describe("HTTP routes", () => {
  it("requires the API key on every route", async () => {
    expect((await handle(req("GET", "/accounts/x", undefined, "wrong"))).status).toBe(401);
  });

  it("creates an account, records usage and returns 402 once suspended", async () => {
    const created = await handle(req("POST", "/accounts", { startingBalanceCents: 30, rechargeTriggerCents: 10, paymentMethod: "pm_card_visa" }));
    expect(created.status).toBe(201);
    const id = (created.body as any).accountId;
    await handle(req("POST", `/accounts/${id}/payment-method`, { paymentMethod: "pm_card_chargeDeclined" }));

    const used = await handle(req("POST", `/accounts/${id}/usage`, { idempotencyKey: "1", product: "eligibility" }));
    expect(used.status).toBe(200);
    expect((used.body as any).status).toBe("suspended");

    const refused = await handle(req("POST", `/accounts/${id}/usage`, { idempotencyKey: "2", product: "eligibility" }));
    expect(refused.status).toBe(402);
  });

  it("validates input and hides the chaos route when it is off", async () => {
    expect((await handle(req("POST", "/accounts/x/usage", { product: "eligibility" }))).status).toBe(400);
    expect((await handle(req("GET", "/accounts/nope"))).status).toBe(404);
    expect((await handle(req("POST", "/admin/chaos", { accountId: "x" }))).status).toBe(404);
  });
});
