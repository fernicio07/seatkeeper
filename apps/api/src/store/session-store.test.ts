import { InMemorySessionStore } from './session-store';
import { makeSession } from '../test/factories';

describe('InMemorySessionStore', () => {
  it('returns copies, so callers cannot mutate stored state by reference', async () => {
    const store = new InMemorySessionStore();
    const created = await store.create(makeSession());
    created.status = 'COMPLETED';

    const fetched = await store.get('cs_test');
    fetched!.status = 'FAILED';

    expect((await store.get('cs_test'))!.status).toBe('ACTIVE');
  });

  it('compareAndSet succeeds on matching version and bumps it', async () => {
    const store = new InMemorySessionStore();
    await store.create(makeSession({ version: 1 }));

    const next = await store.compareAndSet('cs_test', 1, makeSession({ status: 'PENDING_PAYMENT' }));

    expect(next).toMatchObject({ status: 'PENDING_PAYMENT', version: 2 });
  });

  it('compareAndSet rejects a stale version and leaves state untouched', async () => {
    const store = new InMemorySessionStore();
    await store.create(makeSession({ version: 1 }));
    await store.compareAndSet('cs_test', 1, makeSession({ status: 'PENDING_PAYMENT' }));

    // A second writer that read version 1 loses.
    const loser = await store.compareAndSet('cs_test', 1, makeSession({ status: 'FAILED' }));

    expect(loser).toBeNull();
    expect(await store.get('cs_test')).toMatchObject({ status: 'PENDING_PAYMENT', version: 2 });
  });

  it('ignores a version the caller tries to set itself', async () => {
    const store = new InMemorySessionStore();
    await store.create(makeSession({ version: 1 }));
    const next = await store.compareAndSet('cs_test', 1, makeSession({ version: 99 }));
    expect(next!.version).toBe(2);
  });

  it('compareAndSet on a missing id returns null', async () => {
    const store = new InMemorySessionStore();
    expect(await store.compareAndSet('nope', 1, makeSession())).toBeNull();
  });
});
