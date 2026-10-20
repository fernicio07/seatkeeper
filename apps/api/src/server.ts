import { buildApp } from './app';
import { InMemorySessionStore } from './store/session-store';
import {
  InMemoryAnalyticsSink,
  OffsetClock,
  StubInventoryService,
  StubPaymentGateway,
} from './services/stubs';

// API_PORT, not PORT: tools (and Next) commonly set PORT for the whole process
// tree, which would silently put the API on the web app's port.
const PORT = Number(process.env.API_PORT ?? 4000);
const TTL_MS = Number(process.env.CHECKOUT_TTL_MS ?? 5 * 60 * 1000);
const DEV = process.env.NODE_ENV !== 'production';

const clock = new OffsetClock();
const inventory = new StubInventoryService(clock);
const payments = new StubPaymentGateway();

const app = buildApp(
  {
    store: new InMemorySessionStore(),
    inventory,
    payments,
    analytics: new InMemoryAnalyticsSink(true),
    clock,
    ttlMs: TTL_MS,
  },
  { dev: DEV ? { inventory, payments, clock } : undefined, logger: true },
);

app.listen({ port: PORT, host: '127.0.0.1' }).catch((err) => {
  app.log.error(err);
  process.exit(1);
});
