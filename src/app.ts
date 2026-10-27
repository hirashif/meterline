import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { Billing, monthOf } from "./billing.js";
import { injectUnbilledCharge } from "./chaos.js";
import { ValidationError } from "./errors.js";
import type { PaymentProvider } from "./payments.js";
import { dailyJob } from "./reconcile.js";
import { buildStatement } from "./statement.js";

// The HTTP routes, written as a plain function from request to response so the
// same code can sit behind a local Node server or a Lambda function URL.

export type Request = { method: string; path: string; query: URLSearchParams; headers: Record<string, string | undefined>; body: unknown };
export type Response = { status: number; body: unknown };

export type AppConfig = {
  db: DynamoDBDocumentClient;
  table: string;
  payments: PaymentProvider;
  apiKey: string;
  chaosEnabled: boolean;
};

export function makeApp(config: AppConfig) {
  const billing = new Billing({ db: config.db, table: config.table, payments: config.payments });

  const routes: [string, RegExp, (req: Request, params: string[]) => Promise<Response>][] = [
    ["POST", /^\/accounts$/, async (req) => ({ status: 201, body: await billing.createAccount(asObject(req.body)) })],
    ["GET", /^\/accounts\/([\w-]+)$/, async (_req, [id]) => ({ status: 200, body: await billing.getAccount(id) })],
    [
      "POST",
      /^\/accounts\/([\w-]+)\/usage$/,
      async (req, [id]) => ({ status: 200, body: await billing.recordUsage(id, asObject(req.body) as any) }),
    ],
    [
      "GET",
      /^\/accounts\/([\w-]+)\/statement$/,
      async (req, [id]) => {
        const month = req.query.get("month") ?? monthOf(new Date());
        if (!/^\d{4}-\d{2}$/.test(month)) throw new ValidationError("month must look like YYYY-MM");
        return { status: 200, body: await buildStatement(billing, id, month) };
      },
    ],
    [
      "POST",
      /^\/accounts\/([\w-]+)\/topup$/,
      async (req, [id]) => {
        const b = asObject(req.body);
        return { status: 200, body: await billing.topUp(id, Number(b.amountCents), String(b.idempotencyKey ?? "")) };
      },
    ],
    [
      "POST",
      /^\/accounts\/([\w-]+)\/payment-method$/,
      async (req, [id]) => ({
        status: 200,
        body: await billing.setPaymentMethod(id, String(asObject(req.body).paymentMethod ?? "")),
      }),
    ],
    [
      "POST",
      /^\/reconcile$/,
      async () => ({ status: 200, body: await dailyJob(billing, config.payments, config.db, config.table) }),
    ],
    [
      "POST",
      /^\/admin\/chaos$/,
      async (req) => {
        if (!config.chaosEnabled) return { status: 404, body: { error: "not found" } };
        const accountId = String(asObject(req.body).accountId ?? "");
        await billing.getAccount(accountId);
        const key = await injectUnbilledCharge(config.db, config.table, accountId);
        return { status: 200, body: { injected: key } };
      },
    ],
  ];

  return async function handle(req: Request): Promise<Response> {
    if (req.headers["x-api-key"] !== config.apiKey) return { status: 401, body: { error: "missing or wrong x-api-key" } };
    for (const [method, pattern, handler] of routes) {
      const match = req.path.match(pattern);
      if (match && req.method === method) {
        try {
          return await handler(req, match.slice(1));
        } catch (err) {
          const status = (err as { status?: number }).status;
          if (status) return { status, body: { error: (err as Error).message } };
          console.error(err);
          return { status: 500, body: { error: "internal error" } };
        }
      }
    }
    return { status: 404, body: { error: "not found" } };
  };
}

function asObject(body: unknown): Record<string, unknown> {
  if (body && typeof body === "object" && !Array.isArray(body)) return body as Record<string, unknown>;
  if (body === undefined || body === null || body === "") return {};
  throw new ValidationError("body must be a JSON object");
}
