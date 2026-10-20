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
  /** Where best-effort side-effect failures are reported. Defaults to console. */
  logger?: { error(msg: string, err: unknown): void };
}

export type Surface = 'web' | 'mobile';

export type ServiceErrorCode =
  | TransitionErrorCode
  | 'NOT_FOUND'
  | 'LISTING_NOT_FOUND'
  | 'SEAT_UNAVAILABLE' // another live hold or a sale blocks the seat
  | 'BUSY'; // couldn't win a write after retries; session returned as last stored

export type ServiceResult =
  | { ok: true; session: CheckoutSession; listing: Listing; replayed?: boolean }
  | { ok: false; error: ServiceErrorCode; session?: CheckoutSession; listing?: Listing };

const MAX_REFRESH_ATTEMPTS = 3;
// apply(): first attempt + one re-run against fresh state after losing a CAS race.
const MAX_APPLY_ATTEMPTS = 2;

export class CheckoutService {
  constructor(private deps: CheckoutDeps) {}

  async create(listingId: string): Promise<ServiceResult> {
    const { store, inventory, clock, analytics, ttlMs } = this.deps;
    const listing = await inventory.getListing(listingId);
    if (!listing) return { ok: false, error: 'LISTING_NOT_FOUND' };

    const now = clock.now();
    const expiresAt = now + ttlMs;
    const holdId = await inventory.hold(listingId, expiresAt);
    if (!holdId) return { ok: false, error: 'SEAT_UNAVAILABLE', listing };

    const session = await store.create({
      id: `cs_${randomUUID()}`,
      listingId,
      priceAtStart: listing.price,
      currentPrice: listing.price,
      status: 'ACTIVE',
      expiresAt,
      inventoryHoldId: holdId,
      version: 1,
      idempotencyKey: `idem_${randomUUID()}`,
      orderId: null,
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
    let stored: CheckoutSession | null = null;

    for (let attempt = 0; attempt < MAX_REFRESH_ATTEMPTS; attempt++) {
      stored = await store.get(id);
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
    // Pathological contention. Still honour "every response carries the
    // session": return the last stored copy, flagged so the client retries.
    return { ok: false, error: 'BUSY', session: stored ?? undefined };
  }

  /** GET /checkout/:id — a load that's also a resume event for analytics. */
  async resume(id: string, surface: Surface): Promise<ServiceResult> {
    const result = await this.load(id);
    if (result.ok) {
      this.track('surface_resumed', id, { surface, status: result.session.status });
    }
    return result;
  }

  async pay(id: string, input: { expectedVersion: number; acceptedPrice: number }) {
    return this.apply(id, { type: 'PAY', ...input });
  }

  async complete(
    id: string,
    input: { expectedVersion: number; idempotencyKey: string; acceptedPrice: number },
  ) {
    const loaded = await this.load(id);
    if (!loaded.ok) return loaded;
    const { session, listing } = loaded;

    // Dry run BEFORE charging: transition() is pure, so we can ask "would a
    // successful charge be a legal transition?" without side effects. This
    // stops us charging a card for a session that's ACTIVE, expired, stale,
    // at a price this surface didn't accept, or already completed (replay —
    // returned as-is, no second charge).
    const dryRun = transition(session, {
      type: 'COMPLETE',
      ...input,
      chargeOutcome: 'succeeded',
      chargeId: 'dry-run',
    });
    if (!dryRun.ok) return { ok: false as const, error: dryRun.error, session: dryRun.session, listing };
    if (sameState(session, dryRun.session)) return this.replay(session, listing, 'COMPLETE');

    // Two concurrent completes can BOTH get past the dry run and reach this
    // line. Version CAS (in apply) guarantees one order; the per-session
    // idempotencyKey is what guarantees one charge. Different layers, different failures.
    const charge = await this.deps.payments.charge({
      amount: session.currentPrice,
      idempotencyKey: session.idempotencyKey,
    });
    return this.apply(
      id,
      { type: 'COMPLETE', ...input, chargeOutcome: charge.status, chargeId: charge.chargeId },
      loaded,
    );
  }

  /** Run a fan intent through the machine and persist it with CAS. */
  private async apply(
    id: string,
    event: CheckoutEvent,
    preloaded?: Extract<ServiceResult, { ok: true }>,
  ): Promise<ServiceResult> {
    let loaded: ServiceResult = preloaded ?? (await this.load(id));

    for (let attempt = 0; attempt < MAX_APPLY_ATTEMPTS; attempt++) {
      if (!loaded.ok) return loaded;
      const { session, listing } = loaded;

      const result = transition(session, event);
      if (!result.ok) return { ok: false, error: result.error, session: result.session, listing };
      if (sameState(session, result.session)) return this.replay(session, listing, event.type);

      const saved = await this.deps.store.compareAndSet(id, session.version, result.session);
      if (saved) {
        await this.afterWrite(session, saved);
        return { ok: true, session: saved, listing, replayed: false };
      }

      // Lost the CAS race: another request (e.g. the other surface) wrote
      // between our load and our write. Don't fail yet — re-run the machine
      // against the fresh state with the SAME event. For a duplicate COMPLETE
      // the fresh state is COMPLETED, and the machine's replay-first guard
      // turns it into a replay. The event carries the original charge result,
      // so this never charges again. For anything else (e.g. a stale PAY) the
      // machine's version check returns VERSION_CONFLICT.
      loaded = await this.load(id);
    }

    return {
      ok: false,
      error: 'VERSION_CONFLICT',
      session: loaded.session,
      listing: loaded.listing,
    };
  }

  private replay(session: CheckoutSession, listing: Listing, eventType: CheckoutEvent['type']): ServiceResult {
    this.track('checkout_replayed', session.id, { event: eventType, status: session.status });
    return { ok: true, session, listing, replayed: true };
  }

  private track(name: string, sessionId: string, props?: Record<string, unknown>) {
    this.deps.analytics.track({ name, sessionId, at: this.deps.clock.now(), props });
  }

  /**
   * Side effects keyed off status changes, run only after a write succeeded.
   * Best-effort: the state change is already committed, so a failing side
   * effect must not turn the response into a 500 (the client would retry an
   * operation that actually worked). Production: an outbox processed with
   * retries, so a missed release/confirm is eventually applied.
   */
  private async afterWrite(before: CheckoutSession, after: CheckoutSession): Promise<void> {
    const { inventory } = this.deps;
    const effect = async (name: string, fn: () => unknown) => {
      try {
        await fn();
      } catch (err) {
        (this.deps.logger ?? console).error(`[checkout] side effect "${name}" failed for ${after.id}`, err);
      }
    };

    if (before.currentPrice !== after.currentPrice) {
      await effect('track price_changed', () =>
        this.track('price_changed', after.id, { from: before.currentPrice, to: after.currentPrice }),
      );
    }
    if (before.status === after.status) return;

    await effect('track status', () => this.track(`status_${after.status.toLowerCase()}`, after.id, { from: before.status }));
    const holdId = after.inventoryHoldId;
    if (after.status === 'PENDING_PAYMENT') await effect('inventory.freeze', () => inventory.freeze(holdId));
    if (after.status === 'COMPLETED') await effect('inventory.confirm', () => inventory.confirm(holdId));
    if (after.status === 'EXPIRED' || after.status === 'FAILED') {
      await effect('inventory.release', () => inventory.release(holdId));
    }
  }
}

function sameState(a: CheckoutSession, b: CheckoutSession): boolean {
  return a.status === b.status && a.currentPrice === b.currentPrice;
}
