// Errors the HTTP layer turns into status codes.

export class ValidationError extends Error {
  status = 400;
}

export class NotFoundError extends Error {
  status = 404;
}

// The account is suspended (balance ran out). New usage is refused with 402.
export class AccountSuspendedError extends Error {
  status = 402;
}

// A top-up or account-funding charge was declined.
export class PaymentFailedError extends Error {
  status = 402;
}

// Same idempotency key sent again with a different body.
export class IdempotencyConflictError extends Error {
  status = 409;
}

export function isConditionalFailure(err: unknown): boolean {
  return (err as { name?: string })?.name === "ConditionalCheckFailedException";
}

// For TransactWriteItems: which items failed and why, in request order.
export function cancellationCodes(err: unknown): string[] | null {
  const e = err as { name?: string; CancellationReasons?: { Code?: string }[] };
  if (e?.name !== "TransactionCanceledException") return null;
  return (e.CancellationReasons ?? []).map((r) => r.Code ?? "None");
}
