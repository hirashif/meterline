// End-to-end demo. Prints a narrated log of the whole billing story.
//
// By default it runs in-process against DynamoDB Local (npm run db:up) with the
// in-memory payment processor and the chaos route on. Set BASE_URL to run the
// same script against a deployed instance instead.

import { makeApp } from "../src/app.js";
import { makeDocClient } from "../src/db.js";
import { FakePayments } from "../src/payments.js";
import { createTable } from "../src/table.js";

const BASE = process.env.BASE_URL;
const KEY = process.env.API_KEY ?? "local-dev-key";

let local: ReturnType<typeof makeApp> | undefined;
if (!BASE) {
  const db = makeDocClient();
  const table = `demo-${Date.now()}`;
  await createTable(db, table);
  local = makeApp({ db, table, payments: new FakePayments(), apiKey: KEY, chaosEnabled: true });
}

async function call(method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> {
  if (local) {
    const [pathname, search = ""] = path.split("?");
    return local({ method, path: pathname, query: new URLSearchParams(search), headers: { "x-api-key": KEY }, body });
  }
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { "content-type": "application/json", "x-api-key": KEY },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

const dollars = (cents: number) => `${cents < 0 ? "-" : ""}$${(Math.abs(cents) / 100).toFixed(2)}`;
const say = (msg = "") => console.log(msg);
const step = (n: number, title: string) => say(`\n${n}. ${title}\n${"-".repeat(title.length + 3)}`);

step(1, "Create an account: $25 prepaid, recharge $25 when the balance drops below $10");
const created = await call("POST", "/accounts", {});
const id = created.body.accountId as string;
say(`   ${id}  balance ${dollars(created.body.balanceCents)}`);

step(2, "Send 300 eligibility checks, plus 20 retries of earlier requests and 15 free events");
let duplicates = 0;
let recharges = 0;
for (let i = 1; i <= 300; i++) {
  const r = await call("POST", `/accounts/${id}/usage`, { idempotencyKey: `check-${i}`, product: "eligibility" });
  if (r.body.recharge?.status === "succeeded") {
    recharges++;
    say(`   check ${i}: balance fell below $10, recharged ${dollars(r.body.recharge.amountCents)} -> ${dollars(r.body.balanceCents)}`);
  }
  if (i % 15 === 0) {
    const retry = await call("POST", `/accounts/${id}/usage`, { idempotencyKey: `check-${i}`, product: "eligibility" });
    if (retry.body.duplicate) duplicates++;
  }
}
for (let i = 1; i <= 15; i++) {
  const outcome = i % 3 === 0 ? { httpStatus: 500 } : i % 3 === 1 ? { resultCode: "AAA42" } : { testMode: true };
  await call("POST", `/accounts/${id}/usage`, { idempotencyKey: `free-${i}`, product: "eligibility", ...outcome });
}
say(`   ${duplicates} retries answered with the original charge, nothing charged twice`);
say(`   ${recharges} automatic recharges`);

step(3, "Monthly statement");
const st = (await call("GET", `/accounts/${id}/statement`)).body;
for (const p of st.products) {
  say(`   ${p.product}: ${p.billableUnits} billable, ${p.nonBillableEvents} free`);
  for (const t of p.tiers) {
    say(`     units ${t.fromUnit}-${t.toUnit}: ${t.units} x ${t.centsPerUnit}c = ${dollars(t.subtotalCents)}`);
  }
  say(`     total ${dollars(p.chargedCents)}`);
}
say(`   paid in: ${dollars(st.topUpTotalCents)} across ${st.topUps.length} payments`);

step(4, "Switch to a card that declines, keep sending usage until the money runs out");
await call("POST", `/accounts/${id}/payment-method`, { paymentMethod: "pm_card_chargeDeclined" });
let n = 1000;
let last;
do {
  last = await call("POST", `/accounts/${id}/usage`, { idempotencyKey: `drain-${n++}`, product: "eligibility" });
  if (last.body.recharge?.status === "failed") say(`   recharge declined at ${dollars(last.body.balanceCents)}, usage keeps working until $0`);
} while (last.status === 200 && last.body.status === "active");
say(`   balance ${dollars(last.body.balanceCents)}, account ${last.body.status}`);
const refused = await call("POST", `/accounts/${id}/usage`, { idempotencyKey: `drain-${n}`, product: "eligibility" });
say(`   next request: HTTP ${refused.status} (${refused.body.error})`);

step(5, "Put a good card back on file");
const restored = (await call("POST", `/accounts/${id}/payment-method`, { paymentMethod: "pm_card_visa" })).body;
say(`   recharge ${restored.recharge?.status}, balance ${dollars(restored.account.balanceCents)}, account ${restored.account.status}`);

step(6, "Reconcile, then break something on purpose and reconcile again");
const clean = (await call("POST", "/reconcile")).body;
say(`   ${clean.accountsChecked} account(s) checked, ${clean.mismatches.length} mismatches`);
const chaos = await call("POST", "/admin/chaos", { accountId: id });
if (chaos.status !== 200) {
  say("   (chaos route is off; start the server with ENABLE_CHAOS=1 to see this step)");
} else {
  say("   wrote a usage charge without debiting the balance");
  const dirty = (await call("POST", "/reconcile")).body;
  for (const m of dirty.mismatches) {
    say(`   ${m.accountId}  ${m.check}: ${m.detail}. expected ${m.expected}, stored ${m.actual}`);
  }
}
say();
