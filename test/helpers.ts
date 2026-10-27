import { randomUUID } from "node:crypto";
import { Billing } from "../src/billing.js";
import { makeDocClient } from "../src/db.js";
import { FakePayments, type FakeOptions } from "../src/payments.js";
import { createTable, deleteTable } from "../src/table.js";

// Each test file gets a fresh table on DynamoDB Local (npm run db:up).
export async function setup(now?: () => Date, options: FakeOptions = {}) {
  const db = makeDocClient();
  const table = `test-${randomUUID().slice(0, 8)}`;
  await createTable(db, table);
  const payments = new FakePayments(options);
  const billing = new Billing({ db, table, payments, now });
  return {
    db,
    table,
    payments,
    billing,
    teardown: () => deleteTable(db, table),
  };
}

export function keysFor(prefix: string, n: number): string[] {
  return Array.from({ length: n }, (_, i) => `${prefix}-${i + 1}`);
}
