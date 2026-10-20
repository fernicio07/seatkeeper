import { randomUUID } from 'node:crypto';
import type { Listing } from '@seatkeeper/shared';
import type {
  AnalyticsEvent,
  AnalyticsSink,
  ChargeResult,
  Clock,
  InventoryService,
  PaymentGateway,
} from './interfaces';

export class SystemClock implements Clock {
  now(): number {
    return Date.now();
  }
}

/** Controllable time for tests and the demo's "fast-forward" button. */
export class StubClock implements Clock {
  constructor(private current: number = Date.now()) {}
  now(): number {
    return this.current;
  }
  set(ms: number): void {
    this.current = ms;
  }
  advance(ms: number): void {
    this.current += ms;
  }
}

export const DEMO_LISTINGS: Listing[] = [
  {
    id: 'lst_knicks_1',
    eventName: 'Knicks vs. Celtics',
    venue: 'Madison Square Garden',
    eventDate: '2026-11-14T00:30:00.000Z',
    section: '112',
    row: 'F',
    seat: '7',
    price: 18500,
  },
];

export class StubInventoryService implements InventoryService {
  private listings = new Map<string, Listing>();
  private holds = new Map<string, { listingId: string; active: boolean }>();

  constructor(listings: Listing[] = DEMO_LISTINGS) {
    for (const l of listings) this.listings.set(l.id, { ...l });
  }

  async getListing(listingId: string): Promise<Listing | null> {
    const l = this.listings.get(listingId);
    return l ? { ...l } : null;
  }

  // Holds have no TTL of their own here: the session's expiresAt is the single
  // authority on expiry. Two independent timers for one concept can disagree.
  async hold(listingId: string): Promise<string> {
    if (!this.listings.has(listingId)) throw new Error(`Unknown listing ${listingId}`);
    const holdId = `hold_${randomUUID()}`;
    this.holds.set(holdId, { listingId, active: true });
    return holdId;
  }

  async release(holdId: string): Promise<void> {
    const h = this.holds.get(holdId);
    if (h) h.active = false;
  }

  async isHoldValid(holdId: string): Promise<boolean> {
    return this.holds.get(holdId)?.active ?? false;
  }

  // --- demo / test controls (exposed via dev-only routes later) ---

  setPrice(listingId: string, price: number): void {
    const l = this.listings.get(listingId);
    if (!l) throw new Error(`Unknown listing ${listingId}`);
    l.price = price;
  }

  /** Simulate stale inventory: the seat was sold out from under the hold. */
  revokeHold(holdId: string): void {
    const h = this.holds.get(holdId);
    if (h) h.active = false;
  }
}

export class StubPaymentGateway implements PaymentGateway {
  private charges = new Map<string, { amount: number; result: ChargeResult }>();
  nextOutcome: ChargeResult['status'] = 'succeeded';
  /** Number of real (non-replayed) charges — lets tests assert "charged once". */
  chargeCount = 0;

  async charge({ amount, idempotencyKey }: { amount: number; idempotencyKey: string }) {
    const prior = this.charges.get(idempotencyKey);
    if (prior) {
      // Reusing a key with different params is a client bug — real gateways reject it.
      if (prior.amount !== amount) throw new Error('Idempotency key reused with different amount');
      return { ...prior.result };
    }
    const result: ChargeResult = { status: this.nextOutcome, chargeId: `ch_${randomUUID()}` };
    this.charges.set(idempotencyKey, { amount, result });
    this.chargeCount++;
    return { ...result };
  }
}

export class InMemoryAnalyticsSink implements AnalyticsSink {
  readonly events: AnalyticsEvent[] = [];
  constructor(private log = false) {}
  track(event: AnalyticsEvent): void {
    try {
      this.events.push(event);
      if (this.log) console.log(`[analytics] ${event.name}`, event.sessionId, event.props ?? '');
    } catch {
      // Analytics must never break checkout.
    }
  }
}
