// Spec for the state machine — the transition table as executable todos.
// Fill these in as you implement evaluate()/transition(); full coverage is step 8.
import { evaluate, transition } from './checkout-machine';
import { makeCtx, makeSession, T0, TTL_MS } from '../test/factories';

void evaluate; void transition; void makeCtx; void makeSession; void T0; void TTL_MS;

describe('evaluate', () => {
  it.todo('ACTIVE before expiresAt stays ACTIVE');
  it.todo('ACTIVE at/after expiresAt becomes EXPIRED');
  it.todo('ACTIVE with an invalid hold is handled (your call: EXPIRED/FAILED)');
  it.todo('PENDING_PAYMENT does not expire (hold frozen)');
  it.todo('refreshes currentPrice but never touches priceAtStart');
  it.todo('terminal statuses are left as-is');
  it.todo('does not mutate its input');
});

describe('transition: PAY', () => {
  it.todo('ACTIVE → PENDING_PAYMENT when version and price match');
  it.todo('rejects VERSION_CONFLICT on stale expectedVersion');
  it.todo('rejects PRICE_MISMATCH when acceptedPrice !== currentPrice');
  it.todo('re-PAY on PENDING_PAYMENT is an idempotent no-op');
  it.todo('rejects on EXPIRED / terminal');
});

describe('transition: COMPLETE', () => {
  it.todo('PENDING_PAYMENT → COMPLETED on succeeded charge');
  it.todo('PENDING_PAYMENT → FAILED on declined charge');
  it.todo('rejects IDEMPOTENCY_KEY_MISMATCH');
  it.todo('rejects INVALID_TRANSITION from ACTIVE');
});

// Regression specs from the step-1 code review. Each one is a real retry /
// cross-surface scenario. A retry carries the version the client saw BEFORE
// its first attempt succeeded — so it is always "stale" by construction.
describe('review findings: replays arrive with a stale version', () => {
  it('a retried PAY (network blip after success) is an idempotent no-op, not a conflict', () => {
    // Client sent PAY at v1; server moved to PENDING_PAYMENT v2; response was lost.
    const pending = makeSession({ status: 'PENDING_PAYMENT', version: 2 });
    const retry = transition(pending, { type: 'PAY', expectedVersion: 1, acceptedPrice: 18500 });
    expect(retry).toEqual({ ok: true, session: pending });
  });

  it('second surface completing an already-completed session gets a replay, not a conflict', () => {
    // Web completed at v2 → v3. Mobile still holds v2.
    const completed = makeSession({ status: 'COMPLETED', version: 3 });
    const mobile = transition(completed, {
      type: 'COMPLETE',
      expectedVersion: 2,
      idempotencyKey: 'idem_test',
      chargeOutcome: 'succeeded',
    });
    expect(mobile).toEqual({ ok: true, session: completed });
  });

  it('a stale PAY at a price this client never saw is NOT treated as a replay', () => {
    // Price bumped 18500 → 21000; mobile acknowledged and paid at 21000.
    // Web (stale, still showing 18500) retries PAY. Saying "ok" here would let
    // web proceed to COMPLETE and charge 21000 behind a screen showing 18500.
    const pending = makeSession({ status: 'PENDING_PAYMENT', currentPrice: 21000, version: 3 });
    const web = transition(pending, { type: 'PAY', expectedVersion: 1, acceptedPrice: 18500 });
    expect(web).toMatchObject({ ok: false, error: 'PRICE_MISMATCH' });
  });
});

describe('review findings: error codes must match reality', () => {
  it('PAY on a COMPLETED session is not reported as SESSION_EXPIRED', () => {
    const completed = makeSession({ status: 'COMPLETED' });
    const res = transition(completed, { type: 'PAY', expectedVersion: 1, acceptedPrice: 18500 });
    expect(res).toMatchObject({ ok: false, error: 'INVALID_TRANSITION' });
  });
});
