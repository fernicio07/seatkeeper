// Route smoke tests via app.inject() — real HTTP semantics, no port opened.
// Exhaustive transition coverage is step 8; these prove the wiring.
import { buildTestApp } from './test/build-test-app';
import { TTL_MS } from './test/factories';

async function startCheckout(t: ReturnType<typeof buildTestApp>) {
  const res = await t.app.inject({ method: 'POST', url: '/checkout', payload: { listingId: 'lst_knicks_1' } });
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
      payload: { expectedVersion: 2, idempotencyKey: created.idempotencyKey },
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
    t.inventory.setPrice('lst_knicks_1', 21000);

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
      payload: { expectedVersion: 2, idempotencyKey: created.idempotencyKey },
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
      payload: { expectedVersion: 1, idempotencyKey: created.idempotencyKey },
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
