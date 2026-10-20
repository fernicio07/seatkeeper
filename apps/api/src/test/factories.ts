import type { CheckoutSession, EvaluationContext } from '@seatkeeper/shared';

export const T0 = Date.parse('2026-10-19T20:00:00.000Z');
export const TTL_MS = 10 * 60 * 1000;

export function makeSession(overrides: Partial<CheckoutSession> = {}): CheckoutSession {
  return {
    id: 'cs_test',
    listingId: 'lst_heat_1',
    priceAtStart: 18500,
    currentPrice: 18500,
    status: 'ACTIVE',
    expiresAt: T0 + TTL_MS,
    inventoryHoldId: 'hold_test',
    version: 1,
    idempotencyKey: 'idem_test',
    orderId: null,
    ...overrides,
  };
}

export function makeCtx(overrides: Partial<EvaluationContext> = {}): EvaluationContext {
  return { now: T0, currentPrice: 18500, holdValid: true, ...overrides };
}
