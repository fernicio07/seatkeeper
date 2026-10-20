import type { CheckoutSession } from '@seatkeeper/shared';

export interface SessionStore {
  create(session: CheckoutSession): Promise<CheckoutSession>;
  get(id: string): Promise<CheckoutSession | null>;
  /**
   * Optimistic write: succeeds only if the stored version still equals
   * `expectedVersion`. The store — not the caller — bumps the version, so
   * there is exactly one place that increments it.
   * Returns the stored session on success, null on conflict / missing.
   * Production equivalent: UPDATE ... SET ..., version = version + 1
   *                        WHERE id = $1 AND version = $2
   */
  compareAndSet(
    id: string,
    expectedVersion: number,
    next: CheckoutSession,
  ): Promise<CheckoutSession | null>;
}

export class InMemorySessionStore implements SessionStore {
  private sessions = new Map<string, CheckoutSession>();

  async create(session: CheckoutSession): Promise<CheckoutSession> {
    if (this.sessions.has(session.id)) {
      throw new Error(`Session ${session.id} already exists`);
    }
    // Clone on the way in AND out: callers never hold a reference to stored
    // state, so nobody can mutate a session without going through CAS.
    this.sessions.set(session.id, structuredClone(session));
    return structuredClone(session);
  }

  async get(id: string): Promise<CheckoutSession | null> {
    const session = this.sessions.get(id);
    return session ? structuredClone(session) : null;
  }

  async compareAndSet(
    id: string,
    expectedVersion: number,
    next: CheckoutSession,
  ): Promise<CheckoutSession | null> {
    // No `await` between the read and the write below, so in single-threaded
    // Node this check-then-set is atomic with respect to other requests.
    const current = this.sessions.get(id);
    if (!current || current.version !== expectedVersion) return null;

    const stored = structuredClone({ ...next, id, version: expectedVersion + 1 });
    this.sessions.set(id, stored);
    return structuredClone(stored);
  }
}
