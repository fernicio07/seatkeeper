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

/** Real time plus an offset: the dev server runs on wall-clock time, but the
 *  demo can "fast-forward" past expiresAt without waiting minutes. */
export class OffsetClock implements Clock {
  private offsetMs = 0;
  now(): number {
    return Date.now() + this.offsetMs;
  }
  advance(ms: number): void {
    this.offsetMs += ms;
  }
}

export const DEMO_LISTINGS: Listing[] = [
  {
    id: 'lst_heat_1',
    eventName: 'Miami Heat vs. Boston Celtics',
    venue: 'Kaseya Center, Miami',
    eventDate: '2026-11-14T00:30:00.000Z',
    section: '112',
    row: 'F',
    seat: '7',
    price: 18500,
  },
];

type HoldState = 'active' | 'frozen' | 'sold' | 'released';

export class StubInventoryService implements InventoryService {
  private listings = new Map<string, Listing>();
  private holds = new Map<string, { listingId: string; state: HoldState; expiresAt: number }>();

  constructor(
    private clock: Clock,
    private seed: Listing[] = DEMO_LISTINGS,
  ) {
    this.reset();
  }

  async getListing(listingId: string): Promise<Listing | null> {
    const l = this.listings.get(listingId);
    return l ? { ...l } : null;
  }

  async isAvailable(listingId: string): Promise<boolean> {
    return !this.blockingHold(listingId);
  }

  // Exclusive: one live hold (or sale) per seat. In a real store this check
  // and the insert are one atomic operation (e.g. Redis SET NX PX); here there
  // is no await between them, so it's atomic in single-threaded Node.
  async hold(listingId: string, expiresAt: number): Promise<string | null> {
    if (!this.listings.has(listingId)) throw new Error(`Unknown listing ${listingId}`);
    if (this.blockingHold(listingId)) return null;
    const holdId = `hold_${randomUUID()}`;
    this.holds.set(holdId, { listingId, state: 'active', expiresAt });
    return holdId;
  }

  async freeze(holdId: string): Promise<void> {
    const h = this.holds.get(holdId);
    if (h && this.isLive(h)) h.state = 'frozen';
  }

  async confirm(holdId: string): Promise<void> {
    const h = this.holds.get(holdId);
    if (h && h.state !== 'released') h.state = 'sold';
  }

  async release(holdId: string): Promise<void> {
    const h = this.holds.get(holdId);
    if (h && h.state !== 'sold') h.state = 'released';
  }

  async isHoldValid(holdId: string): Promise<boolean> {
    const h = this.holds.get(holdId);
    return !!h && this.isLive(h);
  }

  private isLive(h: { state: HoldState; expiresAt: number }): boolean {
    if (h.state === 'frozen' || h.state === 'sold') return true;
    return h.state === 'active' && this.clock.now() < h.expiresAt;
  }

  private blockingHold(listingId: string) {
    for (const h of this.holds.values()) if (h.listingId === listingId && this.isLive(h)) return h;
    return undefined;
  }

  // --- demo / test controls (exposed via dev-only routes) ---

  setPrice(listingId: string, price: number): void {
    const l = this.listings.get(listingId);
    if (!l) throw new Error(`Unknown listing ${listingId}`);
    l.price = price;
  }

  /** Simulate stale inventory: the seat was sold out from under the hold. */
  revokeHold(holdId: string): void {
    const h = this.holds.get(holdId);
    if (h) h.state = 'released';
  }

  /** Back to seed prices, no holds, nothing sold. */
  reset(): void {
    this.listings = new Map(this.seed.map((l) => [l.id, { ...l }]));
    this.holds.clear();
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
