// State machine spec. Strategy, in layers:
//   1. One test per row of the transition table (evaluate / PAY / COMPLETE).
//   2. A status × event matrix: every cell's expected outcome, plus invariants
//      that must hold in every cell (so a new branch can't silently break them).
//   3. Regression specs for bugs found in review (below the matrix).
import type { CheckoutEvent, CheckoutSession, SessionStatus } from '@seatkeeper/shared';
import { evaluate, transition } from './checkout-machine';
import { makeCtx, makeSession, T0, TTL_MS } from '../test/factories';

describe('evaluate', () => {
  it('ACTIVE before expiresAt stays ACTIVE', () => {
    const session = makeSession({ status: 'ACTIVE', expiresAt: T0 + TTL_MS });
    const ctx = makeCtx({ now: T0 + 1000, holdValid: true });
    const next = evaluate(session, ctx);
    expect(next.status).toBe('ACTIVE');
  });

  it('ACTIVE at/after expiresAt becomes EXPIRED', () => {
    const session = makeSession({ status: 'ACTIVE', expiresAt: T0 + TTL_MS });
    const ctx = makeCtx({ now: T0 + TTL_MS, holdValid: true });
    const next = evaluate(session, ctx);
    expect(next.status).toBe('EXPIRED');
  });

  it('ACTIVE with an invalid hold becomes EXPIRED', () => {
    const session = makeSession({ status: 'ACTIVE' });
    const ctx = makeCtx({ now: T0, holdValid: false });
    const next = evaluate(session, ctx);
    expect(next.status).toBe('EXPIRED');
  });

  // Review fix: originally also passed holdValid: false, which since Must Fix #2
  // means FAILED. Split: expiry alone doesn't apply (here); a lost hold is
  // covered by "review fix: hold lost mid-payment" below.
  it('PENDING_PAYMENT does not expire (hold frozen) while the hold is valid', () => {
    const session = makeSession({ status: 'PENDING_PAYMENT', expiresAt: T0 });
    const ctx = makeCtx({ now: T0 + 10000, holdValid: true });
    const next = evaluate(session, ctx);
    expect(next).toEqual(session);
  });

  it('refreshes currentPrice but never touches priceAtStart while ACTIVE', () => {
    const session = makeSession({ status: 'ACTIVE', priceAtStart: 18500, currentPrice: 18500 });
    const ctx = makeCtx({ now: T0, currentPrice: 21000, holdValid: true });
    const next = evaluate(session, ctx);
    expect(next.priceAtStart).toBe(18500);
    expect(next.currentPrice).toBe(21000);
  });

  it('PENDING_PAYMENT locks the price: currentPrice is not refreshed', () => {
    const session = makeSession({ status: 'PENDING_PAYMENT', currentPrice: 18500 });
    expect(evaluate(session, makeCtx({ currentPrice: 21000 })).currentPrice).toBe(18500);
  });

  it('expiry wins over a simultaneous price change (EXPIRED keeps the old price)', () => {
    const session = makeSession({ status: 'ACTIVE', expiresAt: T0 });
    const next = evaluate(session, makeCtx({ now: T0, currentPrice: 21000 }));
    expect(next).toMatchObject({ status: 'EXPIRED', currentPrice: 18500 });
  });

  it('terminal statuses are left as-is', () => {
    for (const status of ['COMPLETED', 'EXPIRED', 'FAILED'] as const) {
      const session = makeSession({ status });
      const ctx = makeCtx({ now: T0 + 999999, holdValid: false, currentPrice: 99999 });
      expect(evaluate(session, ctx)).toEqual(session);
    }
  });

  it('does not mutate its input session', () => {
    const session = makeSession({ status: 'ACTIVE' });
    const frozen = structuredClone(session);
    evaluate(session, makeCtx({ now: T0 + TTL_MS }));
    expect(session).toEqual(frozen);
  });
});

describe('transition: PAY', () => {
  it('ACTIVE → PENDING_PAYMENT when version and price match', () => {
    const session = makeSession({ status: 'ACTIVE', version: 1, currentPrice: 18500 });
    const res = transition(session, { type: 'PAY', expectedVersion: 1, acceptedPrice: 18500 });
    expect(res).toMatchObject({ ok: true, session: { status: 'PENDING_PAYMENT' } });
  });

  it('rejects VERSION_CONFLICT on stale expectedVersion', () => {
    const session = makeSession({ status: 'ACTIVE', version: 2 });
    const res = transition(session, { type: 'PAY', expectedVersion: 1, acceptedPrice: 18500 });
    expect(res).toMatchObject({ ok: false, error: 'VERSION_CONFLICT' });
  });

  it('rejects PRICE_MISMATCH when acceptedPrice !== currentPrice', () => {
    const session = makeSession({ status: 'ACTIVE', version: 1, currentPrice: 21000 });
    const res = transition(session, { type: 'PAY', expectedVersion: 1, acceptedPrice: 18500 });
    expect(res).toMatchObject({ ok: false, error: 'PRICE_MISMATCH' });
  });

  it('re-PAY on PENDING_PAYMENT is an idempotent no-op when price matches', () => {
    const session = makeSession({ status: 'PENDING_PAYMENT', version: 2, currentPrice: 18500 });
    const res = transition(session, { type: 'PAY', expectedVersion: 1, acceptedPrice: 18500 }); // stale version ignored on replay
    expect(res).toEqual({ ok: true, session });
  });

  it('rejects on EXPIRED with SESSION_EXPIRED, on COMPLETED/FAILED with INVALID_TRANSITION', () => {
    const pay = { type: 'PAY' as const, expectedVersion: 1, acceptedPrice: 18500 };
    expect(transition(makeSession({ status: 'EXPIRED' }), pay)).toMatchObject({ ok: false, error: 'SESSION_EXPIRED' });
    expect(transition(makeSession({ status: 'COMPLETED' }), pay)).toMatchObject({ ok: false, error: 'INVALID_TRANSITION' });
    expect(transition(makeSession({ status: 'FAILED' }), pay)).toMatchObject({ ok: false, error: 'INVALID_TRANSITION' });
  });
});

describe('transition: COMPLETE', () => {
  const complete = (overrides: Partial<Extract<CheckoutEvent, { type: 'COMPLETE' }>> = {}) => ({
    type: 'COMPLETE' as const,
    expectedVersion: 2,
    idempotencyKey: 'idem_1',
    acceptedPrice: 18500,
    chargeOutcome: 'succeeded' as const,
    chargeId: 'ch_123',
    ...overrides,
  });

  it('PENDING_PAYMENT → COMPLETED on succeeded charge', () => {
    const session = makeSession({ status: 'PENDING_PAYMENT', version: 2, currentPrice: 18500, idempotencyKey: 'idem_1' });
    expect(transition(session, complete())).toMatchObject({
      ok: true,
      session: { status: 'COMPLETED', orderId: 'ch_123' },
    });
  });

  it('PENDING_PAYMENT → FAILED on declined charge', () => {
    const session = makeSession({ status: 'PENDING_PAYMENT', version: 2, currentPrice: 18500, idempotencyKey: 'idem_1' });
    expect(transition(session, complete({ chargeOutcome: 'declined' }))).toMatchObject({
      ok: true,
      session: { status: 'FAILED', orderId: null },
    });
  });

  it('rejects IDEMPOTENCY_KEY_MISMATCH', () => {
    const session = makeSession({ status: 'PENDING_PAYMENT', version: 2, idempotencyKey: 'idem_1' });
    expect(transition(session, complete({ idempotencyKey: 'wrong_key' }))).toMatchObject({
      ok: false,
      error: 'IDEMPOTENCY_KEY_MISMATCH',
    });
  });

  it('rejects INVALID_TRANSITION from ACTIVE', () => {
    const session = makeSession({ status: 'ACTIVE', version: 1, idempotencyKey: 'idem_1' });
    expect(transition(session, complete({ expectedVersion: 1 }))).toMatchObject({
      ok: false,
      error: 'INVALID_TRANSITION',
    });
  });

  // Gap: a non-replay COMPLETE from a stale client must not slip through.
  it('rejects VERSION_CONFLICT on a stale PENDING_PAYMENT snapshot', () => {
    const session = makeSession({ status: 'PENDING_PAYMENT', version: 3, idempotencyKey: 'idem_1' });
    expect(transition(session, complete({ expectedVersion: 2 }))).toMatchObject({
      ok: false,
      error: 'VERSION_CONFLICT',
    });
  });

  // Gap: the key check runs before the replay, so a wrong key can't read a completed order.
  it('a wrong key on a COMPLETED session is IDEMPOTENCY_KEY_MISMATCH, not a replay', () => {
    const done = makeSession({ status: 'COMPLETED', version: 3, idempotencyKey: 'idem_1', orderId: 'ch_1' });
    expect(transition(done, complete({ idempotencyKey: 'other' }))).toMatchObject({
      ok: false,
      error: 'IDEMPOTENCY_KEY_MISMATCH',
    });
  });
});

// ─── The transition matrix ───────────────────────────────────────────────────
// Every status × event, sent by a fresh, well-formed client (current version,
// matching price, matching key). This is the README transition table as code.
describe('transition matrix (fresh client)', () => {
  type Outcome = { ok: true; status: SessionStatus; replay?: true } | { ok: false; error: string };
  const STATUSES: SessionStatus[] = ['ACTIVE', 'PENDING_PAYMENT', 'COMPLETED', 'EXPIRED', 'FAILED'];

  const EXPECTED: Record<SessionStatus, { PAY: Outcome; COMPLETE: Outcome }> = {
    ACTIVE: {
      PAY: { ok: true, status: 'PENDING_PAYMENT' },
      COMPLETE: { ok: false, error: 'INVALID_TRANSITION' },
    },
    PENDING_PAYMENT: {
      PAY: { ok: true, status: 'PENDING_PAYMENT', replay: true },
      COMPLETE: { ok: true, status: 'COMPLETED' },
    },
    COMPLETED: {
      PAY: { ok: false, error: 'INVALID_TRANSITION' },
      COMPLETE: { ok: true, status: 'COMPLETED', replay: true },
    },
    EXPIRED: {
      PAY: { ok: false, error: 'SESSION_EXPIRED' },
      COMPLETE: { ok: false, error: 'INVALID_TRANSITION' },
    },
    FAILED: {
      PAY: { ok: false, error: 'INVALID_TRANSITION' },
      COMPLETE: { ok: false, error: 'INVALID_TRANSITION' }, // FAILED is never replayed
    },
  };

  const eventFor = (type: 'PAY' | 'COMPLETE', s: CheckoutSession): CheckoutEvent =>
    type === 'PAY'
      ? { type, expectedVersion: s.version, acceptedPrice: s.currentPrice }
      : {
          type,
          expectedVersion: s.version,
          idempotencyKey: s.idempotencyKey,
          acceptedPrice: s.currentPrice,
          chargeOutcome: 'succeeded',
          chargeId: 'ch_matrix',
        };

  const cells = STATUSES.flatMap((status) =>
    (['PAY', 'COMPLETE'] as const).map((type) => ({ status, type, expected: EXPECTED[status][type] })),
  );

  it.each(cells)('$status + $type → $expected', ({ status, type, expected }) => {
    const session = makeSession({ status, version: 5, orderId: status === 'COMPLETED' ? 'ch_prev' : null });
    const before = structuredClone(session);
    const res = transition(session, eventFor(type, session));

    if (expected.ok) {
      expect(res).toMatchObject({ ok: true, session: { status: expected.status } });
      if (expected.replay) expect(res.session).toEqual(session); // replay = no change at all
    } else {
      expect(res).toMatchObject({ ok: false, error: expected.error });
      expect(res.session).toEqual(session); // a rejection never changes state
    }

    // Invariants for every cell:
    expect(session).toEqual(before); // input never mutated
    expect(res.session.version).toBe(session.version); // only the store bumps version
    expect(res.session.priceAtStart).toBe(session.priceAtStart); // audit field is immutable
    expect(res.session.idempotencyKey).toBe(session.idempotencyKey);
    if (['COMPLETED', 'EXPIRED', 'FAILED'].includes(status)) {
      expect(res.session.status).toBe(status); // terminal states never leave
    }
  });
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
      acceptedPrice: 18500,
      chargeOutcome: 'succeeded',
      chargeId: 'ch_test',
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

// ─── Step 7 specs for YOUR transition() changes (red until implemented) ─────
describe('step 7: COMPLETE price guard + orderId', () => {
  const complete = (overrides: Partial<Extract<import('@seatkeeper/shared').CheckoutEvent, { type: 'COMPLETE' }>> = {}) => ({
    type: 'COMPLETE' as const,
    expectedVersion: 2,
    idempotencyKey: 'idem_test',
    acceptedPrice: 18500,
    chargeOutcome: 'succeeded' as const,
    chargeId: 'ch_abc',
    ...overrides,
  });
  const pending = () => makeSession({ status: 'PENDING_PAYMENT', version: 2 });

  it('successful COMPLETE sets a non-null orderId derived from chargeId', () => {
    const res = transition(pending(), complete());
    expect(res.ok && res.session.orderId).toBeTruthy();
  });

  it('orderId is deterministic: same chargeId → same orderId (pure)', () => {
    const a = transition(pending(), complete());
    const b = transition(pending(), complete());
    expect(a.session.orderId).toBe(b.session.orderId);
  });

  it('declined COMPLETE → FAILED with orderId null (no order exists)', () => {
    const res = transition(pending(), complete({ chargeOutcome: 'declined' }));
    expect(res).toMatchObject({ ok: true, session: { status: 'FAILED', orderId: null } });
  });

  it('COMPLETE with acceptedPrice !== currentPrice → PRICE_MISMATCH', () => {
    const res = transition(makeSession({ status: 'PENDING_PAYMENT', version: 2, currentPrice: 21000 }), complete());
    expect(res).toMatchObject({ ok: false, error: 'PRICE_MISMATCH' });
  });

  it('replay on COMPLETED ignores acceptedPrice and keeps the original orderId', () => {
    const done = makeSession({ status: 'COMPLETED', version: 3, orderId: 'ord_original' });
    const res = transition(done, complete({ acceptedPrice: 1, chargeId: 'ch_other' }));
    expect(res).toEqual({ ok: true, session: done });
  });
});

describe('review fix: hold lost mid-payment', () => {
  it('PENDING_PAYMENT + !holdValid → FAILED (fail safe before any charge)', () => {
    const s = makeSession({ status: 'PENDING_PAYMENT', version: 2 });
    expect(evaluate(s, makeCtx({ holdValid: false })).status).toBe('FAILED');
  });

  it('PENDING_PAYMENT + valid hold past expiresAt stays PENDING_PAYMENT (frozen)', () => {
    const s = makeSession({ status: 'PENDING_PAYMENT', version: 2 });
    expect(evaluate(s, makeCtx({ now: s.expiresAt + 1 })).status).toBe('PENDING_PAYMENT');
  });
});
