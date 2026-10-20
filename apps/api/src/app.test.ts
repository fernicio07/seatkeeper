// Route smoke tests via app.inject() — real HTTP semantics, no port opened.
// Exhaustive transition coverage is step 8; these prove the wiring.
import { buildTestApp } from './test/build-test-app';
import { TTL_MS } from './test/factories';
import { BarrierGateway, NaiveGateway } from './test/race-gateways';
import { StubPaymentGateway } from './services/stubs';

async function startCheckout(t: ReturnType<typeof buildTestApp>) {
  const res = await t.app.inject({ method: 'POST', url: '/checkout', payload: { listingId: 'lst_heat_1' } });
  return res.json().session;
}

describe('checkout routes', () => {
  it('happy path: create → resume → pay → complete', async () => {
    const t = buildTestApp();
    const created = await startCheckout(t);
    expect(created).toMatchObject({ status: 'ACTIVE', version: 1, priceAtStart: 18500 });

    const resumed = await t.app.inject({ method: 'GET', url: `/checkout/${created.id}` });
    expect(resumed.statusCode).toBe(200);
    expect(resumed.json().listing.section).toBe('112');

    const paid = await t.app.inject({
      method: 'POST',
      url: `/checkout/${created.id}/pay`,
      payload: { expectedVersion: 1, acceptedPrice: 18500 },
    });
    expect(paid.json().session).toMatchObject({ status: 'PENDING_PAYMENT', version: 2 });

    const done = await t.app.inject({
      method: 'POST',
      url: `/checkout/${created.id}/complete`,
      payload: { expectedVersion: 2, idempotencyKey: created.idempotencyKey, acceptedPrice: 18500 },
    });
    expect(done.statusCode).toBe(200);
    expect(done.json().session).toMatchObject({ status: 'COMPLETED', version: 3 });
    expect(t.payments.chargeCount).toBe(1);
  });

  it('resume after expiresAt persists EXPIRED and releases the hold', async () => {
    const t = buildTestApp();
    const created = await startCheckout(t);
    t.clock.advance(TTL_MS);

    const res = await t.app.inject({ method: 'GET', url: `/checkout/${created.id}` });
    expect(res.json().session).toMatchObject({ status: 'EXPIRED', version: 2 });
    expect(await t.inventory.isHoldValid(created.inventoryHoldId)).toBe(false);
  });

  it('resume after a price bump returns the new currentPrice and bumps version', async () => {
    const t = buildTestApp();
    const created = await startCheckout(t);
    t.inventory.setPrice('lst_heat_1', 21000);

    const res = await t.app.inject({ method: 'GET', url: `/checkout/${created.id}` });
    expect(res.json().session).toMatchObject({ priceAtStart: 18500, currentPrice: 21000, version: 2 });
  });

  it('declined charge → FAILED, hold released', async () => {
    const t = buildTestApp();
    const created = await startCheckout(t);
    t.payments.nextOutcome = 'declined';
    await t.app.inject({ method: 'POST', url: `/checkout/${created.id}/pay`, payload: { expectedVersion: 1, acceptedPrice: 18500 } });

    const res = await t.app.inject({
      method: 'POST',
      url: `/checkout/${created.id}/complete`,
      payload: { expectedVersion: 2, idempotencyKey: created.idempotencyKey, acceptedPrice: 18500 },
    });
    expect(res.json().session.status).toBe('FAILED');
    expect(await t.inventory.isHoldValid(created.inventoryHoldId)).toBe(false);
  });

  it('complete while ACTIVE is rejected without charging', async () => {
    const t = buildTestApp();
    const created = await startCheckout(t);
    const res = await t.app.inject({
      method: 'POST',
      url: `/checkout/${created.id}/complete`,
      payload: { expectedVersion: 1, idempotencyKey: created.idempotencyKey, acceptedPrice: 18500 },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: 'INVALID_TRANSITION', session: { status: 'ACTIVE' } });
    expect(t.payments.chargeCount).toBe(0);
  });

  it('404s an unknown session and 400s a malformed body', async () => {
    const t = buildTestApp();
    expect((await t.app.inject({ method: 'GET', url: '/checkout/nope' })).statusCode).toBe(404);
    expect((await t.app.inject({ method: 'POST', url: '/checkout', payload: {} })).statusCode).toBe(400);
  });
});

describe('response envelope', () => {
  it('includes the API clock as serverTime (respects the injected clock)', async () => {
    const t = buildTestApp();
    t.clock.advance(1234);
    const res = await t.app.inject({ method: 'POST', url: '/checkout', payload: { listingId: 'lst_heat_1' } });
    expect(res.json().serverTime).toBe(t.clock.now());
  });
});

// ─── Step 7: duplicate completion ────────────────────────────────────────────
describe('duplicate completion (two surfaces, one session)', () => {
  async function pendingSession(t: ReturnType<typeof buildTestApp>) {
    const s = await startCheckout(t);
    await t.app.inject({ method: 'POST', url: `/checkout/${s.id}/pay`, payload: { expectedVersion: 1, acceptedPrice: 18500 } });
    return s;
  }
  const completeAs = (t: ReturnType<typeof buildTestApp>, s: { id: string; idempotencyKey: string }, acceptedPrice = 18500) =>
    t.app.inject({
      method: 'POST',
      url: `/checkout/${s.id}/complete`,
      payload: { expectedVersion: 2, idempotencyKey: s.idempotencyKey, acceptedPrice },
    });

  it('concurrent completes (worst-case interleaving) → one order, one charge, loser gets a 200 replay', async () => {
    const stub = new StubPaymentGateway();
    const t = buildTestApp({ payments: new BarrierGateway(stub) });
    const s = await pendingSession(t);

    const [web, mobile] = await Promise.all([completeAs(t, s), completeAs(t, s)]);

    expect([web.statusCode, mobile.statusCode]).toEqual([200, 200]);
    const bodies = [web.json(), mobile.json()];
    expect(bodies.filter((b) => b.replayed === true)).toHaveLength(1); // exactly one replay
    expect(bodies.map((b) => b.session.status)).toEqual(['COMPLETED', 'COMPLETED']);
    expect(bodies[0].session.version).toBe(3); // one write, not two
    expect(bodies[0].session.orderId).toBeTruthy();
    expect(bodies[0].session.orderId).toBe(bodies[1].session.orderId); // ONE order
    expect(stub.chargeCount).toBe(1); // ONE charge
  });

  it('sequential: second surface completing later gets a 200 replay with the same orderId', async () => {
    const t = buildTestApp();
    const s = await pendingSession(t);
    const first = (await completeAs(t, s)).json();
    const second = await completeAs(t, s);

    expect(second.statusCode).toBe(200);
    expect(second.json()).toMatchObject({ replayed: true, session: { status: 'COMPLETED', orderId: first.session.orderId } });
    expect(t.payments.chargeCount).toBe(1);
  });

  it('layering: without gateway idempotency, version CAS still yields ONE order — but TWO charges', async () => {
    // Documents why decision 1(a) leans on the gateway: version protects our
    // state, only the idempotency key protects the card.
    const naive = new NaiveGateway();
    const t = buildTestApp({ payments: new BarrierGateway(naive) });
    const s = await pendingSession(t);

    const [a, b] = await Promise.all([completeAs(t, s), completeAs(t, s)]);

    const final = (await t.app.inject({ method: 'GET', url: `/checkout/${s.id}` })).json().session;
    expect(final).toMatchObject({ status: 'COMPLETED', version: 3 });
    expect([a.json().replayed, b.json().replayed].filter(Boolean)).toHaveLength(1);
    expect(naive.chargeCount).toBe(2);
  });

  it('complete at a price this surface never accepted → 409 PRICE_MISMATCH, no charge', async () => {
    const t = buildTestApp();
    const s = await startCheckout(t);
    t.inventory.setPrice('lst_heat_1', 21000);
    await t.app.inject({ method: 'GET', url: `/checkout/${s.id}` }); // v2, currentPrice 21000
    await t.app.inject({ method: 'POST', url: `/checkout/${s.id}/pay`, payload: { expectedVersion: 2, acceptedPrice: 21000 } }); // v3

    // Stale surface still believes 185.
    const res = await t.app.inject({
      method: 'POST',
      url: `/checkout/${s.id}/complete`,
      payload: { expectedVersion: 3, idempotencyKey: s.idempotencyKey, acceptedPrice: 18500 },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: 'PRICE_MISMATCH', session: { status: 'PENDING_PAYMENT' } });
    expect(t.payments.chargeCount).toBe(0);
  });

  it('replay of a COMPLETED session ignores a stale acceptedPrice (decision 2: price check after replay)', async () => {
    const t = buildTestApp();
    const s = await pendingSession(t);
    await completeAs(t, s);
    const replay = await completeAs(t, s, 99999);
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toMatchObject({ replayed: true, session: { status: 'COMPLETED' } });
  });
});

// ─── Review fixes: inventory exclusivity, hold lifecycle, resilience ─────────
describe('inventory: one live hold per seat', () => {
  const create = (t: ReturnType<typeof buildTestApp>) =>
    t.app.inject({ method: 'POST', url: '/checkout', payload: { listingId: 'lst_heat_1' } });

  it('a second fan gets 409 SEAT_UNAVAILABLE while the first holds the seat', async () => {
    const t = buildTestApp();
    expect((await create(t)).statusCode).toBe(201);
    const second = await create(t);
    expect(second.statusCode).toBe(409);
    expect(second.json().error).toBe('SEAT_UNAVAILABLE');
  });

  it('an abandoned hold frees the seat at expiresAt even if nobody re-loads that session', async () => {
    const t = buildTestApp();
    await create(t);
    t.clock.advance(TTL_MS); // fan A walked away; their session is never fetched again
    expect((await create(t)).statusCode).toBe(201);
  });

  it('PENDING_PAYMENT freezes the hold: it survives past expiresAt and still blocks others', async () => {
    const t = buildTestApp();
    const s = await startCheckout(t);
    await t.app.inject({ method: 'POST', url: `/checkout/${s.id}/pay`, payload: { expectedVersion: 1, acceptedPrice: 18500 } });
    t.clock.advance(TTL_MS * 2);
    expect(await t.inventory.isHoldValid(s.inventoryHoldId)).toBe(true);
    expect((await create(t)).statusCode).toBe(409);
  });

  it('COMPLETED confirms the sale: the seat stays unavailable forever', async () => {
    const t = buildTestApp();
    const s = await startCheckout(t);
    await t.app.inject({ method: 'POST', url: `/checkout/${s.id}/pay`, payload: { expectedVersion: 1, acceptedPrice: 18500 } });
    await t.app.inject({
      method: 'POST',
      url: `/checkout/${s.id}/complete`,
      payload: { expectedVersion: 2, idempotencyKey: s.idempotencyKey, acceptedPrice: 18500 },
    });
    t.clock.advance(TTL_MS * 10);
    expect(await t.inventory.isAvailable('lst_heat_1')).toBe(false);
  });

  it('FAILED releases the seat for the next fan', async () => {
    const t = buildTestApp();
    const s = await startCheckout(t);
    t.payments.nextOutcome = 'declined';
    await t.app.inject({ method: 'POST', url: `/checkout/${s.id}/pay`, payload: { expectedVersion: 1, acceptedPrice: 18500 } });
    await t.app.inject({
      method: 'POST',
      url: `/checkout/${s.id}/complete`,
      payload: { expectedVersion: 2, idempotencyKey: s.idempotencyKey, acceptedPrice: 18500 },
    });
    expect((await create(t)).statusCode).toBe(201);
  });

  it('GET /listings/:id reports availability', async () => {
    const t = buildTestApp();
    expect((await t.app.inject({ method: 'GET', url: '/listings/lst_heat_1' })).json().available).toBe(true);
    await create(t);
    expect((await t.app.inject({ method: 'GET', url: '/listings/lst_heat_1' })).json().available).toBe(false);
  });
});

describe('resilience', () => {
  it('a failing side effect after a committed write does not fail the request', async () => {
    const t = buildTestApp();
    const s = await startCheckout(t);
    jest.spyOn(t.inventory, 'freeze').mockRejectedValueOnce(new Error('inventory down'));
    const err = jest.spyOn(console, 'error').mockImplementation(() => {});

    const res = await t.app.inject({ method: 'POST', url: `/checkout/${s.id}/pay`, payload: { expectedVersion: 1, acceptedPrice: 18500 } });

    expect(res.statusCode).toBe(200);
    expect(res.json().session.status).toBe('PENDING_PAYMENT');
    expect(err).toHaveBeenCalledWith(expect.stringContaining('inventory.freeze'), expect.any(Error));
    err.mockRestore();
  });
});

describe('analytics', () => {
  it('revalidation GETs (focus/countdown) are not counted as resumes', async () => {
    const t = buildTestApp();
    const s = await startCheckout(t);
    await t.app.inject({ method: 'GET', url: `/checkout/${s.id}?surface=web&reason=revalidate` });
    await t.app.inject({ method: 'GET', url: `/checkout/${s.id}?surface=web` }); // default = revalidate
    expect(t.analytics.events.filter((e) => e.name === 'surface_resumed')).toHaveLength(0);
  });

  it('GET with reason=open tracks surface_resumed with the surface', async () => {
    const t = buildTestApp();
    const s = await startCheckout(t);
    await t.app.inject({ method: 'GET', url: `/checkout/${s.id}?surface=mobile&reason=open` });
    expect(t.analytics.events).toContainEqual(
      expect.objectContaining({ name: 'surface_resumed', sessionId: s.id, props: expect.objectContaining({ surface: 'mobile' }) }),
    );
  });

  it('a duplicate complete tracks checkout_replayed', async () => {
    const t = buildTestApp();
    const s = await startCheckout(t);
    await t.app.inject({ method: 'POST', url: `/checkout/${s.id}/pay`, payload: { expectedVersion: 1, acceptedPrice: 18500 } });
    const body = { expectedVersion: 2, idempotencyKey: s.idempotencyKey, acceptedPrice: 18500 };
    await t.app.inject({ method: 'POST', url: `/checkout/${s.id}/complete`, payload: body });
    await t.app.inject({ method: 'POST', url: `/checkout/${s.id}/complete`, payload: body });
    expect(t.analytics.events.filter((e) => e.name === 'checkout_replayed')).toHaveLength(1);
  });

  it('POST /events accepts whitelisted client events and rejects anything else', async () => {
    const t = buildTestApp();
    const ok = await t.app.inject({
      method: 'POST',
      url: '/events',
      payload: { name: 'price_banner_acknowledged', sessionId: 'cs_x', surface: 'web', props: { from: 1, to: 2 } },
    });
    expect(ok.statusCode).toBe(204);
    expect(t.analytics.events).toContainEqual(expect.objectContaining({ name: 'price_banner_acknowledged' }));
    const bad = await t.app.inject({ method: 'POST', url: '/events', payload: { name: 'drop_tables', sessionId: 'x', surface: 'web' } });
    expect(bad.statusCode).toBe(400);
  });
});

describe('review fix: hold revoked while PENDING_PAYMENT', () => {
  it('complete does not charge; session becomes FAILED and the seat is free', async () => {
    const t = buildTestApp();
    const s = await startCheckout(t);
    await t.app.inject({ method: 'POST', url: `/checkout/${s.id}/pay`, payload: { expectedVersion: 1, acceptedPrice: 18500 } });
    t.inventory.revokeHold(s.inventoryHoldId);

    const res = await t.app.inject({
      method: 'POST',
      url: `/checkout/${s.id}/complete`,
      payload: { expectedVersion: 2, idempotencyKey: s.idempotencyKey, acceptedPrice: 18500 },
    });

    expect(res.json().session.status).toBe('FAILED');
    expect(t.payments.chargeCount).toBe(0);
    expect(await t.inventory.isAvailable('lst_heat_1')).toBe(true);
  });
});
