import { randomUUID } from "node:crypto";
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { keys } from "./db.js";
import {
  AccountSuspendedError,
  IdempotencyConflictError,
  NotFoundError,
  PaymentFailedError,
  ValidationError,
  cancellationCodes,
  isConditionalFailure,
} from "./errors.js";
import { GOOD_CARD, type PaymentProvider } from "./payments.js";
import { PRICING, type Product, isBillable, isProduct, unitPriceCents } from "./pricing.js";

export type Account = {
  accountId: string;
  balanceCents: number;
  status: "active" | "suspended";
  rechargeTriggerCents: number;
  rechargeAmountCents: number;
  paymentMethod: string;
  // Set after a declined auto-recharge. No more automatic attempts until the
  // payment method changes or someone tops up by hand.
  rechargeFailed: boolean;
  // Number of auto-recharges finished (succeeded or failed). The next one is seq + 1.
  rechargeSeq: number;
  // A recharge in flight holds a lease until this time (epoch ms).
  leaseUntil?: number;
  // Amount of the recharge in flight. Kept so a retry after a crash asks the
  // processor for the exact same charge under the exact same idempotency key.
  pendingAmountCents?: number;
  createdAt: string;
};

export type UsageInput = {
  idempotencyKey: string;
  product: Product;
  testMode?: boolean;
  resultCode?: string;
  httpStatus?: number;
};

export type UsageEvent = UsageInput & {
  month: string;
  billable: boolean;
  unitPosition?: number;
  chargedCents: number;
  createdAt: string;
};

export type RechargeOutcome =
  | { status: "succeeded"; amountCents: number; paymentId: string }
  | { status: "failed"; amountCents: number; paymentId: string }
  | { status: "skipped" };

export type UsageResult = {
  duplicate: boolean;
  billable: boolean;
  unitPosition?: number;
  chargedCents: number;
  balanceCents: number;
  status: Account["status"];
  recharge?: RechargeOutcome;
};

export type CreateAccountInput = {
  startingBalanceCents?: number;
  rechargeTriggerCents?: number;
  rechargeAmountCents?: number;
  paymentMethod?: string;
};

const LEASE_MS = 2 * 60 * 1000;
const MAX_ATTEMPTS = 60;

export function monthOf(date: Date): string {
  return date.toISOString().slice(0, 7); // "YYYY-MM", UTC
}

// Smallest multiple of the recharge amount that lifts the balance back above
// the trigger. One $25 recharge is enough at $9; at -$40 it takes three.
export function rechargeAmountFor(balanceCents: number, triggerCents: number, amountCents: number): number {
  const multiples = Math.max(1, Math.floor((triggerCents - balanceCents) / amountCents) + 1);
  return multiples * amountCents;
}

export type BillingDeps = {
  db: DynamoDBDocumentClient;
  table: string;
  payments: PaymentProvider;
  now?: () => Date;
};

export class Billing {
  private db: DynamoDBDocumentClient;
  private table: string;
  private payments: PaymentProvider;
  private now: () => Date;

  constructor(deps: BillingDeps) {
    this.db = deps.db;
    this.table = deps.table;
    this.payments = deps.payments;
    this.now = deps.now ?? (() => new Date());
  }

  // ---------- accounts ----------

  async createAccount(input: CreateAccountInput = {}): Promise<Account> {
    const startingBalanceCents = input.startingBalanceCents ?? 2_500;
    const rechargeTriggerCents = input.rechargeTriggerCents ?? 1_000;
    const rechargeAmountCents = input.rechargeAmountCents ?? 2_500;
    for (const [name, v] of Object.entries({ startingBalanceCents, rechargeTriggerCents, rechargeAmountCents })) {
      if (!Number.isInteger(v) || v <= 0) throw new ValidationError(`${name} must be a positive integer of cents`);
    }

    const accountId = `acct_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
    const paymentMethod = input.paymentMethod ?? GOOD_CARD;

    // Fund the account first. If the card is declined, no account is created.
    const funding = await this.payments.charge({
      accountId,
      amountCents: startingBalanceCents,
      paymentMethod,
      idempotencyKey: `initial-${accountId}`,
      reason: "initial",
    });
    if (funding.status !== "succeeded") throw new PaymentFailedError("initial funding was declined");

    const account: Account = {
      accountId,
      balanceCents: 0,
      status: "active",
      rechargeTriggerCents,
      rechargeAmountCents,
      paymentMethod,
      rechargeFailed: false,
      rechargeSeq: 0,
      createdAt: this.now().toISOString(),
    };
    await this.db.send(
      new PutCommand({
        TableName: this.table,
        Item: { pk: keys.pk(accountId), sk: keys.meta, type: "account", ...account },
        ConditionExpression: "attribute_not_exists(pk)",
      }),
    );
    await this.creditTopUp(accountId, funding.id, startingBalanceCents, "initial");
    return this.getAccount(accountId);
  }

  async getAccount(accountId: string): Promise<Account> {
    const res = await this.db.send(
      new GetCommand({
        TableName: this.table,
        Key: { pk: keys.pk(accountId), sk: keys.meta },
        ConsistentRead: true,
      }),
    );
    if (!res.Item) throw new NotFoundError(`account ${accountId} not found`);
    return toAccount(res.Item);
  }

  // ---------- usage ----------

  // Records one usage event and charges for it, exactly once.
  //
  // Three writes commit together in one DynamoDB transaction, or none do:
  //   1. the event row, only if this idempotency key has never been seen;
  //   2. the month's unit counter, only if it still holds the value we read
  //      (that value decides the tier price of this unit);
  //   3. the balance debit, only if the account is active.
  // If another request moved the counter first, the transaction is cancelled and
  // we read again and retry, so every unit gets its own position and price.
  async recordUsage(accountId: string, input: UsageInput): Promise<UsageResult> {
    validateUsage(input);
    const billable = isBillable(input);
    const month = monthOf(this.now());
    const pk = keys.pk(accountId);

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const account = await this.getAccount(accountId);

      const existing = await this.getEvent(accountId, input.idempotencyKey);
      if (existing) return this.duplicateResult(account, existing, input);

      if (account.status !== "active") throw new AccountSuspendedError("account is suspended");

      let unitPosition: number | undefined;
      let chargedCents = 0;
      let previousUnits = 0;
      if (billable) {
        previousUnits = await this.getUnits(accountId, input.product, month);
        unitPosition = previousUnits + 1;
        chargedCents = unitPriceCents(PRICING[input.product], unitPosition);
      }

      const event: UsageEvent = {
        idempotencyKey: input.idempotencyKey,
        product: input.product,
        testMode: input.testMode,
        resultCode: input.resultCode,
        httpStatus: input.httpStatus,
        month,
        billable,
        unitPosition,
        chargedCents,
        createdAt: this.now().toISOString(),
      };

      const items: NonNullable<ConstructorParameters<typeof TransactWriteCommand>[0]["TransactItems"]> = [
        {
          Put: {
            TableName: this.table,
            Item: { pk, sk: keys.event(input.idempotencyKey), type: "event", ...event },
            ConditionExpression: "attribute_not_exists(sk)",
          },
        },
      ];

      if (billable) {
        items.push({
          Update: {
            TableName: this.table,
            Key: { pk, sk: keys.counter(input.product, month) },
            UpdateExpression: "SET #units = :next, #product = :product, #month = :month, #type = :type",
            ConditionExpression:
              previousUnits === 0 ? "attribute_not_exists(#units)" : "#units = :previous",
            ExpressionAttributeNames: {
              "#units": "units",
              "#product": "product",
              "#month": "month",
              "#type": "type",
            },
            ExpressionAttributeValues: {
              ":next": unitPosition,
              ":product": input.product,
              ":month": month,
              ":type": "counter",
              ...(previousUnits === 0 ? {} : { ":previous": previousUnits }),
            },
          },
        });
        items.push({
          Update: {
            TableName: this.table,
            Key: { pk, sk: keys.meta },
            UpdateExpression: "SET balanceCents = balanceCents - :charge",
            ConditionExpression: "#status = :active",
            ExpressionAttributeNames: { "#status": "status" },
            ExpressionAttributeValues: { ":charge": chargedCents, ":active": "active" },
          },
        });
      } else {
        // Free events still need an active account, but touch no money.
        items.push({
          ConditionCheck: {
            TableName: this.table,
            Key: { pk, sk: keys.meta },
            ConditionExpression: "#status = :active",
            ExpressionAttributeNames: { "#status": "status" },
            ExpressionAttributeValues: { ":active": "active" },
          },
        });
      }

      try {
        await this.db.send(new TransactWriteCommand({ TransactItems: items }));
      } catch (err) {
        const codes = cancellationCodes(err);
        if (!codes) throw err;
        if (codes[codes.length - 1] === "ConditionalCheckFailed") {
          throw new AccountSuspendedError("account is suspended");
        }
        // The event already exists (a concurrent duplicate won) or the counter
        // moved under us. Either way, back off briefly and go around again.
        await sleep(2 + Math.random() * 10);
        continue;
      }

      const recharge = billable ? await this.afterDebit(accountId) : undefined;
      const after = await this.getAccount(accountId);
      return {
        duplicate: false,
        billable,
        unitPosition,
        chargedCents,
        balanceCents: after.balanceCents,
        status: after.status,
        recharge,
      };
    }
    throw new Error("too much contention on this account; try again");
  }

  // ---------- recharge and suspension ----------

  // Runs after a debit commits: recharge if the balance fell below the trigger,
  // then suspend if the balance is at or below zero.
  private async afterDebit(accountId: string): Promise<RechargeOutcome | undefined> {
    let account = await this.getAccount(accountId);
    let recharge: RechargeOutcome | undefined;
    if (account.balanceCents < account.rechargeTriggerCents && !account.rechargeFailed) {
      recharge = await this.tryRecharge(account);
      account = await this.getAccount(accountId);
    }
    if (account.balanceCents <= 0 && account.status === "active") {
      await this.suspendIfEmpty(accountId);
    }
    return recharge;
  }

  // Only one recharge may be in flight per account. The caller that wins a
  // conditional write on the account row holds a 2-minute lease and does the
  // charge; everyone else skips. The processor call uses the idempotency key
  // "recharge-<account>-<seq>", so if this process dies after the charge
  // succeeds, the next attempt reuses the same seq and key, the processor
  // returns the original charge, and the top-up row (keyed by payment id) makes
  // sure the balance is credited once.
  async tryRecharge(account: Account): Promise<RechargeOutcome> {
    const nowMs = this.now().getTime();
    const amount = rechargeAmountFor(
      account.balanceCents,
      account.rechargeTriggerCents,
      account.rechargeAmountCents,
    );

    let claimed: Account;
    try {
      const res = await this.db.send(
        new UpdateCommand({
          TableName: this.table,
          Key: { pk: keys.pk(account.accountId), sk: keys.meta },
          UpdateExpression:
            "SET leaseUntil = :until, pendingAmountCents = if_not_exists(pendingAmountCents, :amount)",
          ConditionExpression:
            "(attribute_not_exists(leaseUntil) OR leaseUntil < :now) AND balanceCents < rechargeTriggerCents AND rechargeFailed = :false",
          ExpressionAttributeValues: {
            ":until": nowMs + LEASE_MS,
            ":now": nowMs,
            ":amount": amount,
            ":false": false,
          },
          ReturnValues: "ALL_NEW",
        }),
      );
      claimed = toAccount(res.Attributes!);
    } catch (err) {
      if (isConditionalFailure(err)) return { status: "skipped" };
      throw err;
    }

    const seq = claimed.rechargeSeq + 1;
    const amountCents = claimed.pendingAmountCents!;
    const charge = await this.payments.charge({
      accountId: account.accountId,
      amountCents,
      paymentMethod: claimed.paymentMethod,
      idempotencyKey: `recharge-${account.accountId}-${seq}`,
      reason: "recharge",
    });

    if (charge.status === "succeeded") {
      await this.creditTopUp(account.accountId, charge.id, amountCents, "recharge", seq);
      return { status: "succeeded", amountCents, paymentId: charge.id };
    }

    await this.recordFailedRecharge(account.accountId, seq, amountCents, charge.id);
    return { status: "failed", amountCents, paymentId: charge.id };
  }

  // Credits a successful payment to the balance exactly once. The top-up row is
  // keyed by the processor's payment id, so crediting the same payment twice is
  // impossible: the second transaction fails its condition.
  private async creditTopUp(
    accountId: string,
    paymentId: string,
    amountCents: number,
    kind: "initial" | "recharge" | "manual",
    completesRechargeSeq?: number,
  ): Promise<void> {
    const pk = keys.pk(accountId);
    const finishRecharge = completesRechargeSeq !== undefined;
    const set = ["balanceCents = balanceCents + :amount"];
    if (finishRecharge) set.push("rechargeSeq = :seq");
    if (kind === "manual") set.push("rechargeFailed = :false");
    const update =
      `SET ${set.join(", ")}` + (finishRecharge ? " REMOVE leaseUntil, pendingAmountCents" : "");

    try {
      await this.db.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Put: {
                TableName: this.table,
                Item: {
                  pk,
                  sk: keys.topup(paymentId),
                  type: "topup",
                  paymentId,
                  amountCents,
                  kind,
                  createdAt: this.now().toISOString(),
                },
                ConditionExpression: "attribute_not_exists(sk)",
              },
            },
            {
              Update: {
                TableName: this.table,
                Key: { pk, sk: keys.meta },
                UpdateExpression: update,
                ...(finishRecharge ? { ConditionExpression: "rechargeSeq = :previousSeq" } : {}),
                ExpressionAttributeValues: {
                  ":amount": amountCents,
                  ...(finishRecharge
                    ? { ":seq": completesRechargeSeq, ":previousSeq": completesRechargeSeq - 1 }
                    : {}),
                  ...(kind === "manual" ? { ":false": false } : {}),
                },
              },
            },
          ],
        }),
      );
    } catch (err) {
      const codes = cancellationCodes(err);
      // Already credited (a retry after a crash). Nothing to add.
      if (codes && codes[0] === "ConditionalCheckFailed") return;
      throw err;
    }
    await this.restoreIfPositive(accountId);
  }

  private async recordFailedRecharge(accountId: string, seq: number, amountCents: number, paymentId: string) {
    const pk = keys.pk(accountId);
    try {
      await this.db.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Put: {
                TableName: this.table,
                Item: {
                  pk,
                  sk: keys.rechargeFail(seq),
                  type: "recharge_failed",
                  seq,
                  amountCents,
                  paymentId,
                  createdAt: this.now().toISOString(),
                },
                ConditionExpression: "attribute_not_exists(sk)",
              },
            },
            {
              Update: {
                TableName: this.table,
                Key: { pk, sk: keys.meta },
                UpdateExpression:
                  "SET rechargeFailed = :true, rechargeSeq = :seq REMOVE leaseUntil, pendingAmountCents",
                ConditionExpression: "rechargeSeq = :previousSeq",
                ExpressionAttributeValues: { ":true": true, ":seq": seq, ":previousSeq": seq - 1 },
              },
            },
          ],
        }),
      );
    } catch (err) {
      if (cancellationCodes(err)) return; // already recorded by an earlier attempt
      throw err;
    }
  }

  private async suspendIfEmpty(accountId: string): Promise<void> {
    try {
      await this.db.send(
        new UpdateCommand({
          TableName: this.table,
          Key: { pk: keys.pk(accountId), sk: keys.meta },
          UpdateExpression: "SET #status = :suspended",
          ConditionExpression: "#status = :active AND balanceCents <= :zero",
          ExpressionAttributeNames: { "#status": "status" },
          ExpressionAttributeValues: { ":suspended": "suspended", ":active": "active", ":zero": 0 },
        }),
      );
    } catch (err) {
      if (!isConditionalFailure(err)) throw err;
    }
  }

  private async restoreIfPositive(accountId: string): Promise<void> {
    try {
      await this.db.send(
        new UpdateCommand({
          TableName: this.table,
          Key: { pk: keys.pk(accountId), sk: keys.meta },
          UpdateExpression: "SET #status = :active",
          ConditionExpression: "#status = :suspended AND balanceCents > :zero",
          ExpressionAttributeNames: { "#status": "status" },
          ExpressionAttributeValues: { ":suspended": "suspended", ":active": "active", ":zero": 0 },
        }),
      );
    } catch (err) {
      if (!isConditionalFailure(err)) throw err;
    }
  }

  // ---------- admin actions ----------

  // Manual top-up. Clears a failed-recharge flag and restores a suspended
  // account if the balance ends up positive.
  async topUp(accountId: string, amountCents: number, idempotencyKey: string): Promise<Account> {
    if (!Number.isInteger(amountCents) || amountCents <= 0) {
      throw new ValidationError("amountCents must be a positive integer");
    }
    if (!idempotencyKey) throw new ValidationError("idempotencyKey is required");
    const account = await this.getAccount(accountId);
    const charge = await this.payments.charge({
      accountId,
      amountCents,
      paymentMethod: account.paymentMethod,
      idempotencyKey: `topup-${accountId}-${idempotencyKey}`,
      reason: "manual",
    });
    if (charge.status !== "succeeded") throw new PaymentFailedError("top-up was declined");
    await this.creditTopUp(accountId, charge.id, amountCents, "manual");
    return this.getAccount(accountId);
  }

  // Changing the card clears the failed-recharge flag and tries one recharge
  // right away if the balance is below the trigger.
  async setPaymentMethod(accountId: string, paymentMethod: string): Promise<{ account: Account; recharge?: RechargeOutcome }> {
    if (!paymentMethod) throw new ValidationError("paymentMethod is required");
    await this.getAccount(accountId);
    await this.db.send(
      new UpdateCommand({
        TableName: this.table,
        Key: { pk: keys.pk(accountId), sk: keys.meta },
        UpdateExpression: "SET paymentMethod = :pm, rechargeFailed = :false",
        ExpressionAttributeValues: { ":pm": paymentMethod, ":false": false },
      }),
    );
    let account = await this.getAccount(accountId);
    let recharge: RechargeOutcome | undefined;
    if (account.balanceCents < account.rechargeTriggerCents) {
      recharge = await this.tryRecharge(account);
      account = await this.getAccount(accountId);
    }
    return { account, recharge };
  }

  // ---------- reads ----------

  async queryAll(accountId: string, skPrefix: string): Promise<Record<string, any>[]> {
    const items: Record<string, any>[] = [];
    let startKey: Record<string, any> | undefined;
    do {
      const res = await this.db.send(
        new QueryCommand({
          TableName: this.table,
          KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
          ExpressionAttributeValues: { ":pk": keys.pk(accountId), ":prefix": skPrefix },
          ConsistentRead: true,
          ExclusiveStartKey: startKey,
        }),
      );
      items.push(...(res.Items ?? []));
      startKey = res.LastEvaluatedKey;
    } while (startKey);
    return items;
  }

  private async getEvent(accountId: string, idempotencyKey: string): Promise<UsageEvent | undefined> {
    const res = await this.db.send(
      new GetCommand({
        TableName: this.table,
        Key: { pk: keys.pk(accountId), sk: keys.event(idempotencyKey) },
        ConsistentRead: true,
      }),
    );
    return res.Item as UsageEvent | undefined;
  }

  private async getUnits(accountId: string, product: Product, month: string): Promise<number> {
    const res = await this.db.send(
      new GetCommand({
        TableName: this.table,
        Key: { pk: keys.pk(accountId), sk: keys.counter(product, month) },
        ConsistentRead: true,
      }),
    );
    return (res.Item?.units as number | undefined) ?? 0;
  }

  // A retry of an event we already recorded: report the original charge, charge nothing.
  private duplicateResult(account: Account, existing: UsageEvent, input: UsageInput): UsageResult {
    const sameRequest =
      existing.product === input.product &&
      (existing.testMode ?? false) === (input.testMode ?? false) &&
      existing.resultCode === input.resultCode &&
      existing.httpStatus === input.httpStatus;
    if (!sameRequest) {
      throw new IdempotencyConflictError(
        `idempotency key ${input.idempotencyKey} was already used for a different request`,
      );
    }
    return {
      duplicate: true,
      billable: existing.billable,
      unitPosition: existing.unitPosition,
      chargedCents: existing.chargedCents,
      balanceCents: account.balanceCents,
      status: account.status,
    };
  }
}

function toAccount(item: Record<string, any>): Account {
  return {
    accountId: item.accountId,
    balanceCents: item.balanceCents,
    status: item.status,
    rechargeTriggerCents: item.rechargeTriggerCents,
    rechargeAmountCents: item.rechargeAmountCents,
    paymentMethod: item.paymentMethod,
    rechargeFailed: item.rechargeFailed ?? false,
    rechargeSeq: item.rechargeSeq ?? 0,
    leaseUntil: item.leaseUntil,
    pendingAmountCents: item.pendingAmountCents,
    createdAt: item.createdAt,
  };
}

function validateUsage(input: UsageInput): void {
  if (!input || typeof input.idempotencyKey !== "string" || input.idempotencyKey.length === 0) {
    throw new ValidationError("idempotencyKey is required");
  }
  if (input.idempotencyKey.length > 200) throw new ValidationError("idempotencyKey is too long");
  if (!isProduct(input.product)) throw new ValidationError(`unknown product ${String(input.product)}`);
  if (input.httpStatus !== undefined && !Number.isInteger(input.httpStatus)) {
    throw new ValidationError("httpStatus must be an integer");
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
