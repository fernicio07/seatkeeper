import { buildApp } from '../app';
import { InMemorySessionStore } from '../store/session-store';
import {
  InMemoryAnalyticsSink,
  StubClock,
  StubInventoryService,
  StubPaymentGateway,
} from '../services/stubs';
import { T0, TTL_MS } from './factories';
import type { PaymentGateway } from '../services/interfaces';

/** Fully wired app with controllable stubs exposed for assertions.
 *  `payments` swaps the gateway the service uses (dev routes keep the stub). */
export function buildTestApp(opts: { payments?: PaymentGateway } = {}) {
  const clock = new StubClock(T0);
  const inventory = new StubInventoryService(clock);
  const payments = new StubPaymentGateway();
  const analytics = new InMemoryAnalyticsSink();
  const app = buildApp(
    { store: new InMemorySessionStore(), inventory, payments: opts.payments ?? payments, analytics, clock, ttlMs: TTL_MS },
    { dev: { inventory, payments, clock } },
  );
  return { app, inventory, payments, analytics, clock };
}
