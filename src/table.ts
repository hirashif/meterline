import { CreateTableCommand, DeleteTableCommand, ResourceInUseException } from "@aws-sdk/client-dynamodb";

// Anything with a send() method: the plain client or the document client.
type Sender = { send(command: any): Promise<unknown> };

// Creates the single table (pk + sk, on-demand billing). Used by the local
// setup script and by the integration tests, which each get their own table.
export async function createTable(db: Sender, table: string): Promise<void> {
  try {
    await db.send(
      new CreateTableCommand({
        TableName: table,
        BillingMode: "PAY_PER_REQUEST",
        AttributeDefinitions: [
          { AttributeName: "pk", AttributeType: "S" },
          { AttributeName: "sk", AttributeType: "S" },
        ],
        KeySchema: [
          { AttributeName: "pk", KeyType: "HASH" },
          { AttributeName: "sk", KeyType: "RANGE" },
        ],
      }),
    );
  } catch (err) {
    if (!(err instanceof ResourceInUseException)) throw err;
  }
}

export async function deleteTable(db: Sender, table: string): Promise<void> {
  await db.send(new DeleteTableCommand({ TableName: table })).catch(() => undefined);
}
