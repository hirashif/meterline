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
import { GOOD_CARD, IdempotencyMismatchError, type PaymentProvider } from "./payments.js";
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
  // Card used by the recharge in flight, for the same reason.
  pendingPaymentMethod?: string;
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
const MAX_ATTEMPTS = 200;

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
      checkAmount(name, v);
    }
    if (input.paymentMethod !== undefined && typeof input.paymentMethod !== "string") {
      throw new ValidationError("paymentMethod must be a string");
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

    // The account row and the initial top-up row commit together, so an account
    // can never exist without the payment that funded it, or the other way round.
    const createdAt = this.now().toISOString();
    const account: Account = {
      accountId,
      balanceCents: startingBalanceCents,
      status: "active",
      rechargeTriggerCents,
      rechargeAmountCents,
      paymentMethod,
      rechargeFailed: false,
      rechargeSeq: 0,
      createdAt,
    };
    await this.db.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Put: {
              TableName: this.table,
              Item: { pk: keys.pk(accountId), sk: keys.meta, type: "account", ...account },
              ConditionExpression: "attribute_not_exists(pk)",
            },
          },
          {
            Put: {
              TableName: this.table,
              Item: {
                pk: keys.pk(accountId),
                sk: keys.topup(funding.id),
                type: "topup",
                paymentId: funding.id,
                amountCents: startingBalanceCents,
                kind: "initial",
                createdAt,
              },
              ConditionExpression: "attribute_not_exists(sk)",
            },
          },
        ],
      }),
    );
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

      if (account.status !== "active") {
        // Give a stuck recharge or a missed restore a chance before refusing.
        await this.settle(accountId);
        if ((await this.getAccount(accountId)).status !== "active") {
          throw new AccountSuspendedError("account is suspended");
        }
        continue;
      }

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
        await sleep(2 + Math.random() * Math.min(50, 10 + attempt * 2));
        continue;
      }

      const recharge = billable ? await this.settle(accountId) : undefined;
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

  // ---------- recharge, suspension and recovery ----------

  // Brings an account to a consistent state. Safe to call at any time, from any
  // number of processes at once:
  //   1. finish a recharge that a crashed process left half-done;
  //   2. otherwise, start a recharge if the balance is below the trigger and
  //      the card on file hasn't been declined;
  //   3. suspend at or below $0, restore above $0.
  // It runs after every billable event, before refusing usage on a suspended
  // account, after a card change or manual top-up, and in the daily job.
  async settle(accountId: string): Promise<RechargeOutcome | undefined> {
    let last: RechargeOutcome | undefined;
    // A declined recharge can be followed by one on a newly added card, so
    // allow a few rounds. Each round either makes progress or stops.
    for (let round = 0; round < 3; round++) {
      const account = await this.getAccount(accountId);
      const resume = account.pendingAmountCents !== undefined;
      const start =
        !resume && account.balanceCents < account.rechargeTriggerCents && !account.rechargeFailed;
      if (!resume && !start) break;
      last = await this.runRecharge(account);
      if (last.status !== "failed") break;
    }
    const account = await this.getAccount(accountId);
    if (account.balanceCents <= 0) await this.suspendIfEmpty(accountId);
    else await this.restoreIfPositive(accountId);
    return last;
  }

  // One auto-recharge, start to finish.
  //
  // Claim: a conditional write on the account row. Only one caller can claim
  // recharge number rechargeSeq + 1, and the claim stores the amount and the
  // card. Everyone else gets "skipped".
  //
  // Charge: the processor call uses the idempotency key
  // "recharge-<account>-<seq>". If this process dies after the card is charged,
  // the claim is left in place with an expired lease. The next settle() sees it
  // and repeats the exact same request with the same key, amount and card, so
  // the processor returns the original result instead of charging again.
  //
  // Record: the top-up row is keyed by the processor's payment id, so a payment
  // can be credited once and only once.
  private async runRecharge(account: Account): Promise<RechargeOutcome> {
    const nowMs = this.now().getTime();
    const resume = account.pendingAmountCents !== undefined;
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
          UpdateExpression: resume
            ? "SET leaseUntil = :until"
            : "SET leaseUntil = :until, pendingAmountCents = :amount, pendingPaymentMethod = paymentMethod",
          ConditionExpression: resume
            ? "attribute_exists(pendingAmountCents) AND rechargeSeq = :seq AND (attribute_not_exists(leaseUntil) OR leaseUntil < :now)"
            : "attribute_not_exists(pendingAmountCents) AND rechargeSeq = :seq AND balanceCents < rechargeTriggerCents AND rechargeFailed = :false",
          ExpressionAttributeValues: resume
            ? { ":until": nowMs + LEASE_MS, ":seq": account.rechargeSeq, ":now": nowMs }
            : { ":until": nowMs + LEASE_MS, ":seq": account.rechargeSeq, ":amount": amount, ":false": false },
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
    const paymentMethod = claimed.pendingPaymentMethod!;
    const charge = await this.payments.charge({
      accountId: account.accountId,
      amountCents,
      paymentMethod,
      idempotencyKey: `recharge-${account.accountId}-${seq}`,
      reason: "recharge",
    });

    if (charge.status === "succeeded") {
      await this.creditTopUp(account.accountId, charge.id, amountCents, "recharge", seq);
      return { status: "succeeded", amountCents, paymentId: charge.id };
    }
    await this.recordFailedRecharge(account.accountId, seq, amountCents, charge.id, paymentMethod);
    return { status: "failed", amountCents, paymentId: charge.id };
  }

  // Credits a successful payment to the balance exactly once. The top-up row is
  // keyed by the processor's payment id, so crediting the same payment twice is
  // impossible: the second transaction fails its condition.
  private async creditTopUp(
    accountId: string,
    paymentId: string,
    amountCents: number,
    kind: "recharge" | "manual",
    completesRechargeSeq?: number,
  ): Promise<void> {
    const pk = keys.pk(accountId);
    const finishRecharge = completesRechargeSeq !== undefined;
    const set = ["balanceCents = balanceCents + :amount"];
    if (finishRecharge) set.push("rechargeSeq = :seq");
    if (kind === "manual") set.push("rechargeFailed = :false");
    const update =
      `SET ${set.join(", ")}` +
      (finishRecharge ? " REMOVE leaseUntil, pendingAmountCents, pendingPaymentMethod" : "");

    const codes = await this.transact([
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
    ]);
    // codes[0] failed: this payment was already credited (a retry after a crash).
    if (codes && codes[0] !== "ConditionalCheckFailed") {
      throw new Error(`could not credit payment ${paymentId}: ${codes.join(",")}`);
    }
  }

  // A declined auto-recharge. If the card that was declined is still the card
  // on file, stop auto-recharging until the card changes or someone tops up.
  // If the card was changed while this charge was in flight, don't block the
  // new card: just close out this recharge so the next one can use it.
  private async recordFailedRecharge(
    accountId: string,
    seq: number,
    amountCents: number,
    paymentId: string,
    declinedPaymentMethod: string,
  ) {
    const pk = keys.pk(accountId);
    const failureRow = {
      Put: {
        TableName: this.table,
        Item: {
          pk,
          sk: keys.rechargeFail(seq),
          type: "recharge_failed",
          seq,
          amountCents,
          paymentId,
          paymentMethod: declinedPaymentMethod,
          createdAt: this.now().toISOString(),
        },
        ConditionExpression: "attribute_not_exists(sk)",
      },
    };
    const close = (blockCard: boolean) => ({
      Update: {
        TableName: this.table,
        Key: { pk, sk: keys.meta },
        UpdateExpression:
          (blockCard ? "SET rechargeFailed = :true, rechargeSeq = :seq" : "SET rechargeSeq = :seq") +
          " REMOVE leaseUntil, pendingAmountCents, pendingPaymentMethod",
        ConditionExpression: blockCard
          ? "rechargeSeq = :previousSeq AND paymentMethod = :declined"
          : "rechargeSeq = :previousSeq",
        ExpressionAttributeValues: {
          ":seq": seq,
          ":previousSeq": seq - 1,
          ...(blockCard ? { ":true": true, ":declined": declinedPaymentMethod } : {}),
        },
      },
    });

    let codes = await this.transact([failureRow, close(true)]);
    if (!codes || codes[0] === "ConditionalCheckFailed") return; // done, or already recorded
    // The card on file changed while the charge was in flight.
    codes = await this.transact([failureRow, close(false)]);
    if (codes && codes[0] !== "ConditionalCheckFailed") {
      throw new Error(`could not record failed recharge ${seq}: ${codes.join(",")}`);
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

  // Runs a transaction, retrying when it only lost a race with another
  // transaction on the same rows. Returns null on success, or the cancellation
  // codes (in request order) when one of its conditions failed.
  private async transact(
    items: NonNullable<ConstructorParameters<typeof TransactWriteCommand>[0]["TransactItems"]>,
  ): Promise<string[] | null> {
    for (let attempt = 0; attempt < 25; attempt++) {
      try {
        await this.db.send(new TransactWriteCommand({ TransactItems: items }));
        return null;
      } catch (err) {
        const codes = cancellationCodes(err);
        if (!codes) throw err;
        if (codes.includes("ConditionalCheckFailed")) return codes;
        await sleep(5 + Math.random() * 20);
      }
    }
    throw new Error("transaction kept conflicting; try again");
  }

  // ---------- admin actions ----------

  // Manual top-up. Clears a failed-recharge flag and restores a suspended
  // account if the balance ends up positive.
  async topUp(accountId: string, amountCents: number, idempotencyKey: string): Promise<Account> {
    checkAmount("amountCents", amountCents);
    if (!idempotencyKey) throw new ValidationError("idempotencyKey is required");
    const account = await this.getAccount(accountId);
    let charge;
    try {
      charge = await this.payments.charge({
        accountId,
        amountCents,
        paymentMethod: account.paymentMethod,
        idempotencyKey: `topup-${accountId}-${idempotencyKey}`,
        reason: "manual",
      });
    } catch (err) {
      if (err instanceof IdempotencyMismatchError) {
        throw new IdempotencyConflictError("this top-up key was already used with a different amount or card");
      }
      throw err;
    }
    if (charge.status !== "succeeded") throw new PaymentFailedError("top-up was declined");
    await this.creditTopUp(accountId, charge.id, amountCents, "manual");
    await this.settle(accountId);
    return this.getAccount(accountId);
  }

  // Changing the card clears the failed-recharge flag and settles the account,
  // which recharges right away if the balance is below the trigger.
  async setPaymentMethod(
    accountId: string,
    paymentMethod: string,
  ): Promise<{ account: Account; recharge?: RechargeOutcome }> {
    if (!paymentMethod || typeof paymentMethod !== "string") {
      throw new ValidationError("paymentMethod is required");
    }
    await this.getAccount(accountId);
    await this.db.send(
      new UpdateCommand({
        TableName: this.table,
        Key: { pk: keys.pk(accountId), sk: keys.meta },
        UpdateExpression: "SET paymentMethod = :pm, rechargeFailed = :false",
        ExpressionAttributeValues: { ":pm": paymentMethod, ":false": false },
      }),
    );
    const recharge = await this.settle(accountId);
    return { account: await this.getAccount(accountId), recharge };
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
    pendingPaymentMethod: item.pendingPaymentMethod,
    createdAt: item.createdAt,
  };
}

// Any single amount is capped at $100,000. Keeps every value a safe integer
// and catches typos before a card is charged.
export const MAX_AMOUNT_CENTS = 10_000_000;

function checkAmount(name: string, value: unknown): void {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0 || value > MAX_AMOUNT_CENTS) {
    throw new ValidationError(`${name} must be a whole number of cents between 1 and ${MAX_AMOUNT_CENTS}`);
  }
}

function validateUsage(input: UsageInput): void {
  if (!input || typeof input.idempotencyKey !== "string" || input.idempotencyKey.length === 0) {
    throw new ValidationError("idempotencyKey is required");
  }
  if (input.idempotencyKey.length > 200) throw new ValidationError("idempotencyKey is too long");
  if (!isProduct(input.product)) throw new ValidationError(`unknown product ${String(input.product)}`);
  if (input.testMode !== undefined && typeof input.testMode !== "boolean") {
    throw new ValidationError("testMode must be true or false");
  }
  if (input.resultCode !== undefined && (typeof input.resultCode !== "string" || input.resultCode.length > 20)) {
    throw new ValidationError("resultCode must be a short string");
  }
  if (
    input.httpStatus !== undefined &&
    (!Number.isInteger(input.httpStatus) || input.httpStatus < 100 || input.httpStatus > 599)
  ) {
    throw new ValidationError("httpStatus must be an HTTP status code");
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
