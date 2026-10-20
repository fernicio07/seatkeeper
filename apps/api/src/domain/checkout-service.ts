import { randomUUID } from 'node:crypto';
import type {
  CheckoutEvent,
  CheckoutSession,
  Listing,
  TransitionErrorCode,
} from '@seatkeeper/shared';
import type { SessionStore } from '../store/session-store';
import type { AnalyticsSink, Clock, InventoryService, PaymentGateway } from '../services/interfaces';
import { evaluate, transition } from './checkout-machine';

// The imperative shell around the pure state machine. This layer owns all I/O:
// it gathers facts (clock, inventory), asks evaluate()/transition() what should
// happen, persists via compareAndSet, and performs side effects (hold release,
// charging, analytics). The machine decides; the service does.

export interface CheckoutDeps {
  store: SessionStore;
  inventory: InventoryService;
  payments: PaymentGateway;
  analytics: AnalyticsSink;
  clock: Clock;
  ttlMs: number;
}

export type ServiceErrorCode = TransitionErrorCode | 'NOT_FOUND' | 'LISTING_NOT_FOUND';

export type ServiceResult =
  | { ok: true; session: CheckoutSession; listing: Listing }
  | { ok: false; error: ServiceErrorCode; session?: CheckoutSession; listing?: Listing };

const MAX_REFRESH_ATTEMPTS = 3;

export class CheckoutService {
  constructor(private deps: CheckoutDeps) {}

  async create(listingId: string): Promise<ServiceResult> {
    const { store, inventory, clock, analytics, ttlMs } = this.deps;
    const listing = await inventory.getListing(listingId);
    if (!listing) return { ok: false, error: 'LISTING_NOT_FOUND' };

    const now = clock.now();
    const session = await store.create({
      id: `cs_${randomUUID()}`,
      listingId,
      priceAtStart: listing.price,
      currentPrice: listing.price,
      status: 'ACTIVE',
      expiresAt: now + ttlMs,
      inventoryHoldId: await inventory.hold(listingId),
      version: 1,
      idempotencyKey: `idem_${randomUUID()}`,
    });
    analytics.track({ name: 'checkout_started', sessionId: session.id, at: now });
    return { ok: true, session, listing };
  }

  /**
   * Load + evaluate + persist. Every read goes through here, which is what
   * makes "server recomputes validity on resume" true. If evaluate() changed
   * anything (expired, new price) we persist it — that bumps `version`, so any
   * client still holding the old version is now provably stale.
   */
  async load(id: string): Promise<ServiceResult> {
    const { store, inventory, clock } = this.deps;

    for (let attempt = 0; attempt < MAX_REFRESH_ATTEMPTS; attempt++) {
      const stored = await store.get(id);
      if (!stored) return { ok: false, error: 'NOT_FOUND' };
      const listing = await inventory.getListing(stored.listingId);
      if (!listing) return { ok: false, error: 'LISTING_NOT_FOUND', session: stored };

      const evaluated = evaluate(stored, {
        now: clock.now(),
        currentPrice: listing.price,
        holdValid: await inventory.isHoldValid(stored.inventoryHoldId),
      });
      if (sameState(stored, evaluated)) return { ok: true, session: stored, listing };

      const saved = await store.compareAndSet(id, stored.version, evaluated);
      if (saved) {
        await this.afterWrite(stored, saved);
        return { ok: true, session: saved, listing };
      }
      // Lost a race with another writer between get and CAS: re-read and retry.
    }
    throw new Error(`Could not refresh session ${id} after ${MAX_REFRESH_ATTEMPTS} attempts`);
  }

  async pay(id: string, input: { expectedVersion: number; acceptedPrice: number }) {
    return this.apply(id, { type: 'PAY', ...input });
  }

  async complete(id: string, input: { expectedVersion: number; idempotencyKey: string }) {
    const loaded = await this.load(id);
    if (!loaded.ok) return loaded;
    const { session, listing } = loaded;

    // Dry run BEFORE charging: transition() is pure, so we can ask "would a
    // successful charge be a legal transition?" without side effects. This
    // stops us charging a card for a session that's ACTIVE, expired, stale, or
    // already completed (replay — returned as-is, no second charge).
    const dryRun = transition(session, { type: 'COMPLETE', ...input, chargeOutcome: 'succeeded' });
    if (!dryRun.ok) return { ok: false as const, error: dryRun.error, session: dryRun.session, listing };
    if (sameState(session, dryRun.session)) return { ok: true as const, session, listing };

    const charge = await this.deps.payments.charge({
      amount: session.currentPrice,
      idempotencyKey: session.idempotencyKey,
    });
    return this.apply(id, { type: 'COMPLETE', ...input, chargeOutcome: charge.status }, loaded);
  }

  /** Run a fan intent through the machine and persist it with CAS. */
  private async apply(
    id: string,
    event: CheckoutEvent,
    preloaded?: Extract<ServiceResult, { ok: true }>,
  ): Promise<ServiceResult> {
    const loaded = preloaded ?? (await this.load(id));
    if (!loaded.ok) return loaded;
    const { session, listing } = loaded;

    const result = transition(session, event);
    if (!result.ok) return { ok: false, error: result.error, session: result.session, listing };
    if (sameState(session, result.session)) return { ok: true, session, listing }; // idempotent replay

    const saved = await this.deps.store.compareAndSet(id, session.version, result.session);
    if (!saved) {
      // Someone else wrote between our load and our CAS (e.g. the other
      // surface). Return the fresh state so the client can re-render.
      // Step 7 turns the COMPLETE case of this into a graceful replay.
      const fresh = await this.load(id);
      return { ok: false, error: 'VERSION_CONFLICT', session: fresh.session, listing };
    }
    await this.afterWrite(session, saved);
    return { ok: true, session: saved, listing };
  }

  /** Side effects keyed off status changes, run only after a write succeeded. */
  private async afterWrite(before: CheckoutSession, after: CheckoutSession): Promise<void> {
    const { inventory, analytics, clock } = this.deps;
    const at = clock.now();
    const track = (name: string, props?: Record<string, unknown>) =>
      analytics.track({ name, sessionId: after.id, at, props });

    if (before.currentPrice !== after.currentPrice) {
      track('price_changed', { from: before.currentPrice, to: after.currentPrice });
    }
    if (before.status === after.status) return;

    track(`status_${after.status.toLowerCase()}`, { from: before.status });
    // EXPIRED and FAILED give the seat back. COMPLETED keeps it (in a real
    // system the hold converts to a sale here).
    if (after.status === 'EXPIRED' || after.status === 'FAILED') {
      await inventory.release(after.inventoryHoldId);
    }
  }
}

function sameState(a: CheckoutSession, b: CheckoutSession): boolean {
  return a.status === b.status && a.currentPrice === b.currentPrice;
}
