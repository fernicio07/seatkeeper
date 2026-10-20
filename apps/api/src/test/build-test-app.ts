import { buildApp } from '../app';
import { InMemorySessionStore } from '../store/session-store';
import {
  InMemoryAnalyticsSink,
  StubClock,
  StubInventoryService,
  StubPaymentGateway,
} from '../services/stubs';
import { T0, TTL_MS } from './factories';

/** Fully wired app with controllable stubs exposed for assertions. */
export function buildTestApp() {
  const inventory = new StubInventoryService();
  const payments = new StubPaymentGateway();
  const analytics = new InMemoryAnalyticsSink();
  const clock = new StubClock(T0);
  const app = buildApp(
    { store: new InMemorySessionStore(), inventory, payments, analytics, clock, ttlMs: TTL_MS },
    { dev: { inventory, payments, clock } },
  );
  return { app, inventory, payments, analytics, clock };
}
