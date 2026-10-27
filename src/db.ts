import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";

// One table holds everything for an account, keyed by pk = "ACCT#<id>":
//
//   sk = "META"                      the account: balance, status, recharge settings
//   sk = "COUNT#<product>#<YYYY-MM>" billable units used this month (drives tier pricing)
//   sk = "EVENT#<idempotencyKey>"    one row per usage event, written exactly once
//   sk = "TOPUP#<paymentId>"         one row per successful payment credited to the balance
//   sk = "RECHARGE_FAIL#<seq>"       a declined auto-recharge
//
// Keeping an account's rows under one partition key lets a single query pull
// everything reconciliation needs for that account.

export const TABLE_NAME = process.env.TABLE_NAME ?? "usage-billing";

export function makeDocClient(): DynamoDBDocumentClient {
  const endpoint = process.env.DYNAMO_ENDPOINT ?? "http://localhost:8000";
  const local = !endpoint.includes("amazonaws.com");
  const client = new DynamoDBClient(
    local
      ? {
          endpoint,
          region: "us-east-1",
          credentials: { accessKeyId: "local", secretAccessKey: "local" },
        }
      : { endpoint },
  );
  return DynamoDBDocumentClient.from(client, {
    marshallOptions: { removeUndefinedValues: true },
  });
}

export const keys = {
  pk: (accountId: string) => `ACCT#${accountId}`,
  meta: "META",
  counter: (product: string, month: string) => `COUNT#${product}#${month}`,
  event: (idempotencyKey: string) => `EVENT#${idempotencyKey}`,
  topup: (paymentId: string) => `TOPUP#${paymentId}`,
  rechargeFail: (seq: number) => `RECHARGE_FAIL#${String(seq).padStart(6, "0")}`,
};
