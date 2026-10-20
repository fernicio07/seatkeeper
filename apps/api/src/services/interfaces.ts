import type { Listing } from '@seatkeeper/shared';

// The seams to the outside world. Everything behind these is stubbed; the
// checkout logic only ever talks to the interfaces.

export interface InventoryService {
  getListing(listingId: string): Promise<Listing | null>;
  /** Reserve the seat for this checkout. Returns a holdId. */
  hold(listingId: string): Promise<string>;
  release(holdId: string): Promise<void>;
  /** False if the hold was released or revoked (e.g. seat sold elsewhere). */
  isHoldValid(holdId: string): Promise<boolean>;
}

export interface ChargeResult {
  status: 'succeeded' | 'declined';
  chargeId: string;
}

export interface PaymentGateway {
  /** Same idempotencyKey ⇒ same result, no second charge (Stripe semantics). */
  charge(params: { amount: number; idempotencyKey: string }): Promise<ChargeResult>;
}

export interface AnalyticsEvent {
  name: string;
  sessionId: string;
  at: number;
  props?: Record<string, unknown>;
}

export interface AnalyticsSink {
  /** Fire-and-forget. Must never throw into or block the checkout path. */
  track(event: AnalyticsEvent): void;
}

export interface Clock {
  now(): number;
}
