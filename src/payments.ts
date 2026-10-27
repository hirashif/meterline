// The payment processor, behind a small interface so the billing logic does not
// care whether it talks to Stripe or to the in-memory fake used in tests and the
// local demo.
//
// The fake copies the one Stripe behavior the design depends on: a request sent
// again with the same idempotency key returns the original result instead of
// charging again. That is what makes a retried recharge safe.

export const GOOD_CARD = "pm_card_visa";
export const DECLINING_CARD = "pm_card_chargeDeclined";

export type ChargeRequest = {
  accountId: string;
  amountCents: number;
  paymentMethod: string;
  idempotencyKey: string;
  reason: "initial" | "recharge" | "manual";
};

export type Charge = {
  id: string;
  accountId: string;
  amountCents: number;
  status: "succeeded" | "failed";
  reason: ChargeRequest["reason"];
  createdAt: string;
};

export interface PaymentProvider {
  charge(request: ChargeRequest): Promise<Charge>;
  // Every charge ever attempted for the account. Reconciliation compares the
  // succeeded ones against the top-ups recorded in the database.
  listCharges(accountId: string): Promise<Charge[]>;
}

export class FakePayments implements PaymentProvider {
  private byKey = new Map<string, { request: ChargeRequest; charge: Charge }>();
  private all: Charge[] = [];
  private nextId = 1;

  async charge(request: ChargeRequest): Promise<Charge> {
    const previous = this.byKey.get(request.idempotencyKey);
    if (previous) {
      if (
        previous.request.amountCents !== request.amountCents ||
        previous.request.accountId !== request.accountId
      ) {
        // Stripe rejects a reused key with different parameters, so the fake does too.
        throw new Error(`idempotency key ${request.idempotencyKey} reused with different parameters`);
      }
      return previous.charge;
    }

    const charge: Charge = {
      id: `pi_fake_${String(this.nextId++).padStart(5, "0")}`,
      accountId: request.accountId,
      amountCents: request.amountCents,
      status: request.paymentMethod === DECLINING_CARD ? "failed" : "succeeded",
      reason: request.reason,
      createdAt: new Date().toISOString(),
    };
    this.byKey.set(request.idempotencyKey, { request, charge });
    this.all.push(charge);
    return charge;
  }

  async listCharges(accountId: string): Promise<Charge[]> {
    return this.all.filter((c) => c.accountId === accountId);
  }

  // Test helper: how many times did we actually hit the processor for this account?
  chargesFor(accountId: string, reason?: ChargeRequest["reason"]): Charge[] {
    return this.all.filter((c) => c.accountId === accountId && (!reason || c.reason === reason));
  }
}
