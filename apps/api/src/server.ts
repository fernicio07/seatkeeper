import { buildApp } from './app';
import { InMemorySessionStore } from './store/session-store';
import {
  InMemoryAnalyticsSink,
  OffsetClock,
  StubInventoryService,
  StubPaymentGateway,
} from './services/stubs';

const PORT = Number(process.env.PORT ?? 4000);
const TTL_MS = Number(process.env.CHECKOUT_TTL_MS ?? 5 * 60 * 1000);
const DEV = process.env.NODE_ENV !== 'production';

const inventory = new StubInventoryService();
const payments = new StubPaymentGateway();
const clock = new OffsetClock();

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
