import type { CheckoutSession } from './types';

// What a surface should render, derived purely from (server session, the
// price this fan has agreed to on this surface). One `kind` per screen state.
export type CheckoutView =
  | { kind: 'COMPLETED'; session: CheckoutSession }
  | { kind: 'FAILED'; session: CheckoutSession }
  | { kind: 'EXPIRED'; session: CheckoutSession }
  | { kind: 'PRICE_CHANGED'; session: CheckoutSession; fromPrice: number; toPrice: number }
  | { kind: 'PENDING_PAYMENT'; session: CheckoutSession }
  | { kind: 'READY'; session: CheckoutSession };
