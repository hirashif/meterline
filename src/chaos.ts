import { PutCommand, type DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { keys } from "./db.js";
import { monthOf } from "./billing.js";

// Demo only, off unless ENABLE_CHAOS=1. Writes a usage charge straight into
// the table without touching the balance or the unit counter, the way a bug or
// a bad manual fix would. Reconciliation should catch it.
export async function injectUnbilledCharge(
  db: DynamoDBDocumentClient,
  table: string,
  accountId: string,
  now: Date = new Date(),
): Promise<string> {
  const idempotencyKey = `chaos-${now.getTime()}`;
  await db.send(
    new PutCommand({
      TableName: table,
      Item: {
        pk: keys.pk(accountId),
        sk: keys.event(idempotencyKey),
        type: "event",
        idempotencyKey,
        product: "eligibility",
        month: monthOf(now),
        billable: true,
        chargedCents: 30,
        createdAt: now.toISOString(),
      },
    }),
  );
  return idempotencyKey;
}
