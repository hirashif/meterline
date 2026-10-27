import { createServer } from "node:http";
import { makeApp } from "./app.js";
import { TABLE_NAME, makeDocClient } from "./db.js";
import { FakePayments } from "./payments.js";
import { createTable } from "./table.js";

// Local server: DynamoDB Local plus the in-memory payment processor.
const port = Number(process.env.PORT ?? 3000);
const db = makeDocClient();
await createTable(db, TABLE_NAME);

const handle = makeApp({
  db,
  table: TABLE_NAME,
  payments: new FakePayments(),
  apiKey: process.env.API_KEY ?? "local-dev-key",
  chaosEnabled: process.env.ENABLE_CHAOS === "1",
});

createServer(async (req, res) => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  let body: unknown;
  try {
    body = raw ? JSON.parse(raw) : undefined;
  } catch {
    res.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ error: "invalid JSON" }));
    return;
  }
  const url = new URL(req.url ?? "/", "http://localhost");
  const out = await handle({
    method: req.method ?? "GET",
    path: url.pathname,
    query: url.searchParams,
    headers: Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k, Array.isArray(v) ? v[0] : v])),
    body,
  });
  res.writeHead(out.status, { "content-type": "application/json" }).end(JSON.stringify(out.body));
}).listen(port, () => {
  console.log(`usage-billing listening on http://localhost:${port}`);
});
