import type { Listing } from '@seatkeeper/shared';

// The seams to the outside world. Everything behind these is stubbed; the
// checkout logic only ever talks to the interfaces.

export interface InventoryService {
  getListing(listingId: string): Promise<Listing | null>;
  /** True when no live hold or sale blocks the seat. */
  isAvailable(listingId: string): Promise<boolean>;
  /**
   * Reserve the seat until `expiresAt` (the session's deadline — the session
   * stays the authority; the hold just mirrors it so an abandoned checkout
   * frees the seat even if nobody ever re-loads that session).
   * Returns a holdId, or null if the seat is already held or sold.
   */
  hold(listingId: string, expiresAt: number): Promise<string | null>;
  /** Payment in flight: the hold stops expiring until confirm() or release(). */
  freeze(holdId: string): Promise<void>;
  /** The hold becomes a sale. The seat is permanently unavailable. */
  confirm(holdId: string): Promise<void>;
  release(holdId: string): Promise<void>;
  /** False if released, revoked, or (unfrozen and) past its expiry. */
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
