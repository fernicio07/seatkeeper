// Shared between the API and both client surfaces. The server is the only
// writer of CheckoutSession; clients hold an id and render what they're given.

export type SessionStatus =
  | 'ACTIVE'
  | 'PENDING_PAYMENT'
  | 'COMPLETED'
  | 'EXPIRED'
  | 'FAILED';

export const TERMINAL_STATUSES: readonly SessionStatus[] = ['COMPLETED', 'EXPIRED', 'FAILED'];

export interface CheckoutSession {
  id: string;
  listingId: string;
  priceAtStart: number; // cents; never changes after create (audit trail)
  currentPrice: number; // cents; refreshed from inventory on every evaluate
  status: SessionStatus;
  expiresAt: number; // epoch ms
  inventoryHoldId: string;
  version: number; // bumped by the store on every successful write
  idempotencyKey: string; // one per session → at most one charge/order
  orderId: string | null; // set once, on COMPLETED; both surfaces show the same one
}

export interface Listing {
  id: string;
  eventName: string;
  venue: string;
  eventDate: string; // ISO
  section: string;
  row: string;
  seat: string;
  price: number; // cents
}

// Fan intents. Time is NOT carried on events — it comes from the caller's
// Clock via the `now` argument, so there's one source of time per request.
export type CheckoutEvent =
  | { type: 'PAY'; expectedVersion: number; acceptedPrice: number }
  | {
      type: 'COMPLETE';
      expectedVersion: number;
      idempotencyKey: string;
      acceptedPrice: number; // the price this surface agreed to (server-side lock)
      // transition() is pure, so the gateway result is passed in as data
      // by the route handler after it calls PaymentGateway.charge().
      chargeOutcome: 'succeeded' | 'declined';
      chargeId: string; // source for orderId
    };

// Facts about the outside world that evaluate() reconciles the session against.
// The route gathers these (async I/O) and evaluate() decides (pure).
export interface EvaluationContext {
  now: number;
  currentPrice: number; // latest price from InventoryService
  holdValid: boolean; // is our inventory hold still ours?
}

// Error codes rather than free-text so routes can map them to HTTP statuses
// and clients can switch on them.
export type TransitionErrorCode =
  | 'SESSION_EXPIRED'
  | 'VERSION_CONFLICT' // client acted on a stale snapshot
  | 'PRICE_MISMATCH' // acceptedPrice !== currentPrice
  | 'IDEMPOTENCY_KEY_MISMATCH'
  | 'INVALID_TRANSITION'; // e.g. COMPLETE while ACTIVE, anything on a terminal

// On failure we still return the (evaluated) session: the client needs the
// fresh state to render the right recovery UI, not just an error string.
export type TransitionResult =
  | { ok: true; session: CheckoutSession }
  | { ok: false; error: TransitionErrorCode; session: CheckoutSession };

// HTTP envelope for every /checkout response, success or error.
export interface CheckoutResponse {
  session: CheckoutSession | null;
  listing: Listing | null;
  serverTime: number; // API clock at response time (the clock that decides expiry)
  error?: string;
  replayed?: boolean; // true when the request was an idempotent replay (changed nothing)
}
