import type { CheckoutSession } from './types';
import type { CheckoutView } from './view-types';

export function deriveCheckoutView(
  session: CheckoutSession,
  acceptedPrice: number
): CheckoutView {
  // 1. COMPLETED outranks everything
  if (session.status === 'COMPLETED') {
    return { kind: 'COMPLETED', session };
  }

  // 2. FAILED is terminal recovery
  if (session.status === 'FAILED') {
    return { kind: 'FAILED', session };
  }

  // 3. EXPIRED outranks price checks
  if (session.status === 'EXPIRED') {
    return { kind: 'EXPIRED', session };
  }

  // 4. PRICE_CHANGED / PENDING_PAYMENT price check
  // If price differs from accepted price, block/require acknowledgment
  if (session.currentPrice !== acceptedPrice) {
    return {
      kind: 'PRICE_CHANGED',
      session,
      fromPrice: acceptedPrice,
      toPrice: session.currentPrice,
    };
  }

  // 5. PENDING_PAYMENT ready to place order (when price is acknowledged)
  if (session.status === 'PENDING_PAYMENT') {
    return { kind: 'PENDING_PAYMENT', session };
  }

  // 6. Normal ACTIVE state ready to pay
  return { kind: 'READY', session };
}
