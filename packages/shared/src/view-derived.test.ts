import type { CheckoutSession } from './types';
import { deriveCheckoutView } from './view-derived';

// Local factory: shared must not import from apps/* (dependencies point inward).
function session(overrides: Partial<CheckoutSession> = {}): CheckoutSession {
  return {
    id: 'cs_test',
    listingId: 'lst_heat_1',
    priceAtStart: 18500,
    currentPrice: 18500,
    status: 'ACTIVE',
    expiresAt: 0,
    inventoryHoldId: 'hold_test',
    version: 1,
    idempotencyKey: 'idem_test',
    orderId: null,
    ...overrides,
  };
}

describe('deriveCheckoutView: precedence', () => {
  it('COMPLETED wins regardless of price', () => {
    const s = session({ status: 'COMPLETED', currentPrice: 21000 });
    expect(deriveCheckoutView(s, 18500).kind).toBe('COMPLETED');
  });

  it('FAILED', () => {
    expect(deriveCheckoutView(session({ status: 'FAILED' }), 18500).kind).toBe('FAILED');
  });

  it('EXPIRED wins even when acceptedPrice differs (terminal beats banner)', () => {
    const s = session({ status: 'EXPIRED', currentPrice: 21000 });
    expect(deriveCheckoutView(s, 18500).kind).toBe('EXPIRED');
  });

  it('ACTIVE + acceptedPrice !== currentPrice → PRICE_CHANGED { from: accepted, to: current }', () => {
    const s = session({ currentPrice: 21000 });
    expect(deriveCheckoutView(s, 18500)).toEqual({
      kind: 'PRICE_CHANGED',
      session: s,
      fromPrice: 18500,
      toPrice: 21000,
    });
  });

  it('ACTIVE + acceptedPrice === currentPrice → READY', () => {
    expect(deriveCheckoutView(session(), 18500).kind).toBe('READY');
  });

  it('PENDING_PAYMENT at the accepted price → PENDING_PAYMENT', () => {
    expect(deriveCheckoutView(session({ status: 'PENDING_PAYMENT' }), 18500).kind).toBe('PENDING_PAYMENT');
  });

  it('PENDING_PAYMENT at a price this surface never accepted → PRICE_CHANGED (the cross-surface gap)', () => {
    // Fan accepted 210 and paid on mobile; this stale web tab only ever agreed to 185.
    const s = session({ status: 'PENDING_PAYMENT', currentPrice: 21000 });
    expect(deriveCheckoutView(s, 18500)).toMatchObject({ kind: 'PRICE_CHANGED', fromPrice: 18500, toPrice: 21000 });
  });
});

describe('deriveCheckoutView: price scenarios from the design table', () => {
  it('price drop is still PRICE_CHANGED (block on decreases)', () => {
    expect(deriveCheckoutView(session({ currentPrice: 16000 }), 18500)).toMatchObject({
      kind: 'PRICE_CHANGED',
      fromPrice: 18500,
      toPrice: 16000,
    });
  });

  it('after ack at 210, a second bump to 230 → PRICE_CHANGED from 210 to 230', () => {
    expect(deriveCheckoutView(session({ currentPrice: 23000 }), 21000)).toMatchObject({
      kind: 'PRICE_CHANGED',
      fromPrice: 21000,
      toPrice: 23000,
    });
  });

  it('185 → 210 → 185 before acting → READY (this surface never showed 210)', () => {
    expect(deriveCheckoutView(session({ currentPrice: 18500 }), 18500).kind).toBe('READY');
  });

  it('mobile opened after a bump (acceptedPrice starts at priceAtStart) → PRICE_CHANGED', () => {
    const s = session({ priceAtStart: 18500, currentPrice: 21000 });
    expect(deriveCheckoutView(s, s.priceAtStart).kind).toBe('PRICE_CHANGED');
  });

  it('is pure: same inputs, same output, input untouched', () => {
    const s = session({ currentPrice: 21000 });
    const snapshot = structuredClone(s);
    expect(deriveCheckoutView(s, 18500)).toEqual(deriveCheckoutView(s, 18500));
    expect(s).toEqual(snapshot);
  });
});
